/** Verify that decoded picture time detects a same-duration edit that audio checks cannot see. */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createMediaToolkit, probeMedia, runFfmpeg } from '../src/ffmpeg.ts'
import { measurePictureClock } from '../src/picture-clock-readback.ts'
import { pictureClockFeatures } from '../src/source-clock-conform.ts'
import type { ProcessChannel } from '../src/types.ts'
import { ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const toolkit = createMediaToolkit({ ffmpeg, ffprobe })
const samples = [0.71, 1.46, 2.16].map(time => ({ referenceSeconds: time, outputSeconds: time }))
const movingPicture = [
  'color=black:s=128x96:r=24:d=3',
  "drawbox=x=4:y=4:w=70:h=46:color=white:t=fill:enable='between(t,0.46,1.1)'",
  "drawbox=x=52:y=8:w=72:h=42:color=yellow:t=fill:enable='between(t,1.15,1.7)'",
  "drawbox=x=18:y=13:w=90:h=45:color=blue:t=fill:enable='between(t,1.75,2.35)'",
].join(',')

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-picture-clock-test-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  const reference = join(folder, 'reference.mp4')
  const write = async (picture: readonly string[], output: string) => runFfmpeg(toolkit, [
    '-n', '-v', 'error', ...picture, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', output,
  ])
  await write(['-f', 'lavfi', '-i', movingPicture], reference)
  const convert = async (filter: string, name: string) => {
    const output = join(folder, name)
    await write(['-i', reference, '-vf', filter], output)
    return output
  }
  return { folder, reference, convert, write }
}

it.skipIf(!hasFfmpeg)('checks 24 and 60 fps with minor aspect rounding and a small color change', async () => {
  const f = await fixture()
  const output = await f.convert('fps=60,scale=256:192:flags=bilinear,setsar=1000/1001:max=2000,eq=brightness=0.015', 'rescaled.mp4')
  const result = await measurePictureClock(toolkit, { reference: f.reference, output, samples })
  expect(result.status).toBe('matching')
  expect(result.samples).toHaveLength(3)
  for (const sample of result.samples) {
    expect(sample).toMatchObject({ status: 'matching', reason: 'compared' })
    const reference = sample.referencePtsSeconds ?? Infinity
    const measured = sample.outputPtsSeconds ?? Infinity
    expect(reference * 24).toBeCloseTo(Math.round(reference * 24), 8)
    expect(measured * 60).toBeCloseTo(Math.round(measured * 60), 8)
    expect(Math.abs(measured - sample.outputSeconds)).toBeLessThanOrEqual(1 / 24 + 0.000002)
    expect(sample.meanDifference).toBeGreaterThan(0)
  }
}, 20_000)

it.skipIf(!hasFfmpeg)('rejects picture shifted within an equally long movie and only accepts an explicit remapping', async () => {
  const f = await fixture()
  const output = await f.convert('tpad=start_duration=0.5:start_mode=clone,trim=end=3', 'shifted.mp4')
  expect((await probeMedia(toolkit, output)).durationSeconds).toBe((await probeMedia(toolkit, f.reference)).durationSeconds)
  const wrong = await measurePictureClock(toolkit, { reference: f.reference, output, samples })
  expect(wrong.status).toBe('mismatched')
  expect(wrong.samples.map(sample => sample.status)).toEqual(['mismatched', 'mismatched', 'mismatched'])
  const remapped = await measurePictureClock(toolkit, { reference: f.reference, output,
    samples: samples.map(sample => ({ ...sample, outputSeconds: sample.outputSeconds + 0.5 })) })
  expect(remapped.status).toBe('matching')
}, 20_000)

it.skipIf(!hasFfmpeg)('compares the specified crop location against a differently shaped output', async () => {
  const f = await fixture()
  const output = await f.convert('crop=64:72:0:0', 'cropped.mp4')
  const input = { reference: f.reference, output, samples }
  const referenceCrop = { x: 0, y: 0, width: 64, height: 72 }
  const matching = await measurePictureClock(toolkit, { ...input, referenceCrop })
  expect(matching.status).toBe('matching')
  expect(matching.samples.every(sample => sample.status === 'matching')).toBe(true)
  const wrongLocation = await measurePictureClock(toolkit, { ...input, referenceCrop: { ...referenceCrop, x: 64 } })
  expect(wrongLocation.status).toBe('mismatched')
  expect(wrongLocation.samples.filter(sample => sample.status === 'mismatched')).toHaveLength(3)
  for (const x of [1, 66]) {
    const invalid = await measurePictureClock(toolkit, { ...input, referenceCrop: { ...referenceCrop, x } })
    expect(invalid.status).toBe('unverified')
    expect(invalid.samples.every(sample => sample.reason === 'unavailable')).toBe(true)
  }
}, 20_000)

