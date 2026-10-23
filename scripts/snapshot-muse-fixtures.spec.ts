import { execFile, type ChildProcess } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

const { stageSourceMusePlugins } = layoutModule as {
  stageSourceMusePlugins: (sourceRoot: string, nodeModules: string) => Promise<void>
}

const { projectSubtitleFixtureReport } = reportModule as {
  projectSubtitleFixtureReport: (report: DramaRenderReport, cwd: string) => Promise<DramaRenderReport>
}
const runFile = promisify(execFile)

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
  return {
    root,
    dispose,
    startNode(args: string[]) {
      controller.signal.throwIfAborted()
      const result = runFile(process.execPath, args,
        { cwd: root, timeout: 30000, windowsHide: true, signal: controller.signal })
      const closed = new Promise<void>(resolve => result.child.once('close', () => { resolve() }))
      children.add(closed)
      void closed.then(() => { children.delete(closed) })
      const collected = (async () => {
        try { return await result }
        finally { await closed }
      })()
      return { child: result.child, result: collected }
    },
  }
}

it('loads the real peer dependency from the installed fixture owner instead of the source symlink', async () => {
  const fixture = await workspace()
  const { root } = fixture
  const source = join(root, 'source')
  const nodeModules = join(root, 'installed', 'node_modules')
  const dependency = join(nodeModules, '@deepseek-ai', 'dsh-atomic-write')
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-atomic-write', type: 'module', exports: './index.js' }))
  await writeFile(join(dependency, 'index.js'), 'export const fixtureDependency = "installed-peer"\n')
  for (const plugin of ['muse-hongguo-search', 'muse-hongguo-download', 'muse-douyin-download', 'muse-reverse-tools', 'muse-fanqie-download']) {
    const directory = join(source, plugin)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: plugin, type: 'module', exports: './index.js' }))
    await writeFile(join(directory, 'index.js'), 'export { fixtureDependency } from "@deepseek-ai/dsh-atomic-write"\n')
  }
  const original = join(source, 'muse-hongguo-download')
  const linked = join(root, 'old-source-link')
  await symlink(original, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const importPlugin = (directory: string) => fixture.startNode(['--input-type=module', '--eval',
    `import { fixtureDependency } from ${JSON.stringify(pathToFileURL(join(directory, 'index.js')).href)}; process.stdout.write(fixtureDependency)`]).result
  await expect(importPlugin(linked)).rejects.toThrow('@deepseek-ai/dsh-atomic-write')

  await stageSourceMusePlugins(source, nodeModules)
  const installed = join(nodeModules, 'muse-hongguo-download')
  expect(await realpath(installed)).not.toBe(await realpath(original))
  expect(await readFile(join(installed, 'index.js'), 'utf8')).toBe(await readFile(join(original, 'index.js'), 'utf8'))
  expect(createRequire(join(installed, 'package.json')).resolve('@deepseek-ai/dsh-atomic-write'))
    .toBe(await realpath(join(dependency, 'index.js')))
  expect(await importPlugin(installed)).toMatchObject({ stdout: 'installed-peer', stderr: '' })
  expect(await realpath(join(nodeModules, 'muse-hongguo-search'))).toBe(await realpath(join(source, 'muse-hongguo-search')))
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
