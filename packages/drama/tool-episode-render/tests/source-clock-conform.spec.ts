/** Real frame and audio checks for the local picture and original sound clock. */
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { firstStreamOfType, probeMedia } from '../src/ffmpeg.ts'
import { audioHash, audioPackets, conformSourceClock, frameHashes, probeClock } from '../src/source-clock-conform.ts'
import type { MediaToolkit, ProcessChannel } from '../src/types.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function fixture() {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'dsh-source-clock-'))
  const runner = createMediaRunner()
  onTestFinished(async () => { await runner.dispose(); await rm(project, { recursive: true, force: true }) })
  const input = join(project, 'origin.mp4'), changed = join(project, 'processed.mp4')
  const toolkit = { ffmpeg, ffprobe, channel: runner.channel }
  const command = async (args: readonly string[]) => {
    const result = await runner.runCommand(ffmpeg, ['-n', '-v', 'error', ...args])
    expect(result.code, result.stderr).toBe(0)
  }
  const origin = async () => command(['-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=337:sample_rate=48000:duration=2', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-qp', '0', '-c:a', 'aac', input])
  const processed = async (filter: string, output = changed) => command(['-i', input,
    '-map', '0:v', '-vf', filter, '-c:v', 'libx264', '-qp', '0', '-an', output])
  const inputs = async (candidate = changed) => ({ project, episode: 21, original: { path: input, sha256: await fileSha256(input) },
    processed: { path: candidate, sha256: await fileSha256(candidate) } })
  return { project, toolkit, origin, processed, inputs, input, changed }
}

const noMedia = () => { throw new Error('unexpected media command') }

it('rejects unowned and invalid source identities, a duplicate, and an aliased editing directory', async () => {
  const f = await fixture()
  await writeFile(f.input, 'original identity')
  await writeFile(f.changed, 'processed identity')
  const input = await f.inputs()
  const toolkit = { ...f.toolkit, channel: { run: noMedia } }
  await expect(conformSourceClock(toolkit, { ...input, episode: 0 })).rejects.toThrow(/正整数集号/u)
  await expect(conformSourceClock(toolkit, { ...input, processed: input.original })).rejects.toThrow(/不同的原片/u)
  await expect(conformSourceClock(toolkit, { ...input, processed: { ...input.processed, sha256: 'invalid' } })).rejects.toThrow(/本地 MP4/u)
  await expect(conformSourceClock(toolkit, { ...input, processed: { ...input.processed, path: '.' } })).rejects.toThrow(/本地 MP4/u)
  await writeFile(f.changed, '')
  await expect(conformSourceClock(toolkit, input)).rejects.toThrow(/本地 MP4/u)
  await writeFile(f.changed, 'processed identity')
  const target = join(f.project, 'retained')
  await mkdir(target)
  await symlink(target, join(f.project, 'editing'), 'junction')
  await expect(conformSourceClock(toolkit, input)).rejects.toThrow(/规范项目路径/u)
  expect(await readdir(target)).toEqual([])
})

it.each([
  { name: 'frame clock', observe: (toolkit: MediaToolkit) => probeClock(toolkit, 'example.mp4'), detail: /完整视频帧时钟/u },
  { name: 'original audio', observe: (toolkit: MediaToolkit) => audioHash(toolkit, 'example.mp4'), detail: /完整音轨摘要/u },
  { name: 'audio packets', observe: (toolkit: MediaToolkit) => audioPackets(toolkit, 'example.mp4'), detail: /原声音频包或时钟/u },
  { name: 'frame hashes', observe: (toolkit: MediaToolkit) => frameHashes(toolkit, 'example.mp4', 1), detail: /全部解码帧/u },
])('refuses a failed process or malformed result for $name', async ({ observe, detail }) => {
  const transport = (code: number): MediaToolkit => ({ ffmpeg, ffprobe,
    channel: { run: async () => ({ code, stdout: '{}', stderr: 'controlled media fault' }) } })
  await expect(observe(transport(1))).rejects.toThrow('controlled media fault')
  await expect(observe(transport(0))).rejects.toThrow(detail)
})

it('rejects plausible-looking probe output with a gap in its measured frame timestamps', async () => {
  const clock = { streams: [{ time_base: '1/24', avg_frame_rate: '24/1', r_frame_rate: '24/1',
    duration_ts: 2, nb_frames: '2' }], frames: [{ best_effort_timestamp: 0 }, { best_effort_timestamp: 2 }] }
  const toolkit = { ffmpeg, ffprobe,
    channel: { run: async () => ({ code: 0, stdout: JSON.stringify(clock), stderr: '' }) } }
  await expect(probeClock(toolkit, 'example.mp4')).rejects.toThrow(/每帧都能证明等间隔/u)
  clock.streams[0]!.time_base = '1/0'
  await expect(probeClock(toolkit, 'example.mp4')).rejects.toThrow(/完整视频帧时钟/u)
})

it.skipIf(!hasFfmpeg).each([
  { fault: 'dimensions', detail: /输入尺寸/u },
  { fault: 'missing video dimensions', detail: /输入尺寸/u },
  { fault: 'candidate audio mismatch', detail: /完整原声不符/u },
  { fault: 'candidate frame mismatch', detail: /所选帧不符/u },
  { fault: 'source change after encode', detail: /源片已变化/u },
  { fault: 'truncated decoded features', detail: /全部解码帧/u },
  { fault: 'features change after size check', detail: /全部解码帧/u },
  { fault: 'cancellation before candidate validation', detail: /cancelled by the test/u },
])('never keeps a candidate after $fault', async ({ fault, detail }) => {
  const f = await fixture()
  await f.origin()
  await f.processed(fault === 'dimensions' ? 'scale=32:24' : 'scale=256:192:flags=neighbor')
  const input = await f.inputs()
  if (fault === 'features change after size check') {
    const files = await import('node:fs/promises')
    const stat = files.lstat
    const mock = vi.spyOn(files, 'lstat').mockImplementation(async (path, options) => {
      const initial = await stat(path, options)
      if (typeof path === 'string' && path.startsWith(f.project) && path.endsWith('processed.rgb')) {
        await files.truncate(path, 1)
      }
      return initial
    })
    onTestFinished(() => { mock.mockRestore() })
  }
  const cancel = new AbortController()
  const run: ProcessChannel['run'] = async (command, argv) => {
    const outcome = await f.toolkit.channel.run(command, argv)
    const path = argv.at(-1) ?? ''
    if (fault === 'missing video dimensions' && command === ffprobe && argv.includes('-show_format')) {
      const probe = JSON.parse(outcome.stdout) as { streams: { codec_type: string; width?: number; height?: number }[] }
      for (const stream of probe.streams.filter(stream => stream.codec_type === 'video')) {
        delete stream.width
        delete stream.height
      }
      return { ...outcome, stdout: JSON.stringify(probe) }
    }
    if (fault === 'truncated decoded features' && path.endsWith('.rgb')) await writeFile(path, 'incomplete')
    if (path.endsWith('clip.mp4') && command === ffmpeg) {
      if (fault === 'source change after encode') await writeFile(f.input, 'externally changed input bytes')
      if (fault === 'cancellation before candidate validation') cancel.abort(new Error('cancelled by the test'))
    }
    if (argv.some(argument => argument.endsWith('clip.mp4')) && argv.includes('pipe:1')) {
      if (fault === 'candidate audio mismatch' && argv.includes('hash')) return { ...outcome, stdout: `SHA256=${'a'.repeat(64)}\n` }
      if (fault === 'candidate frame mismatch' && argv.includes('framehash')) {
        return { ...outcome, stdout: outcome.stdout.replace(/(,\s*)[a-f0-9]{64}/u, `$1${'a'.repeat(64)}`) }
      }
    }
    return outcome
  }
  await expect(conformSourceClock({ ...f.toolkit, channel: { run } }, input, cancel.signal)).rejects.toThrow(detail)
  expect(await readdir(join(f.project, 'editing'))).toEqual([])
})

it.skipIf(!hasFfmpeg)('adopts the complete cleaned picture at a different real cadence and keeps exact original audio', async () => {
  const f = await fixture()
  await f.origin()
  await f.processed('fps=30:start_time=0:round=up,drawbox=x=0:y=80:w=iw:h=16:color=white:t=fill')
  const input = await f.inputs()
  const result = await conformSourceClock(f.toolkit, input)
  expect(result).toMatchObject({ version: 1, episode: '21', original: input.original, processed: input.processed,
    clock: { originalRate: '24/1', processedRate: '30/1', originalFrames: 48, processedFrames: 60 },
    audio: { channels: 1, sampleRate: 48000 } })
  expect(result.output.sha256).toBe(await fileSha256(result.output.path))
  expect(await readdir(dirname(result.output.path))).toEqual(['clip.mp4'])
  expect(await f.inputs()).toEqual(input)
  const output = await probeMedia(f.toolkit, result.output.path)
  expect(firstStreamOfType(output, 'video')).toMatchObject({ frameCount: 48, avgFrameRate: '24/1', durationSeconds: 2 })
  expect(firstStreamOfType(output, 'audio')).toMatchObject({ sampleRate: 48000, durationSeconds: 2 })
}, 45_000)

it.skipIf(!hasFfmpeg)('keeps every same-rate HD frame with the exact original AAC packets', async () => {
  const f = await fixture()
  await f.origin()
  await f.processed('scale=256:192:flags=neighbor')
  const input = await f.inputs()
  const result = await conformSourceClock(f.toolkit, input)
  expect(result.clock).toMatchObject({ originalRate: '24/1', processedRate: '24/1', originalFrames: 48, processedFrames: 48 })
  expect(result.audio).toMatchObject({ channels: 1, sampleRate: 48000 })
  expect(firstStreamOfType(await probeMedia(f.toolkit, result.output.path), 'video')).toMatchObject({ width: 256, height: 192 })
  expect(await f.inputs()).toEqual(input)
}, 45_000)

it.skipIf(!hasFfmpeg)('rejects lost picture time, a mismatched picture, and an unproven newly inserted frame', async () => {
  const f = await fixture()
  await f.origin()
  const filters = [
    ['short.mp4', 'fps=30:start_time=0:round=up,trim=end_frame=59', /帧数或帧率/u],
    ['slower.mp4', 'fps=20:start_time=0:round=up', /帧数或帧率/u],
    ['wrong-same.mp4', 'drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill', /原片第 1 帧/u],
    ['wrong.mp4', 'fps=30:start_time=0:round=up,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill', /原片第 1 帧/u],
    ['inserted.mp4', "fps=30:start_time=0:round=up,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,1)'", /重复画面/u],
  ] as const
  for (const [name, filter, error] of filters) {
    const output = join(f.project, name)
    await f.processed(filter, output)
    await expect(conformSourceClock(f.toolkit, await f.inputs(output))).rejects.toThrow(error)
  }
  expect(await readdir(join(f.project, 'editing'))).toEqual([])
}, 45_000)

it('rejects a changed input before starting any media command and cleans up the attempt', async () => {
  const f = await fixture()
  await writeFile(f.input, 'original identity')
  await writeFile(f.changed, 'processed identity')
  const input = await f.inputs()
  await writeFile(f.changed, 'changed since capture')
  let commands = 0
  const toolkit = { ...f.toolkit, channel: { run: () => {
    commands++
    throw new Error('unexpected media command')
  } } }
  await expect(conformSourceClock(toolkit, input)).rejects.toThrow('素材摘要不一致')
  expect(commands).toBe(0)
  expect(await readdir(join(f.project, 'editing'))).toEqual([])
})
