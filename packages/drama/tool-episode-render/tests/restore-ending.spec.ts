/** Exercise real local decoding, replacement and rejection without provider requests. */
import { appendFile, copyFile, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { restoreEnding } from '../src/restore-ending.ts'
import { audioHash, audioPackets, frameHashes, probeClock } from '../src/source-clock-conform.ts'
import type { ProcessChannel } from '../src/types.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

async function fixture() {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'dsh-restore-ending-'))
  const runner = createMediaRunner()
  onTestFinished(async () => { await runner.dispose(); await rm(project, { recursive: true, force: true }) })
  const toolkit = { ffmpeg, ffprobe, channel: runner.channel }
  const original = join(project, 'original.mp4'), donor = join(project, 'donor.mp4')
  const encode = async (path: string, picture: string, frequency: number, filter?: string) => {
    const result = await runner.runCommand(ffmpeg, ['-n', '-v', 'error', '-f', 'lavfi', '-i', picture,
      '-f', 'lavfi', '-i', `sine=frequency=${String(frequency)}:sample_rate=48000:duration=4`,
      '-map', '0:v:0', '-map', '1:a:0', ...(filter === undefined ? [] : ['-vf', filter]),
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path])
    expect(result.code, result.stderr).toBe(0)
  }
  const source = 'testsrc2=size=128x96:rate=24:duration=4'
  async function pair(picture = source, substituteTail = true) {
    await encode(original, source, 337)
    await encode(donor, picture, 886, substituteTail ? "drawbox=x=4:y=3:w=iw-8:h=ih-6:color=green:t=fill:enable='gte(n,60)'" : undefined)
  }
  async function inputs(startMs = 2500) {
    return { project, episode: 43, original: { path: original, sha256: await fileSha256(original) },
      donor: { path: donor, sha256: await fileSha256(donor) }, startMs }
  }
  return { project, toolkit, original, donor, pair, inputs }
}

it('rejects an invalid boundary, aliased directory, unowned source, empty file and duplicate before decoding', async () => {
  const f = await fixture()
  await writeFile(f.original, 'original identity')
  await writeFile(f.donor, 'donor identity')
  const input = await f.inputs()
  const toolkit = { ...f.toolkit, channel: { run: () => { throw new Error('unexpected media command') } } }
  await expect(restoreEnding(toolkit, { ...input, episode: 0 })).rejects.toThrow(/画面边界毫秒值/u)
  await expect(restoreEnding(toolkit, { ...input, startMs: -1 })).rejects.toThrow(/画面边界毫秒值/u)
  await expect(restoreEnding(toolkit, { ...input, donor: input.original })).rejects.toThrow(/不同的原片/u)
  await expect(restoreEnding(toolkit, { ...input, donor: { ...input.donor, path: '.' } })).rejects.toThrow(/本地 MP4/u)
  await writeFile(f.donor, '')
  await expect(restoreEnding(toolkit, input)).rejects.toThrow(/大小超出/u)
  await writeFile(f.donor, 'donor identity')
  const target = join(f.project, 'retained')
  await mkdir(target)
  await symlink(target, join(f.project, 'editing'), 'junction')
  await expect(restoreEnding(toolkit, input)).rejects.toThrow(/规范目录/u)
  expect(await readdir(target)).toEqual([])
})

it.skipIf(!hasFfmpeg).each([
  { fault: 'identical tail', detail: /片尾画面相同/u },
  { fault: 'missing original video dimensions', detail: /原片原声超出支持范围/u },
  { fault: 'missing original sample rate', detail: /原片原声超出支持范围/u },
  { fault: 'picture metadata command failure', detail: /controlled metadata command failure/u },
  { fault: 'malformed pixel profile', detail: /方形像素/u },
  { fault: 'rotated donor', detail: /方形像素/u },
  { fault: 'different donor color tags', detail: /颜色标记不一致/u },
  { fault: 'lost candidate audio', detail: /完整时钟、画面规格或原声不符/u },
  { fault: 'candidate changes just after frame readback', detail: /回读期间已经变化/u },
  { fault: 'cancellation after candidate encode', detail: /cancelled at candidate encode/u },
])('publishes nothing after $fault', async ({ fault, detail }) => {
  const f = await fixture()
  await f.pair(undefined, fault !== 'identical tail')
  const args = await f.inputs()
  const cancel = new AbortController()
  const run: ProcessChannel['run'] = async (command, argv) => {
    const result = await f.toolkit.channel.run(command, argv)
    const path = argv.at(-1) ?? ''
    if (command === ffprobe && argv.some(argument => argument.startsWith('stream=pix_fmt,'))) {
      if (fault === 'picture metadata command failure') return { code: 1, stdout: '', stderr: 'controlled metadata command failure' }
      if (fault === 'malformed pixel profile') return { ...result, stdout: JSON.stringify({ streams: [{ pix_fmt: 'rgb24' }] }) }
      if (path.endsWith('donor.mp4') && fault === 'rotated donor') {
        return { ...result, stdout: JSON.stringify({ streams: [{ pix_fmt: 'yuv420p', side_data_list: [{}, { rotation: 90 }] }] }) }
      }
      if (path.endsWith('donor.mp4') && fault === 'different donor color tags') {
        return { ...result, stdout: JSON.stringify({ streams: [{ pix_fmt: 'yuv420p', color_space: 'bt709' }] }) }
      }
    }
    if (command === ffprobe && argv.includes('-show_format')) {
      if (path.endsWith('candidate.mp4') && fault === 'lost candidate audio') {
        const doc = JSON.parse(result.stdout) as { streams: { codec_type: string }[] }
        doc.streams = doc.streams.filter(stream => stream.codec_type !== 'audio')
        return { ...result, stdout: JSON.stringify(doc) }
      }
      const incompleteOriginal = fault === 'missing original video dimensions' || fault === 'missing original sample rate'
      if (path.endsWith('original.mp4') && incompleteOriginal) {
        const doc = JSON.parse(result.stdout) as {
          streams: { codec_type: string; width?: number; height?: number; sample_rate?: string }[]
        }
        for (const stream of doc.streams) {
          if (fault === 'missing original video dimensions') {
            delete stream.width
            delete stream.height
          } else delete stream.sample_rate
        }
        return { ...result, stdout: JSON.stringify(doc) }
      }
    }
    if (command === ffmpeg && path.endsWith('candidate.mp4') && fault === 'cancellation after candidate encode') {
      cancel.abort(new Error('cancelled at candidate encode'))
    }
    const candidate = argv.find(argument => argument.endsWith('candidate.mp4'))
    if (candidate !== undefined && argv.includes('framehash') && fault === 'candidate changes just after frame readback') {
      await appendFile(candidate, 'unverified trailing bytes')
    }
    return result
  }
  await expect(restoreEnding({ ...f.toolkit, channel: { run } }, args, cancel.signal)).rejects.toThrow(detail)
  expect(await readdir(join(f.project, 'editing'))).toEqual([])
  expect(await f.inputs()).toEqual(args)
})

