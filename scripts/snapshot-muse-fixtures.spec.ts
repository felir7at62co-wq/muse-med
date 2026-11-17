import { execFile, type ChildProcess } from 'node:child_process'
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { resolveSettings, runDramaRender } from '../packages/drama/tool-episode-render/src/index.ts'
import type { DramaRenderReport } from '../packages/drama/tool-episode-render/src/types.ts'
import { probeHandler, stubChannel } from '../packages/drama/tool-episode-render/tests/harness.ts'

// These runtime fixtures are loaded by cordis.yml and ship no TypeScript declarations.
// @ts-expect-error The fixture intentionally has no declaration artifact.
import * as layoutModule from '../snapshots/session/muse-editing-tool-catalog/source-plugin-layout.mjs'
// @ts-expect-error The fixture intentionally has no declaration artifact.
import * as reportModule from '../snapshots/session/drama-subtitle-timing/report-fixture.mjs'
// @ts-expect-error The fixture intentionally has no declaration artifact.
import * as draftSeedModule from '../snapshots/session/muse-jianying-draft/draft-seed.mjs'

const { stageSourceMusePlugins } = layoutModule as {
  stageSourceMusePlugins: (sourceRoot: string, nodeModules: string) => Promise<void>
}

const { projectSubtitleFixtureReport } = reportModule as {
  projectSubtitleFixtureReport: (report: DramaRenderReport, cwd: string) => Promise<DramaRenderReport>
}
const { consumeDraftSeed } = draftSeedModule as { consumeDraftSeed: (workspace: string) => Promise<void> }
const runFile = promisify(execFile)
const sourcePluginNames = ['muse-hongguo-search', 'muse-hongguo-download', 'muse-douyin-download', 'muse-reverse-tools',
  'muse-fanqie-download', 'muse-qimao-data', 'muse-source-research', 'muse-lvpaopao']

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-muse-fixture-'))
  const controller = new AbortController()
  const children = new Set<Promise<void>>()
  let disposal: Promise<void> | undefined
  const dispose = () => disposal ??= (async () => {
    controller.abort(new Error('Fixture cleanup cancelled its child processes'))
    await Promise.all(children)
    await rm(root, { recursive: true, force: true })
  })()
  onTestFinished(dispose)
  const startFile = (file: string, args: string[]) => {
    controller.signal.throwIfAborted()
    const result = runFile(file, args,
      { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true, signal: controller.signal })
    const closed = new Promise<void>(resolve => result.child.once('close', () => { resolve() }))
    children.add(closed)
    void closed.then(() => { children.delete(closed) })
    const collected = (async () => {
      try { return await result }
      finally { await closed }
    })()
    return { child: result.child, result: collected }
  }
  return {
    root,
    dispose,
    startFile,
    startNode: (args: string[]) => startFile(process.execPath, args),
  }
}

it('consumes the committed empty draft-directory seed without changing its request', async () => {
  const fixture = await workspace()
  const seed = new URL('../snapshots/session/muse-jianying-draft/workspace/', import.meta.url)
  const request = await readFile(new URL('request.json', seed))
  await cp(seed, fixture.root, { recursive: true })
  expect(await readdir(join(fixture.root, 'drafts'))).toEqual(['.keep'])
  await consumeDraftSeed(fixture.root)
  expect(await readdir(join(fixture.root, 'drafts'))).toEqual([])
  expect(await readFile(join(fixture.root, 'request.json'))).toEqual(request)
  expect(await readFile(new URL('drafts/.keep', seed), 'utf8')).toBe('')
})