it.skipIf(!hasFfmpeg)('keeps a stationary reference and altered display aspect unverified', async () => {
  const f = await fixture()
  const stationary = join(f.folder, 'stationary.mp4')
  await f.write(['-f', 'lavfi', '-i', 'color=gray:s=128x96:r=24:d=3'], stationary)
  const result = await measurePictureClock(toolkit, { reference: stationary, output: f.reference, samples })
  expect(result.status).toBe('unverified')
  expect(result.samples.map(sample => sample.reason)).toEqual(Array(3).fill('stationary_reference'))
  const output = await f.convert('setsar=2/1', 'altered-aspect.mp4')
  const aspect = await measurePictureClock(toolkit, { reference: f.reference, output, samples })
  expect(aspect.status).toBe('unverified')
  expect(aspect.samples.every(sample => sample.referencePtsSeconds === null && sample.outputPtsSeconds === null)).toBe(true)
}, 20_000)

it.skipIf(!hasFfmpeg)('propagates abort after decoding and removes its private picture samples', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const scratch: string[] = []
  const channel = { run: async (command: string, args: readonly string[]) => {
    const result = await toolkit.channel.run(command, args)
    const name = args.at(-1)
    if (name?.endsWith('.rgb')) {
      scratch.push(dirname(name))
      controller.abort(new Error('stop picture check'))
    }
    return result
  } }
  await expect(measurePictureClock({ ...toolkit, channel }, { reference: f.reference, output: f.reference, samples },
    controller.signal)).rejects.toThrow('stop picture check')
  expect(scratch).toHaveLength(1)
  await expect(stat(scratch[0] ?? '')).rejects.toMatchObject({ code: 'ENOENT' })
}, 20_000)

it('declines an oversized sampling plan and an invalid clock before launching media tools', async () => {
  const channel = { run: () => { throw Error('unexpected media lookup') } }
  const input = { reference: 'unused.mp4', output: 'unused.mp4' }
  await expect(measurePictureClock({ ...toolkit, channel }, { ...input, samples: [...samples, ...samples] }))
    .resolves.toEqual({ status: 'unverified', samples: [] })
  await expect(measurePictureClock({ ...toolkit, channel }, { ...input, samples: [{ referenceSeconds: -1, outputSeconds: 1 }] }))
    .resolves.toMatchObject({ status: 'unverified', samples: [{ reason: 'unavailable' }] })
})

it('declines relative paths and empty files before any media command', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-picture-input-fault-'))
  onTestFinished(() => rm(project, { recursive: true, force: true }))
  const validName = join(project, 'empty.mp4')
  await writeFile(validName, '')
  const run = vi.fn<ProcessChannel['run']>(() => { throw Error('unexpected media command') })
  for (const reference of ['relative.mp4', validName]) {
    await expect(measurePictureClock({ ...toolkit, channel: { run } }, { reference, output: reference, samples }))
      .resolves.toMatchObject({ status: 'unverified', samples: [{ reason: 'unavailable' }, {}, {}] })
  }
  expect(run).not.toHaveBeenCalled()
})

it.skipIf(!hasFfmpeg).each([
  ['failed stream probe', { code: 1 }],
  ['invalid rate text', { r_frame_rate: 'N/A' }],
  ['invalid pixel aspect', { sample_aspect_ratio: 'invalid' }],
  ['rotated picture', { side_data_list: [{}, { rotation: 90 }] }],
] as const)('reports unverified for a %s', async (_fault, patch) => {
  const f = await fixture()
  const run: ProcessChannel['run'] = async (command, args) => {
    const result = await toolkit.channel.run(command, args)
    if ('code' in patch) return { ...result, code: patch.code }
    const data = JSON.parse(result.stdout) as { streams: Record<string, unknown>[] }
    return { ...result, stdout: JSON.stringify({ streams: [{ ...data.streams[0], ...patch }] }) }
  }
  await expect(measurePictureClock({ ...toolkit, channel: { run } }, { reference: f.reference, output: f.reference, samples }))
    .resolves.toMatchObject({ status: 'unverified', samples: [{ reason: 'unavailable' }, {}, {}] })
})

function showFrame(time: number, width: number = pictureClockFeatures.size): string {
  return `config in time_base: 1/24\nn: 0 pts: ${String(time)} pts_time:0 fmt:rgb24 s:${String(width)}x48\n`
}

