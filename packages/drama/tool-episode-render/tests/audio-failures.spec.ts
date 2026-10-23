/** Audio input rejection and audition cleanup preserve project-owned files. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadAudioMixProfile, measureAudioLoudness, measureAudioWindows, parseAudioWindows,
  previewAudio, requireNewAudioOutput, requireProjectAudioFile } from '../src/audio.ts'
import { resolveSettings, runDramaRender } from '../src/index.ts'
import type { MediaToolkit } from '../src/types.ts'

const denied = vi.hoisted(() => ({ output: '' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (String(args[0]) === denied.output) throw Object.assign(new Error('output access denied'), { code: 'EACCES' })
    return await actual.lstat(...args)
  } }
})
const roots: string[] = []
afterEach(async () => { denied.output = ''; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(mode: 'legacy' | 'no_bgm' = 'legacy') {
  const project = await mkdtemp(join(tmpdir(), 'audio-failure-'))
  roots.push(project)
  const timelinePath = join(project, 'timeline.json'), audio = join(project, 'original.wav')
  const bgm = join(project, 'music.wav'), profilePath = join(project, 'mix.json')
  await writeFile(timelinePath, JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 2_000_000 }], body_end: 2 }))
  await writeFile(audio, 'original sound'); await writeFile(bgm, 'music')
  await writeFile(profilePath, JSON.stringify({ schema_version: 1, mode, analysis_window_ms: 100 }))
  const calls: string[][] = []
  let failEncode = false
  const toolkit: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async (_command, args) => {
    calls.push([...args])
    const filter = args[args.indexOf('-af') + 1] ?? ''
    if (filter.includes('astats')) return { code: 0, stdout: 'frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-20\nlavfi.astats.Overall.Peak_level=-10\n', stderr: '' }
    if (filter.includes('ebur128')) return { code: 0, stdout: 'frame:0 pts:0 pts_time:0.3\nlavfi.r128.M=-20\nlavfi.r128.S=-22\n', stderr: '' }
    if (failEncode) return { code: 1, stdout: '', stderr: 'audition encoder failed' }
    for (const arg of args) if (['selected_mix.wav', 'without_added_music.wav', 'music_stem.wav'].includes(basename(arg))) await writeFile(arg, 'PCM audition')
    return { code: 0, stdout: '', stderr: '' }
  } } }
  const settings = { ...resolveSettings({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }), channel: toolkit.channel }
  return { project, timelinePath, audio, bgm, profilePath, toolkit, settings, calls,
    input: { project, episode: '01', timelinePath, audio, bgm, profilePath, toolkit, settings, startSeconds: 0, durationSeconds: 1 },
    fail: () => { failEncode = true } }
}

it('rejects empty audio, directories, oversized profiles and inaccessible output paths', async () => {
  const f = await fixture(), empty = join(f.project, 'empty.wav')
  await writeFile(empty, '')
  await expect(requireProjectAudioFile(f.project, empty)).rejects.toThrow('不是非空文件')
  await expect(requireProjectAudioFile(f.project, f.project)).rejects.toThrow('不是非空文件')
  await writeFile(f.profilePath, ' '.repeat(32_769))
  await expect(loadAudioMixProfile(f.project, f.profilePath, f.settings)).rejects.toThrow('32 KiB')
  denied.output = join(f.project, 'new.wav')
  await expect(requireNewAudioOutput(f.project, denied.output)).rejects.toMatchObject({ code: 'EACCES' })
  expect(await readFile(f.audio, 'utf8')).toBe('original sound')
})

it('reports failed measurement commands, malformed levels and missing loudness frames', async () => {
  const failed: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async () => ({ code: 3, stdout: '', stderr: 'decoder failed' }) } }
  await expect(measureAudioWindows(failed, 'input.wav', 100)).rejects.toThrow('decoder failed')
  await expect(measureAudioLoudness(failed, 'input.wav')).rejects.toThrow('decoder failed')
  expect(() => parseAudioWindows('frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=1e999\n')).toThrow('有效数值')
  const toolkit: MediaToolkit = { ...failed, channel: { run: async () => ({ code: 0, stdout: 'unrecognized output', stderr: '' }) } }
  await expect(measureAudioLoudness(toolkit, 'input.wav')).rejects.toThrow('没有返回 EBU R128')
})

it.each([
  { startSeconds: -1, durationSeconds: 1 }, { startSeconds: 0, durationSeconds: 0 },
  { startSeconds: 0, durationSeconds: 61 }, { startSeconds: NaN, durationSeconds: 1 },
  { startSeconds: 0, durationSeconds: Infinity },
])('rejects invalid audition bounds before reading inputs: %j', async (bounds) => {
  const f = await fixture()
  await expect(previewAudio({ ...f.input, ...bounds })).rejects.toThrow('start_seconds')
  expect(f.calls).toEqual([])
})

it('rejects sub-sample windows, unsafe sample positions, late windows and missing required music', async () => {
  const f = await fixture()
  await expect(previewAudio({ ...f.input, durationSeconds: 0.0000001 })).rejects.toThrow('48 kHz 样本')
  await expect(previewAudio({ ...f.input, startSeconds: Number.MAX_SAFE_INTEGER })).rejects.toThrow('安全整数')
  await expect(previewAudio({ ...f.input, startSeconds: 1.5 })).rejects.toThrow('超过正文')
  const { bgm: _bgm, ...withoutMusic } = f.input
  await expect(previewAudio(withoutMusic)).rejects.toThrow('需要 bgm')
  expect(f.calls).toEqual([])
})

it('rejects oversized composer evidence before allocating an audition', async () => {
  const f = await fixture(), receipt = join(f.project, 'receipt.json')
  await writeFile(receipt, ' '.repeat(2_097_153))
  await expect(previewAudio({ ...f.input, bgmGeneration: receipt })).rejects.toThrow('2 MiB')
  await expect(readdir(join(f.project, 'audio/previews'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes only its failed new audition directory and retains original sound', async () => {
  const f = await fixture()
  f.fail()
  await expect(previewAudio(f.input)).rejects.toThrow('audition encoder failed')
  expect(await readdir(join(f.project, 'audio/previews'))).toEqual([])
  expect(await readFile(f.audio, 'utf8')).toBe('original sound')
})

it('returns explicit missing-plan and missing-composer observations through the renderer tool path', async () => {
  const f = await fixture()
  const report = await runDramaRender({ method: 'audio_preview', project: f.project, episode: 1,
    timeline: f.timelinePath, audio: f.audio, mixProfile: f.profilePath, bgm: f.bgm,
    startSeconds: 0, durationSeconds: 1 }, f.settings)
  expect(report.audio_mix).toMatchObject({ mode: 'legacy', composition_gain_status: 'not_provided' })
  expect(report.warnings.join('\n')).toContain('未提供配乐计划')
  expect(report.warnings.join('\n')).toContain('未提供匹配的配乐合成收据')
  expect(report.warnings.join('\n')).not.toContain('不是语义 VAD')
  expect(report.written).toHaveLength(4)
})

it('skips non-frame loudness output while retaining a measured full-window row', async () => {
  const toolkit: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async () => ({ code: 0,
    stdout: 'diagnostic\nframe:0 pts:0 pts_time:3\nlavfi.r128.M=-20\nlavfi.r128.S=-22\n', stderr: '' }) } }
  expect(await measureAudioLoudness(toolkit, 'input.wav')).toEqual([{ time_seconds: 3, momentary_lufs: -20,
    short_term_lufs: -22, momentary_full_window: true, short_term_full_window: true }])
})