it('rejects missing or nonempty draft-directory seed markers without discarding their contents', async () => {
  const fixture = await workspace(), directory = join(fixture.root, 'drafts')
  await mkdir(directory)
  await expect(consumeDraftSeed(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
  const marker = join(directory, '.keep')
  await writeFile(marker, 'unexpected seed contents')
  await expect(consumeDraftSeed(fixture.root)).rejects.toThrow('Expected the empty draft-directory seed marker')
  expect(await readFile(marker, 'utf8')).toBe('unexpected seed contents')
})

it('loads the real peer dependency from the installed fixture owner instead of the source symlink', async () => {
  const fixture = await workspace()
  const { root } = fixture
  const source = join(root, 'source')
  const nodeModules = join(root, 'installed', 'node_modules')
  const dependency = join(nodeModules, '@deepseek-ai', 'dsh-atomic-write')
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-atomic-write', type: 'module', exports: './index.js' }))
  await writeFile(join(dependency, 'index.js'), 'export const fixtureDependency = "installed-peer"\n')
  for (const plugin of sourcePluginNames) {
    const directory = join(source, plugin)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: plugin, type: 'module',
      exports: plugin === 'muse-lvpaopao' ? { '.': { default: './lib/index.js' } }
        : plugin === 'muse-qimao-data' || plugin === 'muse-hongguo-search' ? { '.': './index.js', './client': './index.js' } : './index.js' }))
    await writeFile(join(directory, 'index.js'), plugin === 'muse-source-research'
      ? 'import { fixtureDependency as qimao } from "muse-qimao-data/client"; import { fixtureDependency as hongguo } from "muse-hongguo-search/client"; if (qimao !== hongguo) throw Error("client owner mismatch"); export const fixtureDependency = qimao\n'
      : 'export { fixtureDependency } from "@deepseek-ai/dsh-atomic-write"\n')
    if (plugin === 'muse-lvpaopao') {
      await mkdir(join(directory, 'src'))
      await writeFile(join(directory, 'src', 'index.ts'), 'export { fixtureDependency } from "@deepseek-ai/dsh-atomic-write"\n')
    }
  }
  const original = join(source, 'muse-hongguo-download')
  const linked = join(root, 'old-source-link')
  await symlink(original, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const importPlugin = (directory: string) => fixture.startNode(['--input-type=module', '--eval',
    `import { fixtureDependency } from ${JSON.stringify(pathToFileURL(join(directory, 'index.js')).href)}; process.stdout.write(fixtureDependency)`]).result
  await expect(importPlugin(linked)).rejects.toThrow('@deepseek-ai/dsh-atomic-write')
  const foreignPeer = join(original, 'node_modules', '@deepseek-ai', 'dsh-atomic-write')
  await mkdir(foreignPeer, { recursive: true })
  await writeFile(join(foreignPeer, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
  await writeFile(join(foreignPeer, 'index.js'), 'export const fixtureDependency = "foreign-peer"\n')

  await stageSourceMusePlugins(source, nodeModules)
  const installed = join(nodeModules, 'muse-hongguo-download')
  await expect(access(join(installed, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await realpath(installed)).not.toBe(await realpath(original))
  expect(await readFile(join(installed, 'index.js'), 'utf8')).toBe(await readFile(join(original, 'index.js'), 'utf8'))
  expect(await realpath(createRequire(join(installed, 'package.json')).resolve('@deepseek-ai/dsh-atomic-write')))
    .toBe(await realpath(join(dependency, 'index.js')))
  expect(await importPlugin(installed)).toMatchObject({ stdout: 'installed-peer', stderr: '' })
  const qimaoInstalled = join(nodeModules, 'muse-qimao-data')
  expect(await realpath(qimaoInstalled)).not.toBe(await realpath(join(source, 'muse-qimao-data')))
  expect(await importPlugin(qimaoInstalled)).toMatchObject({ stdout: 'installed-peer', stderr: '' })
  const nativeInstalled = join(nodeModules, 'muse-lvpaopao')
  expect(await realpath(nativeInstalled)).not.toBe(await realpath(join(source, 'muse-lvpaopao')))
  const nativeManifest = JSON.parse(await readFile(join(nativeInstalled, 'package.json'), 'utf8')) as {
    exports: { '.': { default: string } }
  }
  expect(nativeManifest.exports['.'].default).toBe(process.env.DSH_EXAMPLE_MODE === 'lib' ? './lib/index.js' : './src/index.ts')
  const hongguoInstalled = join(nodeModules, 'muse-hongguo-search')
  expect(await realpath(hongguoInstalled)).not.toBe(await realpath(join(source, 'muse-hongguo-search')))
  expect(await importPlugin(hongguoInstalled)).toMatchObject({ stdout: 'installed-peer', stderr: '' })
  const researchInstalled = join(nodeModules, 'muse-source-research')
  expect(await realpath(researchInstalled)).not.toBe(await realpath(join(source, 'muse-source-research')))
  expect(await importPlugin(researchInstalled)).toMatchObject({ stdout: 'installed-peer', stderr: '' })
  for (const client of ['muse-hongguo-search', 'muse-qimao-data']) {
    expect(await realpath(createRequire(join(researchInstalled, 'package.json')).resolve(`${client}/client`)))
      .toBe(await realpath(join(nodeModules, client, 'index.js')))
  }
})

it('keeps active source plugin artifacts out of Git and lint source discovery', async () => {
  const fixture = await workspace()
  const source = join(fixture.root, 'source'), installed = join(fixture.root, 'installed')
  const nodeModules = join(installed, 'node_modules')
  await mkdir(nodeModules, { recursive: true })
  await copyFile(new URL('../.gitignore', import.meta.url), join(installed, '.gitignore'))
  for (const plugin of sourcePluginNames) {
    const directory = join(source, plugin)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: plugin, type: 'module', exports: { '.': './index.js' } }))
    await writeFile(join(directory, 'index.js'), 'export const fixtureSource = true\n')
  }
  const invalidDeclaration = 'export declare const:;\n'
  await writeFile(join(source, 'muse-hongguo-download', 'generated.d.ts'), invalidDeclaration)
  await stageSourceMusePlugins(source, nodeModules)
  const staged = await realpath(join(nodeModules, 'muse-hongguo-download'))
  expect(staged.split(/[/\\]/)).not.toContain('node_modules')
  expect(await readFile(join(staged, 'generated.d.ts'), 'utf8')).toBe(invalidDeclaration)
  await writeFile(join(installed, 'control.ts'), 'export const fixtureControl = true\n')
  const git = (args: string[]) => fixture.startFile('git', ['-c', `safe.directory=${installed}`,
    '-c', 'core.excludesFile=', '-C', installed, ...args]).result
  await git(['init', '--quiet'])
  const sources = async () => (await git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean).sort()
  expect(await sources()).toEqual(['.gitignore', 'control.ts'])
  const config = join(fixture.root, 'scan.oxlintrc.json')
  await writeFile(config, JSON.stringify({ plugins: [], categories: { correctness: 'off' } }))
  const scan = () => fixture.startNode([fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url)),
    '--config', config, '--threads=1', '--format=json', installed]).result
  const clean = await scan()
  expect(JSON.parse(clean.stdout)).toMatchObject({ diagnostics: [] })
  expect(clean.stderr).toBe('')
  const oldLayout = join(installed, '.source-muse-plugins')
  await mkdir(oldLayout)
  await writeFile(join(oldLayout, 'legacy-source.ts'), invalidDeclaration)
  expect(await sources()).toContain('.source-muse-plugins/legacy-source.ts')
  const invalid = scan()
  await expect(invalid).rejects.toMatchObject({ code: 1 })
  await expect(invalid).rejects.toHaveProperty('stdout', expect.stringContaining('legacy-source.ts'))
})

