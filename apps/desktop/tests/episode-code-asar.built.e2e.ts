/** Packaged renderer code retains physical archive and unpacked-file identities in Electron. */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { WriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions } = builderRequire('@electron/asar') as {
  createPackageWithOptions: (source: string, destination: string, options: { unpack: string }) => Promise<WriteStream>
}

it.skipIf(!['win32', 'darwin'].includes(process.platform) || process.env.DSH_EXAMPLE_MODE !== 'lib')(
  'captures packaged renderer code and rejects changed or missing installation files', { retry: 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-episode-code-asar-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const source = join(root, 'source'), archive = join(root, 'app.asar')
    await mkdir(join(source, 'code'), { recursive: true })
    await writeFile(join(source, 'code/index.js'), 'export const packed = true\n')
    await writeFile(join(source, 'code/second.js'), 'export const sibling = true\n')
    await writeFile(join(source, 'code/native.js'), 'export const unpacked = true\n')
    await finished(await createPackageWithOptions(source, archive, { unpack: '**/native.js' }), { cleanup: true })
    const entry = join(root, 'probe.mjs')
    await writeFile(entry, String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [module, requestedRoot] = process.argv.slice(2);
const physicalFs = createRequire(import.meta.url)('original-fs').promises;
const { createConfiguredEpisodeRenderer } = await import(pathToFileURL(module));
const root = await realpath(requestedRoot), archive = join(root, 'app.asar');
const native = join(root, 'app.asar.unpacked/code/native.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const name of ['fonts', 'media', 'editing']) await mkdir(join(root, name));
const ffmpeg = join(root, 'media/ffmpeg'), ffprobe = join(root, 'media/ffprobe');
const project = join(root, 'project_config.json'), plan = join(root, 'editing/01-episode-delivery.json');
const timeline = join(root, 'editing/01-timeline.json'), subtitle = join(root, 'editing/01.srt'), mix = join(root, 'editing/mix.json');
for (const [path, text] of [
  [ffmpeg, 'encoder'], [ffprobe, 'probe'], [join(root, 'fonts/captured.ttf'), 'font'],
  [project, '{"project_bible":{"visual_medium":"animation_3d"}}'], [plan, '{"schema_version":1,"episode":1}'],
  [timeline, JSON.stringify({clips:[{shot:1,start_us:0,duration_us:1000000}],body_end:1,
    delivery:{width:1920,height:1080,fps:30,visual_medium:'animation_3d'}})],
  [subtitle, '1\n00:00:00,000 --> 00:00:01,000\n台词\n'],
  [mix, '{"schema_version":1,"mode":"no_bgm","analysis_window_ms":50}'],
]) await writeFile(path, text);
const inputHashes = await Promise.all([['project',project],['plan',plan],['timeline',timeline],['subtitle',subtitle],['mix-profile',mix]]
  .map(async ([role,path]) => { const bytes=await readFile(path); return {role,path,bytes:bytes.length,sha256:digest(bytes)}; }));
const signal = new AbortController().signal;
const input = {projectDir:root,episode:1,planPath:plan,timelinePath:timeline,subtitlePath:subtitle,mixProfilePath:mix,
  inputHashes,digest:digest(JSON.stringify(inputHashes))};
const options = {
  rendererConfig:{ffmpegPath:ffmpeg,ffprobePath:ffprobe,fontsDir:join(root,'fonts'),subtitleFontFamily:'Captured',
    watermarkFontFamily:'Captured',maxBgmVolume:1,normalizeSubtitleText:true,enforceSubtitleVisual:true,
    defaultSubtitleVisual:{schema_version:1,reference_width:480,reference_height:854,font_size_px:46,
      outline_px:1.25,center_y_ratio:0.736747073,max_width_ratio:0.9}},
  carrier:{kind:'source-fixture',executable:process.execPath,cli:module,tsxEsm:module,tsconfig:module,
    subprocessEntry:module,workerEntry:module},
  codeFiles:[join(archive,'code/index.js'),join(archive,'code/native.js')],endingAssetRoot:root,
  limits:{requestBytes:4096,replyBytes:8192,descriptorBytes:131072,journalBytes:131072,lockWaitMs:1000,
    mediaGraceMs:100,mediaStdoutBytes:65536,mediaStderrBytes:65536,diagnosticBytes:4096,runtimeEntries:100},
  resolveExecutable:async command=>command,verifyConfiguration:async()=>{},
};
const originalArchive = await physicalFs.readFile(archive), originalNative = await readFile(native);
const provider = await createConfiguredEpisodeRenderer(options, signal);
try {
  const captured = await provider.capture(input, signal);
  assert.deepEqual(captured.runtimeInputs.filter(file=>file.owner==='renderer').map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes})),
    [{path:archive,sha256:digest(originalArchive),bytes:originalArchive.length},
     {path:native,sha256:digest(originalNative),bytes:originalNative.length}].sort((a,b)=>a.path.localeCompare(b.path)));
  await writeFile(native, 'changed installation code\n');
  await assert.rejects(captured.revalidate(signal), /captured file changed/);
  await writeFile(native, originalNative);
  await physicalFs.writeFile(archive, Buffer.concat([originalArchive,Buffer.from('changed archive')]));
  await assert.rejects(captured.revalidate(signal), /captured file changed/);
  await physicalFs.writeFile(archive, originalArchive);
} finally { await provider.dispose(); }
const aborted = new AbortController();
aborted.abort(new Error('archive capture cancelled'));
await assert.rejects(createConfiguredEpisodeRenderer(options,aborted.signal), /archive capture cancelled/);
await rm(native);
await assert.rejects(createConfiguredEpisodeRenderer(options,signal), /ENOENT/);
await writeFile(native, originalNative);
const codeDirectory = join(root, 'app.asar.unpacked/code'), moved = join(root, 'moved-code');
await rename(codeDirectory, moved);
await symlink(moved, codeDirectory, process.platform === 'win32' ? 'junction' : 'dir');
await assert.rejects(createConfiguredEpisodeRenderer(options,signal), /canonical regular file/);
process.stdout.write('EPISODE_CODE_ASAR_OK');
`)
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(?:MUSE_|DSH_|DEEPSEEK_|OPENAI_)/u.test(key)))
    const result = spawnSync(require('electron') as string, [entry,
      fileURLToPath(new URL('../../desktop-host/lib/approved-episode-render.js', import.meta.url)), root], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', TEMP: root, TMP: root },
      encoding: 'utf8', timeout: 60_000, windowsHide: true,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('EPISODE_CODE_ASAR_OK')
  },
)
