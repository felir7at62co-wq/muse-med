/** Private synthetic staging checks; no actual build, release, upload or public network requests. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMuseMirrorPlan, recordMuseUnsignedBuild } from '../../apps/desktop/scripts/muse-release-mirror.mjs'

const root = await mkdtemp(join(import.meta.dirname, '.staging-synthetic-test-'))
const commit = 'f'.repeat(40)
const stageScript = join(import.meta.dirname, 'stage-muse-1.0.3.mjs')
const readbackScript = join(import.meta.dirname, 'verify-muse-1.0.3-readback.mjs')
const output = join(root, 'publication')
const originals = {}
const directories = {}
try {
  for (const target of ['mac-arm64', 'win-x64']) {
    const directory = join(root, target)
    directories[target] = directory
    await mkdir(directory)
    const base = `muse-med-1.0.3-${target === 'mac-arm64' ? 'mac-arm64' : 'win-x64'}`
    const names = target === 'mac-arm64' ? [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`]
      : [`${base}.exe`, `${base}.exe.blockmap`]
    for (const name of names) await writeFile(join(directory, name), `synthetic-only:${target}:${name}\n`)
    const updateBinary = target === 'mac-arm64' ? `${base}.zip` : `${base}.exe`
    const bytes = await readFile(join(directory, updateBinary))
    const sha512 = createHash('sha512').update(bytes).digest('base64')
    const metadata = `version: 1.0.3\nfiles:\n  - url: ${updateBinary}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${updateBinary}\nsha512: ${sha512}\nreleaseDate: '2026-10-07T00:00:00.000Z'\n`
    await writeFile(join(directory, target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml'), metadata)
    await recordMuseUnsignedBuild({ target, version: '1.0.3', sourceCommit: commit, artifactsRoot: directory })
    originals[target] = await readFile(join(directory, 'unsigned-build.json'))
  }
  const args = ['--commit', commit, '--mac-arm64', directories['mac-arm64'], '--win-x64', directories['win-x64'], '--output', output]
  const result = JSON.parse(execFileSync(process.execPath, [stageScript, ...args], { encoding: 'utf8' }))
  assert.equal(result.stage, 'staged-locally')
  assert.equal((await readdir(output)).length, 11)
  for (const target of Object.keys(directories)) assert.deepEqual(await readFile(join(directories[target], 'unsigned-build.json')), originals[target])
  assert.throws(() => execFileSync(process.execPath, [stageScript, ...args], { stdio: 'pipe' }))
  const inventory = JSON.parse(await readFile(`${output}.inventory.json`, 'utf8'))
  for (const file of inventory.files) {
    const bytes = await readFile(join(output, file.filename))
    assert.equal(bytes.length, file.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
  }
  const mirror = await createMuseMirrorPlan({ version: '1.0.3', sourceCommit: commit,
    artifactDirectories: directories, legacyRcDiscovery: true })
  const bodies = Object.fromEntries(await Promise.all(inventory.files.map(async file => [file.filename,
    (await readFile(join(output, file.filename))).toString('base64')])))
  const fakeNetwork = join(root, 'fake-public-network.mjs')
  await writeFile(fakeNetwork, `const inventory=${JSON.stringify(inventory)};
const bodies=${JSON.stringify(bodies)};
const feeds=${JSON.stringify(Object.fromEntries(mirror.metadata.map(file => [file.key, Buffer.from(file.contents).toString('base64')])))};
globalThis.fetch=async value=>{
  const url=new URL(value), tag=url.pathname.includes('rc.muse-stable')?'v1.0.3-rc.muse-stable':'v1.0.3';
  if(url.pathname.endsWith('/releases.atom')) return new Response('<feed><entry><link href="https://github.com/felir7at62co-wq/muse-med/releases/tag/'+(process.env.MUSE_STAGING_SYNTHETIC_WRONG_ATOM==='1'?'hongguo-source-runtime-fixture':'v1.0.3-rc.muse-stable')+'"/></entry></feed>');
  if(url.hostname==='api.github.com') {
    if(url.pathname.includes('/git/ref/')) return Response.json({object:{type:'commit',sha:inventory.sourceCommit}});
    return Response.json({tag_name:tag,draft:false,prerelease:tag!=='v1.0.3',assets:inventory.files.map(file=>({name:file.filename,size:file.size,state:'uploaded',digest:'sha256:'+file.sha256}))});
  }
  const filename=decodeURIComponent(url.pathname.split('/').at(-1));
  let body=url.pathname.includes('/feeds/')?feeds[url.pathname.slice(1)]:bodies[filename];
  if(body===undefined) throw new Error('Unexpected synthetic request');
  let bytes=Buffer.from(body,'base64');
  if(process.env.MUSE_STAGING_SYNTHETIC_BAD==='1') bytes=bytes.subarray(0,bytes.length-1);
  return new Response(bytes,{status:200});
};\n`)
  const readback = ['--import', fakeNetwork, readbackScript, '--inventory', `${output}.inventory.json`]
  for (const tag of ['v1.0.3', 'v1.0.3-rc.muse-stable']) {
    const lines = execFileSync(process.execPath, [...readback, '--github-tag', tag, '--tos'], { encoding: 'utf8' }).trim().split('\n')
    assert.equal(JSON.parse(lines.at(-1)).stage, 'public-readback-complete')
    assert.equal(lines.length, tag === 'v1.0.3' ? 21 : 22)
  }
  assert.throws(() => execFileSync(process.execPath, [...readback, '--github-tag', 'v1.0.3'], {
    stdio: 'pipe', env: { ...process.env, MUSE_STAGING_SYNTHETIC_BAD: '1' },
  }), error => error.stderr.toString().includes('SHA-256 mismatch'))
  assert.throws(() => execFileSync(process.execPath, [...readback, '--github-tag', 'v1.0.3-rc.muse-stable'], {
    stdio: 'pipe', env: { ...process.env, MUSE_STAGING_SYNTHETIC_WRONG_ATOM: '1' },
  }), error => error.stderr.toString().includes('first Atom entry'))
  await writeFile(join(directories['mac-arm64'], 'muse-med-1.0.3-mac-arm64.zip'), 'changed synthetic bytes')
  assert.throws(() => execFileSync(process.execPath, [stageScript, ...args.slice(0, -1), join(root, 'changed')], { stdio: 'pipe' }),
    error => error.stderr.toString().includes('changed after packaging verification'))
  await assert.rejects(readFile(join(root, 'changed', 'muse-desktop-builds.json')), { code: 'ENOENT' })
  assert.throws(() => execFileSync(process.execPath, [stageScript, '--commit', 'a'.repeat(40),
    '--mac-arm64', directories['mac-arm64'], '--win-x64', directories['win-x64'], '--output', join(root, 'mixed')], { stdio: 'pipe' }),
    error => error.stderr.toString().includes('belongs to another build'))
  console.log('PASS: synthetic 11-file staging, original-record preservation, no-clobber, changed-byte rejection, both-tag/full-TOS readback and corrupt-public-byte rejection. No public requests made.')
} finally { await rm(root, { recursive: true, force: true }) }
