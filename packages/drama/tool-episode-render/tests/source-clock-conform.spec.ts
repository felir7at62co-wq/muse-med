/** Real frame and audio checks for the local picture and original sound clock. */
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { firstStreamOfType, probeMedia } from '../src/ffmpeg.ts'
import { conformSourceClock } from '../src/source-clock-conform.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

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