it('resolves staged source peers through the source launcher without a second Cordis registry', async () => {
  const fixture = await workspace()
  const source = join(fixture.root, 'source'), nodeModules = join(fixture.root, 'installed', 'node_modules')
  const peer = join(nodeModules, '@deepseek-ai', 'cordis')
  await mkdir(peer, { recursive: true })
  await writeFile(join(peer, 'package.json'), JSON.stringify({ type: 'module', exports: './lib/index.js' }))
  await writeFile(join(fixture.root, 'tsconfig.json'), JSON.stringify({
    extends: fileURLToPath(new URL('../tsconfig.base.json', import.meta.url)),
  }))
  for (const plugin of sourcePluginNames) {
    const directory = join(source, plugin)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: plugin, type: 'module',
      exports: plugin === 'muse-lvpaopao' ? { '.': { default: './lib/index.js' } } : './index.js' }))
    await writeFile(join(directory, 'index.js'), 'export { Context } from "@deepseek-ai/cordis"\n')
    if (plugin === 'muse-lvpaopao') {
      await mkdir(join(directory, 'src'))
      await writeFile(join(directory, 'src', 'index.ts'), 'export { Context } from "@deepseek-ai/cordis"\n')
    }
  }
  await stageSourceMusePlugins(source, nodeModules)
  const staged = pathToFileURL(join(nodeModules, 'muse-source-research', 'index.js')).href
  const owner = new URL('../vendor/cordis/src/index.ts', import.meta.url).href
  const result = await fixture.startNode(['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval',
    `import { Context } from ${JSON.stringify(owner)}; import { Context as StagedContext } from ${JSON.stringify(staged)};
      if (Context !== StagedContext) throw new Error("Cordis registry split across source peers");
      const ctx = new Context(); if (!(ctx instanceof StagedContext)) throw new Error("Foreign service owner");
      process.stdout.write("one-source-registry");`]).result
  expect(result).toMatchObject({ stdout: 'one-source-registry', stderr: '' })
  await expect(access(join(peer, 'lib', 'index.js'))).rejects.toMatchObject({ code: 'ENOENT' })
})

function childReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout
    if (stdout === null) throw new Error('Fixture child must expose stdout')
    const cleanup = () => {
      stdout.off('data', ready)
      child.off('close', stopped)
    }
    const ready = () => { cleanup(); resolve() }
    const stopped = () => { cleanup(); reject(new Error('Fixture child stopped before readiness')) }
    stdout.once('data', ready)
    child.once('close', stopped)
  })
}

