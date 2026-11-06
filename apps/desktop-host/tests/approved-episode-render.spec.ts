/** Configured provider captures actual owner modules, runtime files and immutable project policy. */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createConfiguredEpisodeRenderer } from '../src/approved-episode-render.ts'
import type { ConfiguredEpisodeRenderer, EpisodeRendererLimits } from '../src/approved-episode-render.ts'
import { inspectEpisodeFile } from '../src/episode-render-inputs.ts'
import { episodeFactsHash } from '../src/episode-render-descriptor.ts'
import type { ApprovedEpisodeCaptureInput } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'

const roots: string[] = [], providers: ConfiguredEpisodeRenderer[] = []
afterEach(async () => {
  await Promise.all(providers.splice(0).map(provider => provider.dispose()))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})
const limits: EpisodeRendererLimits = { requestBytes: 4096, replyBytes: 8192, descriptorBytes: 131072, journalBytes: 131072,
  lockWaitMs: 1000, mediaGraceMs: 100, mediaStdoutBytes: 65536, mediaStderrBytes: 65536, diagnosticBytes: 4096, runtimeEntries: 100 }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-configured-renderer-'))); roots.push(root)
  for (const name of ['code', 'fonts', 'media', 'editing']) await mkdir(join(root, name))
  const index = join(root, 'code', 'index.js'), sibling = join(root, 'code', 'render.js')
  const font = join(root, 'fonts', 'captured.ttf'), ffmpeg = join(root, 'media', 'ffmpeg'), ffprobe = join(root, 'media', 'ffprobe')
  await Promise.all([[index, 'export {}\n'], [sibling, 'export const version = 1\n'], [font, 'fontbytes'], [ffmpeg, 'encoderbytes'],
    [ffprobe, 'probebytes'], [join(root, 'project_config.json'), '{"project_bible":{"visual_medium":"animation_3d"}}'],
    [join(root, 'editing', '01-episode-delivery.json'), '{"schema_version":1,"episode":1}'],
    [join(root, 'editing', '01-timeline.json'), JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }], body_end: 1,
      delivery: { width: 1920, height: 1080, fps: 30, visual_medium: 'animation_3d' } })],
    [join(root, 'editing', '01.srt'), '1\n00:00:00,000 --> 00:00:01,000\n台词\n'],
    [join(root, 'editing', 'mix.json'), '{"schema_version":1,"mode":"no_bgm","analysis_window_ms":50}']]
    .map(async ([path, bytes]) => { if (path === undefined || bytes === undefined) throw new Error('invalid fixture row'); await writeFile(path, bytes) }))
  const signal = new AbortController().signal
  const inputHashes = await Promise.all([
    ['project', join(root, 'project_config.json')], ['plan', join(root, 'editing', '01-episode-delivery.json')],
    ['timeline', join(root, 'editing', '01-timeline.json')], ['subtitle', join(root, 'editing', '01.srt')], ['mix-profile', join(root, 'editing', 'mix.json')],
  ].map(async ([role, path]): Promise<ApprovedEpisodeCaptureInput['inputHashes'][number]> => {
    if (path === undefined) throw new Error('invalid fixture path')
    const file = await inspectEpisodeFile(path, signal)
    if (role !== 'project' && role !== 'plan' && role !== 'timeline' && role !== 'subtitle' && role !== 'mix-profile') throw new Error('invalid fixture role')
    return { ...file, role }
  }))
  const input: ApprovedEpisodeCaptureInput = { projectDir: root, episode: 1, planPath: join(root, 'editing', '01-episode-delivery.json'),
    timelinePath: join(root, 'editing', '01-timeline.json'), subtitlePath: join(root, 'editing', '01.srt'), mixProfilePath: join(root, 'editing', 'mix.json'),
    inputHashes, digest: episodeFactsHash(inputHashes) }
  let declarationChanged = false
  const create = async () => {
    const provider = await createConfiguredEpisodeRenderer({ rendererConfig: { ffmpegPath: ffmpeg, ffprobePath: ffprobe,
      fontsDir: join(root, 'fonts'), subtitleFontFamily: 'Captured', watermarkFontFamily: 'Captured', maxBgmVolume: 1,
      normalizeSubtitleText: true, enforceSubtitleVisual: true, defaultSubtitleVisual: {
        schema_version: 1, reference_width: 480, reference_height: 854, font_size_px: 46, outline_px: 1.25,
        center_y_ratio: 0.736747073, max_width_ratio: 0.9 } },
    carrier: { kind: 'source-fixture', executable: process.execPath,
      cli: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)), tsxEsm: import.meta.resolve('tsx/esm'),
      tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), subprocessEntry: index, workerEntry: index },
    codeFiles: [index], endingAssetRoot: root, limits, resolveExecutable: async command => command,
    verifyConfiguration: async () => { if (declarationChanged) throw new Error('captured declaration changed') } }, signal)
    providers.push(provider); return provider
  }
  return { root, sibling, font, ffmpeg, input, signal, create, changeDeclaration: () => { declarationChanged = true } }
}

it('captures sibling code modules, actual media and fonts while retaining deployment policy', async () => {
  const f = await fixture(), provider = await f.create(), capture = await provider.capture(f.input, f.signal)
  expect(capture.runtimeInputs).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: f.sibling, owner: 'renderer' }), expect.objectContaining({ path: f.font, owner: 'font' }),
    expect.objectContaining({ path: f.ffmpeg, owner: 'media' }),
  ]))
  expect(capture.identity.configurationSha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(capture.identity.codeSha256).toMatch(/^[a-f0-9]{64}$/u)
})

it('refuses a changed non-index owner module; a fresh provider reports different code/configuration facts', async () => {
  const f = await fixture(), provider = await f.create(), original = await provider.capture(f.input, f.signal)
  await writeFile(f.sibling, 'export const version = 2\n')
  await expect(provider.capture(f.input, f.signal)).rejects.toThrow('captured file changed')
  const current = await (await f.create()).capture(f.input, f.signal)
  expect(current.identity.codeSha256).not.toBe(original.identity.codeSha256)
  expect(current.identity.configurationSha256).not.toBe(original.identity.configurationSha256)
})

it('captures changed font bytes as a different configuration without changing the code identity', async () => {
  const f = await fixture(), provider = await f.create(), original = await provider.capture(f.input, f.signal)
  await writeFile(f.font, 'replacement fontbytes')
  const current = await provider.capture(f.input, f.signal)
  expect(current.identity.codeSha256).toBe(original.identity.codeSha256)
  expect(current.identity.configurationSha256).not.toBe(original.identity.configurationSha256)
})

it('refuses project-input drift and a replaced actual preset declaration', async () => {
  const f = await fixture(), provider = await f.create()
  await writeFile(f.input.subtitlePath, 'changed')
  await expect(provider.capture(f.input, f.signal)).rejects.toThrow('captured file changed')
  f.changeDeclaration()
  await expect(provider.capture(f.input, f.signal)).rejects.toThrow('declaration changed')
})

it('retires existing captures and refuses new captures synchronously when its provider is disposed', async () => {
  const f = await fixture(), provider = await f.create(), captured = await provider.capture(f.input, f.signal)
  const disposal = provider.dispose()
  expect(captured.signal.aborted).toBe(true)
  await expect(provider.capture(f.input, f.signal)).rejects.toThrow('closing')
  await disposal
})