it.skipIf(!hasFfmpeg)('replaces each same-time tail frame and preserves the entire original body, clock and sound', async () => {
  const f = await fixture()
  await f.pair()
  const args = await f.inputs()
  const result = await restoreEnding(f.toolkit, args)
  expect(result).toMatchObject({ project: f.project, episode: '43', original: args.original, donor: args.donor,
    startMs: 2500, endMs: 4000, clock: { rate: '24/1', frames: 96, width: 128, height: 96, startFrame: 60 },
    audio: { channels: 1, sampleRate: 48000 } })
  expect(await f.inputs()).toEqual(args)
  expect(await fileSha256(result.output.path)).toBe(result.output.sha256)
  expect(await readdir(dirname(result.output.path))).toEqual(['clip.mp4'])
  const original = await frameHashes(f.toolkit, f.original, 96), donor = await frameHashes(f.toolkit, f.donor, 96)
  expect(donor[60]).not.toBe(original[60])
  expect(await frameHashes(f.toolkit, result.output.path, 96)).toEqual([...original.slice(0, 60), ...donor.slice(60)])
  expect(await probeClock(f.toolkit, result.output.path)).toEqual(await probeClock(f.toolkit, f.original))
  const audio = await audioHash(f.toolkit, result.output.path)
  expect(audio).toBe(await audioHash(f.toolkit, f.original))
  expect(audio).not.toBe(await audioHash(f.toolkit, f.donor))
  expect(await audioPackets(f.toolkit, result.output.path)).toEqual(await audioPackets(f.toolkit, f.original))
}, 45_000)

it.skipIf(!hasFfmpeg)('rejects a different clock or episode picture and refuses a non-frame or too-early cut', async () => {
  const f = await fixture()
  await f.pair('color=blue:size=128x96:rate=25:duration=4')
  await expect(restoreEnding(f.toolkit, await f.inputs())).rejects.toThrow(/相同的完整帧数和帧率/u)
  await rm(f.original)
  await rm(f.donor)
  await f.pair('color=blue:size=128x96:rate=24:duration=4')
  await expect(restoreEnding(f.toolkit, await f.inputs())).rejects.toThrow(/处理片时点不相符/u)
  await expect(restoreEnding(f.toolkit, await f.inputs(2501))).rejects.toThrow(/真实的帧边界/u)
  await expect(restoreEnding(f.toolkit, await f.inputs(500))).rejects.toThrow(/最后三秒/u)
  expect(await readdir(join(f.project, 'editing'))).toEqual([])
}, 45_000)

it.skipIf(!hasFfmpeg)('does not publish a successful encode that actually kept the old tail', async () => {
  const f = await fixture()
  await f.pair()
  const toolkit = { ...f.toolkit, channel: { run: async (command: string, argv: readonly string[]) => {
    const path = argv.at(-1)
    if (command === ffmpeg && path?.endsWith('candidate.mp4')) {
      await copyFile(f.original, path)
      return { code: 0, stdout: '', stderr: '' }
    }
    return await f.toolkit.channel.run(command, argv)
  } } }
  await expect(restoreEnding(toolkit, await f.inputs())).rejects.toThrow(/逐帧核对结果不符/u)
  expect(await readdir(join(f.project, 'editing'))).toEqual([])
}, 45_000)

it('rejects bytes changed since proof before invoking FFmpeg', async () => {
  const f = await fixture()
  await writeFile(f.original, 'bound original')
  await writeFile(f.donor, 'bound previous version')
  const args = await f.inputs()
  await writeFile(f.donor, 'unverified previous version')
  const toolkit = { ...f.toolkit, channel: { run: () => { throw new Error('no media process expected') } } }
  await expect(restoreEnding(toolkit, args)).rejects.toThrow(/已核对的摘要不一致/u)
  expect(await readdir(join(f.project, 'editing'))).toEqual([])
})