it('cancels and awaits live children before removing their workspaces without stopping another owner', async () => {
  const first = await workspace()
  const second = await workspace()
  expect(first.root).not.toBe(second.root)
  const args = ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)']
  const running = [first.startNode(args), second.startNode(args)]
  const results = running.map(({ result }) => result.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  ))
  await Promise.all(running.map(({ child }) => childReady(child)))
  const events: string[] = []
  running[0]!.child.once('close', () => { events.push('first child closed') })
  expect(running.map(({ child }) => [child.exitCode, child.signalCode])).toEqual([[null, null], [null, null]])

  await first.dispose()
  events.push('first workspace removed')
  expect(events).toEqual(['first child closed', 'first workspace removed'])
  await expect(access(first.root)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await results[0]).toMatchObject({ error: { name: 'AbortError', code: 'ABORT_ERR' } })
  expect(running[1]!.child.exitCode).toBeNull()
  expect(running[1]!.child.signalCode).toBeNull()
  await writeFile(join(second.root, 'still-owned.txt'), 'second owner remains usable')
  expect(await readFile(join(second.root, 'still-owned.txt'), 'utf8')).toBe('second owner remains usable')
  await expect(async () => first.startNode(['-e', 'process.exit(0)'])).rejects.toThrow('Fixture cleanup cancelled')

  await second.dispose()
  expect(await results[1]).toMatchObject({ error: { name: 'AbortError', code: 'ABORT_ERR' } })
  expect(running.every(({ child }) => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  await expect(access(second.root)).rejects.toMatchObject({ code: 'ENOENT' })
  await Promise.all([first.dispose(), second.dispose()])
})

async function subtitleReport(aligned = true): Promise<{ root: string; report: DramaRenderReport }> {
  const { root } = await workspace()
  for (const file of ['shots.json', 'lines.json', 'aligned.json', 'media.mp4']) {
    await copyFile(new URL(`../snapshots/session/drama-subtitle-timing/workspace/${file}`, import.meta.url), join(root, file))
  }
  if (!aligned) await writeFile(join(root, 'aligned.json'), JSON.stringify({ shots: [] }))
  const { channel } = stubChannel([probeHandler({ [join(root, 'media.mp4')]: { durationSeconds: 1.2, video: {}, audio: {} } })])
  const report = await runDramaRender({ method: 'subtitles', project: root, episode: 1,
    shots: 'shots.json', lines: 'lines.json', alignment: 'aligned.json', subtitleSrt: 'result.srt' },
  { ...resolveSettings({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }), channel })
  return { root, report }
}

it('retains the real review artifact, warning and all report fields while projecting paths', async () => {
  const { root, report } = await subtitleReport()
  const original = structuredClone(report)
  expect(report.checks).toEqual([])
  expect(await readFile(join(root, 'result.srt'), 'utf8')).toBe(await readFile(
    new URL('../snapshots/session/drama-subtitle-timing/workspace.expected/result.srt', import.meta.url), 'utf8'))
  expect(await projectSubtitleFixtureReport(report, root)).toEqual({ ...report,
    project: root.replaceAll('\\', '/'), clips: report.clips.map(clip => ({ ...clip, source: clip.source.replaceAll('\\', '/') })),
    written: report.written.map(path => path.replaceAll('\\', '/')) })
  expect(report).toEqual(original)
})

it('refuses a claimed review artifact that does not exist', async () => {
  const { root, report } = await subtitleReport()
  await rm(join(root, 'result.srt.review.txt'))
  await expect(projectSubtitleFixtureReport(report, root)).rejects.toThrow('ENOENT')
})

it('rejects the real candidate report when the alignment input is incomplete', async () => {
  const { root, report } = await subtitleReport(false)
  expect(report.checks).toEqual([expect.objectContaining({ id: 'subtitle_line_coverage', severity: 'warning', ok: false })])
  expect(await readFile(join(root, 'result.srt.review.txt'), 'utf8')).toContain('对齐文档里没有这一镜的时间')
  await expect(projectSubtitleFixtureReport(report, root)).rejects.toThrow('no subtitle check defects')
})

it('keeps rejecting a missing warning, failed alignment check or unexpected written file', async () => {
  const { root, report } = await subtitleReport()
  await expect(projectSubtitleFixtureReport({ ...report, warnings: [] }, root)).rejects.toThrow('legacy delivery warning')
  await expect(projectSubtitleFixtureReport({ ...report, checks: [
    { id: 'subtitle_timing', severity: 'warning', ok: false, detail: 'missing alignment', fix: 'review alignment' },
  ] }, root)).rejects.toThrow('no subtitle check defects')
  await expect(projectSubtitleFixtureReport({ ...report, written: [...report.written, join(root, 'unexpected.txt')] }, root))
    .rejects.toThrow('deep-equal')
})
