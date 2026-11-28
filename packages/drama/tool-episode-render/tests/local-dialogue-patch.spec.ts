/** Exercise the actual lossless local splice and enforce its no-publication failure cases. */
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { patchLocalDialogue } from '../src/local-dialogue-patch.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

async function fixture() {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'dsh-local-dialogue-patch-'))
  const runner = createMediaRunner()
  onTestFinished(async () => { await runner.dispose(); await rm(project, { recursive: true, force: true }) })
  const toolkit = { ffmpeg, ffprobe, channel: runner.channel }
  const target = join(project, 'target.mp4'), donor = join(project, 'donor.mp4')
  const editing = join(project, 'editing')
  const encode = async (path: string, isDonor: boolean, options: {
    rate?: number
    frequency?: number
    duration?: number
    offset?: boolean
    extraTrack?: boolean
  } = {}) => {
    const { rate = 32_000, frequency = isDonor ? 833 : 337, duration = 4, offset = false, extraTrack = false } = options
    const picture = isDonor ? 'color=c=blue:' : 'testsrc2='
    const run = await runner.runCommand(ffmpeg, ['-n', '-v', 'error',
      '-f', 'lavfi', '-i', `${picture}size=128x96:rate=24:duration=${duration}`,
      ...(offset ? ['-itsoffset', '0.256'] : []),
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${rate}:duration=${duration}`,
      '-map', '0:v:0', '-map', '1:a:0', ...(extraTrack ? ['-map', '1:a:0'] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path])
    expect(run.code, run.stderr).toBe(0)
  }
  async function args(donorStart = 450) {
    return { project, episode: 21, target: { path: target, sha256: await fileSha256(target), startMs: 1250 },
      donor: { path: donor, sha256: await fileSha256(donor), startMs: donorStart }, durationMs: 240 }
  }
  const decode = async (path: string, name: string) => {
    const pcm = join(project, name)
    const result = await runner.runCommand(ffmpeg, ['-n', '-v', 'error', '-i', path, '-map', '0:a:0',
      '-c:a', 'pcm_s32le', '-f', 's32le', pcm])
    expect(result.code, result.stderr).toBe(0)
    return await readFile(pcm)
  }
  const inspectPicture = async (path: string) => {
    const result = await runner.runCommand(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
      '-show_streams', '-show_data_hash', 'sha256', '-show_entries',
      'stream=time_base,start_pts,duration_ts:stream_tags=:stream_disposition=:packet=pts,dts,duration,flags,data_hash',
      '-of', 'json', path])
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  return { target, donor, editing, toolkit, encode, decode, args, inspectPicture }
}

it.skipIf(!hasFfmpeg)('patches only the named samples while preserving the entire target picture and sound clock', async () => {
  const f = await fixture()
  await f.encode(f.target, false)
  await f.encode(f.donor, true, { duration: 3.2 })
  const args = await f.args()
  const result = await patchLocalDialogue(f.toolkit, args)
  expect(result).toMatchObject({ episode: '21', target: args.target, donor: args.donor, durationMs: 240, fadeMs: 8,
    video: { frames: 96, timeBase: '1/12288' },
    audio: { sampleRate: 32_000, channels: 1, samples: 128_000, targetStartSample: 40_000,
      donorStartSample: 14_400, patchSamples: 7680, fadeSamples: 256 },
    reviewStatus: 'pending_review', listeningVerified: false, sourceApproved: false })
  expect(await f.args()).toEqual(args)
  expect(await fileSha256(result.output.path)).toBe(result.output.sha256)
  expect(await readdir(dirname(result.output.path))).toEqual(['clip.mov'])
  expect(await f.inspectPicture(result.output.path)).toBe(await f.inspectPicture(f.target))

  const [target, donor, patched] = await Promise.all([f.decode(f.target, 'test-target.pcm'),
    f.decode(f.donor, 'test-donor.pcm'), f.decode(result.output.path, 'test-output.pcm')])
  const { targetStartSample: start, donorStartSample: donorStart, patchSamples: length, fadeSamples: fade } = result.audio
  const end = start + length
  expect(patched.length).toBe(target.length)
  expect(patched.subarray(0, start * 4).equals(target.subarray(0, start * 4))).toBe(true)
  expect(patched.subarray(end * 4).equals(target.subarray(end * 4))).toBe(true)
  expect(patched.subarray((start + fade) * 4, (end - fade) * 4)
    .equals(donor.subarray((donorStart + fade) * 4, (donorStart + length - fade) * 4))).toBe(true)
  expect(patched.readInt32LE(start * 4)).toBe(target.readInt32LE(start * 4))
  expect(patched.readInt32LE((end - 1) * 4)).toBe(target.readInt32LE((end - 1) * 4))
  expect(result.audio.originalPatchSha256).not.toBe(result.audio.replacementSha256)
}, 45_000)

it.skipIf(!hasFfmpeg)('rejects offset and ambiguous tracks, incompatible formats, and windows outside the clip', async () => {
  const f = await fixture()
  await f.encode(f.target, false)
  await f.encode(f.donor, true, { offset: true })
  await expect(patchLocalDialogue(f.toolkit, await f.args())).rejects.toThrow(/从零开始/u)
  await rm(f.donor)
  await f.encode(f.donor, true, { extraTrack: true })
  await expect(patchLocalDialogue(f.toolkit, await f.args())).rejects.toThrow(/一条视频和一条音频/u)
  await rm(f.donor)
  await f.encode(f.donor, true, { rate: 48_000 })
  await expect(patchLocalDialogue(f.toolkit, await f.args())).rejects.toThrow(/采样率不相容/u)
  await rm(f.donor)
  await f.encode(f.donor, true)
  await expect(patchLocalDialogue(f.toolkit, await f.args(3900))).rejects.toThrow(/各自的画面和音频范围/u)
  expect(await readdir(f.editing)).toEqual([])
}, 45_000)

it.skipIf(!hasFfmpeg)('rejects a same-audio no-op and a successful mux that did not use the patch', async () => {
  const f = await fixture()
  await f.encode(f.target, false)
  await f.encode(f.donor, true, { frequency: 337 })
  await expect(patchLocalDialogue(f.toolkit, await f.args(1250))).rejects.toThrow(/没有改变目标窗口/u)
  await rm(f.donor)
  await f.encode(f.donor, true)
  const toolkit = { ...f.toolkit, channel: { run: async (command: string, argv: readonly string[]) => {
    const path = argv.at(-1)
    if (command === ffmpeg && path?.endsWith('candidate.mov')) {
      await copyFile(f.target, path)
      return { code: 0, stdout: '', stderr: '' }
    }
    return await f.toolkit.channel.run(command, argv)
  } } }
  await expect(patchLocalDialogue(toolkit, await f.args())).rejects.toThrow(/输出回读与预期/u)
  expect(await readdir(f.editing)).toEqual([])
}, 45_000)

it('rejects unsupported windows or changed exact source bytes before running media binaries', async () => {
  const f = await fixture()
  await writeFile(f.target, 'target')
  await writeFile(f.donor, 'donor')
  const args = await f.args()
  const toolkit = { ...f.toolkit, channel: { run: () => { throw new Error('unexpected media process') } } }
  await expect(patchLocalDialogue(toolkit, { ...args, durationMs: 601 }))
    .rejects.toHaveProperty('code', 'DIALOGUE_PATCH_INVALID')
  const outside = join(dirname(f.target), '..', 'outside.mp4')
  await expect(patchLocalDialogue(toolkit, { ...args, donor: { ...args.donor, path: outside } }))
    .rejects.toHaveProperty('code', 'DIALOGUE_PATCH_INVALID')
  await writeFile(f.donor, 'changed')
  await expect(patchLocalDialogue(toolkit, args)).rejects.toThrow(/摘要不一致/u)
  expect(await readdir(f.editing)).toEqual([])
})