it.skipIf(!hasFfmpeg).each([
  'decode fails', 'decoded clock missing', 'unexpected frame dimensions', 'no frames reported',
  'short read after size check', 'no near reference frame', 'no near output frame',
] as const)('leaves picture evidence unavailable when %s', async (fault) => {
  const f = await fixture()
  let decodedPath: string | undefined
  const files = await import('node:fs/promises')
  const lstat = files.lstat
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (path, options) => {
    const info = await lstat(path, options)
    if (fault === 'short read after size check' && decodedPath !== undefined && path === decodedPath) {
      await files.truncate(decodedPath, 1)
    }
    return info
  })
  onTestFinished(() => { spy.mockRestore() })
  const run: ProcessChannel['run'] = async (command, argv) => {
    const result = await toolkit.channel.run(command, argv)
    const path = argv.at(-1)
    if (path === undefined || !path.endsWith('.rgb')) return result
    decodedPath = path
    if (fault === 'decode fails') return { ...result, code: 1 }
    if (fault === 'decoded clock missing') return { ...result, stderr: 'missing timestamps' }
    if (fault === 'unexpected frame dimensions') return { ...result, stderr: showFrame(16, 1) }
    if (fault === 'no frames reported') return { ...result, stderr: 'config in time_base: 1/24' }
    const farReference = fault === 'no near reference frame' && path.endsWith('reference-0.rgb')
    const farOutput = fault === 'no near output frame' && path.endsWith('output-0.rgb')
    if (farReference || farOutput) {
      await writeFile(path, Buffer.alloc(pictureClockFeatures.bytes))
      return { ...result, stderr: showFrame(farReference ? 8 : 19) }
    }
    return result
  }
  const input = { reference: f.reference, output: f.reference, samples: [{ referenceSeconds: 0.71, outputSeconds: 0.71 }] }
  await expect(measurePictureClock({ ...toolkit, channel: { run } }, input)).resolves.toMatchObject({
    status: 'unverified', samples: [{ status: 'unverified', reason: 'unavailable', outputPtsSeconds: null }],
  })
  expect(decodedPath).toBeDefined()
  await expect(stat(decodedPath!)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(!hasFfmpeg)('uses square pixels when no aspect metadata is present and declines mismatched picture shapes', async () => {
  const f = await fixture()
  const withoutAspectTag: ProcessChannel['run'] = async (command, args) => {
    const result = await toolkit.channel.run(command, args)
    if (command !== ffprobe) return result
    const data = JSON.parse(result.stdout) as { streams: { sample_aspect_ratio?: string }[] }
    for (const stream of data.streams) delete stream.sample_aspect_ratio
    return { ...result, stdout: JSON.stringify(data) }
  }
  const input = { reference: f.reference, output: f.reference, samples }
  await expect(measurePictureClock({ ...toolkit, channel: { run: withoutAspectTag } }, input))
    .resolves.toMatchObject({ status: 'matching' })
  const output = await f.convert('crop=64:96:0:0,setsar=1', 'narrow-square.mp4')
  const probe = vi.fn<ProcessChannel['run']>(withoutAspectTag)
  await expect(measurePictureClock({ ...toolkit, channel: { run: probe } }, { ...input, output }))
    .resolves.toMatchObject({ status: 'unverified', samples: [{ reason: 'unavailable' }, {}, {}] })
  expect(probe.mock.calls.map(([command]) => command)).toEqual([ffprobe, ffprobe])
})

it.skipIf(!hasFfmpeg)('leaves out-of-bounds times unverified and propagates a cancelled probe', async () => {
  const f = await fixture()
  const input = { reference: f.reference, output: f.reference, samples: [{ referenceSeconds: 3.5, outputSeconds: 0.71 }] }
  const run = vi.fn<ProcessChannel['run']>((command, args) => toolkit.channel.run(command, args))
  await expect(measurePictureClock({ ...toolkit, channel: { run } }, input)).resolves.toMatchObject({
    status: 'unverified', samples: [{ status: 'unverified', reason: 'unavailable' }],
  })
  expect(run.mock.calls.map(([command]) => command)).toEqual([ffprobe, ffprobe])
  const controller = new AbortController()
  const abortProbe: ProcessChannel['run'] = async (command, args) => {
    const result = await toolkit.channel.run(command, args)
    controller.abort(new Error('stop at stream probe'))
    return result
  }
  await expect(measurePictureClock({ ...toolkit, channel: { run: abortProbe } }, input, controller.signal))
    .rejects.toThrow('stop at stream probe')
})
