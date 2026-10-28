/** Explicit profiles, project ownership, and measured audio-level parsing. */

import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadAudioMixProfile, measureAudioLoudness, parseAudioWindows, requireNewAudioOutput,
  requireProjectAudioFile } from '../src/audio.ts'
import { audioMixFilter } from '../src/delivery.ts'
import type { ResolvedAudioMixProfile } from '../src/types.ts'

const roots: string[] = []
const links: string[] = []
afterEach(async () => {
  for (const link of links.splice(0)) await unlink(link)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-audio-profile-'))
  roots.push(directory)
  return directory
}
const settings = { masterVolume: 1.45, bgmVolume: 0.24 }
const ducking = { threshold_db: -30, ratio: 8, attack_ms: 20, release_ms: 200, knee: 2 }

it('keeps a profile from boosting an already attenuated BGM source above the deployment ceiling', async () => {
  const project = await root()
  const file = join(project, 'mix.json')
  await writeFile(file, JSON.stringify({ schema_version: 1, mode: 'legacy', analysis_window_ms: 100, music_gain: 8 }))
  expect(await loadAudioMixProfile(project, file, { ...settings, maxBgmVolume: 1 })).toMatchObject({ music_gain: 1 })
})

it('accepts a project directory alias while still resolving the owned audio and new output parent', async () => {
  const project = await root(), parent = await root()
  const alias = join(parent, 'project')
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(alias)
  const input = join(alias, 'input.wav')
  await writeFile(input, 'audio')
  expect(await requireProjectAudioFile(alias, input)).toBe(await realpath(input))
  expect(await requireProjectAudioFile(alias, await realpath(input))).toBe(await realpath(input))
  await expect(requireNewAudioOutput(alias, join(alias, 'nested', 'new.wav'))).resolves.toBeUndefined()
})

it('requires versioned explicit ducking parameters and captures deployment gains', async () => {
  const project = await root()
  const file = join(project, 'mix.json')
  await writeFile(file, JSON.stringify({ schema_version: 1, mode: 'ducking', analysis_window_ms: 100, ducking }))
  const profile = await loadAudioMixProfile(project, file, settings)
  expect(profile).toMatchObject({ schema_version: 1, mode: 'ducking', original_gain: 1.45, music_gain: 0.24, ducking })
  await writeFile(file, JSON.stringify({ schema_version: 1, mode: 'ducking', analysis_window_ms: 100 }))
  await expect(loadAudioMixProfile(project, file, settings)).rejects.toThrow('必须显式')
  for (const bad of [{ schema_version: 2, mode: 'no_bgm', analysis_window_ms: 100 },
    { schema_version: 1, mode: 'no_bgm', analysis_window_ms: 1001 },
    { schema_version: 1, mode: 'legacy', analysis_window_ms: 100, music_gain: 9 }]) {
    await writeFile(file, JSON.stringify(bad))
    await expect(loadAudioMixProfile(project, file, settings)).rejects.toThrow()
  }
})

it('rejects existing outputs and project escapes without changing existing bytes', async () => {
  const project = await root()
  const other = await root()
  const file = join(other, 'source.wav')
  await writeFile(file, 'preserved')
  await expect(requireProjectAudioFile(project, file)).rejects.toThrow('项目目录内')
  const bridge = join(project, 'external')
  await symlink(other, bridge, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(bridge)
  await expect(requireProjectAudioFile(project, join(bridge, 'source.wav'))).rejects.toThrow('项目目录内')
  await expect(requireNewAudioOutput(project, join(bridge, 'output.wav'))).rejects.toThrow('项目目录内')
  const output = join(project, 'already.wav')
  await writeFile(output, 'old audio')
  await expect(requireNewAudioOutput(project, output)).rejects.toThrow('不会覆盖')
  expect(await readFile(output, 'utf8')).toBe('old audio')
  await mkdir(join(project, 'audio'))
  await expect(requireNewAudioOutput(project, join(project, 'audio', 'new.wav'))).resolves.toBeUndefined()
})

it('reports digital silence and finite frame RMS/sample peaks without calling them LUFS', () => {
  expect(parseAudioWindows('frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-inf\n'
    + 'lavfi.astats.Overall.Peak_level=-inf\nframe:1 pts:4800 pts_time:0.1\n'
    + 'lavfi.astats.Overall.RMS_level=-23.1\nlavfi.astats.Overall.Peak_level=-20.1\n')).toEqual([
    { time_seconds: 0, rms_dbfs: null, peak_dbfs: null, silent: true },
    { time_seconds: 0.1, rms_dbfs: -23.1, peak_dbfs: -20.1, silent: false },
  ])
  expect(() => parseAudioWindows('')).toThrow('没有返回')
  expect(() => parseAudioWindows('frame:0 pts:0 pts_time:0\n')).toThrow('缺少 RMS')
})

it('marks EBU R128 incomplete 400 ms and 3 s windows instead of publishing warmup as loudness', async () => {
  const stdout = [0, 0.3, 2.9].map(time => `frame:0 pts:0 pts_time:${String(time)}\n`
    + 'lavfi.r128.M=-20.0\nlavfi.r128.S=-22.0\n').join('')
  const result = await measureAudioLoudness({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe',
    channel: { run: async () => ({ code: 0, stdout, stderr: '' }) } }, 'input.wav')
  expect(result).toEqual([
    { time_seconds: 0, momentary_lufs: null, short_term_lufs: null, momentary_full_window: false, short_term_full_window: false },
    { time_seconds: 0.3, momentary_lufs: -20, short_term_lufs: null, momentary_full_window: true, short_term_full_window: false },
    { time_seconds: 2.9, momentary_lufs: -20, short_term_lufs: -22, momentary_full_window: true, short_term_full_window: true },
  ])
})

it('keeps original sound once and exposes only compressed music as the music stem', () => {
  const profile: ResolvedAudioMixProfile = { schema_version: 1, path: 'mix.json', mode: 'ducking',
    original_gain: 1, music_gain: 1, analysis_window_ms: 100, ducking }
  const spec = { bodyEndSeconds: 8, totalSeconds: 8, endingSeconds: 0, masterVolume: 1, bgmVolume: 1 }
  const graph = audioMixFilter({ ...spec, profile, musicStem: true })
  expect(graph.match(/\[1:a\]/gu)).toHaveLength(1)
  expect(graph).toContain('asplit=2[a0][sc]')
  expect(graph).toContain('[music][sc]sidechaincompress=')
  expect(graph).toContain('[ducked]asplit=2[a1][musicstem]')
  expect(graph).toContain('[a0][a1]amix=inputs=2')
  const noMusic = audioMixFilter({ ...spec, profile: { ...profile, mode: 'no_bgm' } })
  expect(noMusic).not.toContain('[2:a]')
  expect(noMusic).not.toContain('sidechaincompress')
  expect(noMusic).toContain('[a0]anull,')
})

it('keeps legacy music unsplit and places a profiled ending after the body on its own input', () => {
  const profile: ResolvedAudioMixProfile = { schema_version: 1, path: 'mix.json', mode: 'legacy',
    original_gain: 0.8, music_gain: 0.2, analysis_window_ms: 100 }
  const spec = { bodyEndSeconds: 8, totalSeconds: 10, endingSeconds: 2, masterVolume: 1, bgmVolume: 1, profile }
  const graph = audioMixFilter(spec)
  expect(graph).toContain('[2:a]atrim=start=0.000000:duration=8.000000')
  expect(graph).toContain('[3:a]atrim=0:2.000000,adelay=8000|8000,volume=1[a2]')
  expect(graph).toContain('[a0][music][a2]amix=inputs=3')
  expect(graph).not.toContain('asplit')
  const noMusic = audioMixFilter({ ...spec, profile: { ...profile, mode: 'no_bgm' } })
  expect(noMusic).toContain('[2:a]atrim=0:2.000000')
  expect(noMusic).toContain('[a0][a2]amix=inputs=2')
  expect(() => audioMixFilter({ ...spec, profile: { ...profile, mode: 'ducking' } })).toThrow('缺少显式压缩参数')
})
