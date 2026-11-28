/** Exercise the actual lossless local splice and enforce its no-publication failure cases. */
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
    channels?: 1 | 2
  } = {}) => {
    const { rate = 32_000, frequency = isDonor ? 833 : 337, duration = 4, offset = false, extraTrack = false, channels = 1 } = options
    const picture = isDonor ? 'color=c=blue:' : 'testsrc2='
    const run = await runner.runCommand(ffmpeg, ['-n', '-v', 'error',
      '-f', 'lavfi', '-i', `${picture}size=128x96:rate=24:duration=${duration}`,
      ...(offset ? ['-itsoffset', '0.256'] : []),
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${rate}:duration=${duration}`,
      '-map', '0:v:0', '-map', '1:a:0', ...(extraTrack ? ['-map', '1:a:0'] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-ac', String(channels), '-c:a', 'aac', path])
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

it.skipIf(!hasFfmpeg).each([1, 2] as const)('preserves picture and unedited samples with %s input channels', async (channels) => {
  const f = await fixture()
  await f.encode(f.target, false, { channels })
  await f.encode(f.donor, true, { duration: 3.2, channels })
  const args = await f.args()
  const result = await patchLocalDialogue(f.toolkit, args)
  expect(result).toMatchObject({ episode: '21', target: args.target, donor: args.donor, durationMs: 240, fadeMs: 8,
    video: { frames: 96, timeBase: '1/12288' },
    audio: { sampleRate: 32_000, channels, samples: 128_000, targetStartSample: 40_000,
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
  const stride = channels * 4
  expect(patched.length).toBe(target.length)
  expect(patched.subarray(0, start * stride).equals(target.subarray(0, start * stride))).toBe(true)
  expect(patched.subarray(end * stride).equals(target.subarray(end * stride))).toBe(true)
  expect(patched.subarray((start + fade) * stride, (end - fade) * stride)
    .equals(donor.subarray((donorStart + fade) * stride, (donorStart + length - fade) * stride))).toBe(true)
  expect(patched.subarray(start * stride, (start + 1) * stride)).toEqual(target.subarray(start * stride, (start + 1) * stride))
  expect(patched.subarray((end - 1) * stride, end * stride)).toEqual(target.subarray((end - 1) * stride, end * stride))
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

it('rejects repeated, empty and redirected sources before running media binaries', async () => {
  const f = await fixture()
  await writeFile(f.target, 'target')
  await copyFile(f.target, f.donor)
  const toolkit = { ...f.toolkit, channel: { run: () => { throw new Error('unexpected media process') } } }
  await expect(patchLocalDialogue(toolkit, await f.args())).rejects.toThrow('需要两个不同的输入版本')
  await writeFile(f.donor, '')
  await expect(patchLocalDialogue(toolkit, await f.args())).rejects.toThrow('需要项目内两份有摘要的本地视频')
  await writeFile(f.donor, 'distinct donor')
  const args = await f.args()
  const alternateSource = join(args.project, 'alternate-source')
  await mkdir(alternateSource)
  await copyFile(f.donor, join(alternateSource, 'donor.mp4'))
  const redirected = join(args.project, 'from-junction')
  await symlink(alternateSource, redirected, 'junction')
  try {
    await expect(patchLocalDialogue(toolkit, { ...args, donor: { ...args.donor, path: join(redirected, 'donor.mp4') } }))
      .rejects.toThrow('需要项目内两份有摘要的本地视频')
  } finally { await rm(redirected) }
  const otherDirectory = join(args.project, 'other-editing')
  await mkdir(otherDirectory)
  await symlink(otherDirectory, f.editing, 'junction')
  await expect(patchLocalDialogue(toolkit, args)).rejects.toThrow('需要实际存在的项目内目录')
  expect(await readdir(otherDirectory)).toEqual([])
  expect(await f.args()).toEqual(args)
})

type ClockReport = {
  streams: { sample_rate: string; duration_ts: number }[]
  frames?: { best_effort_timestamp: number }[]
  packets?: { pts: number; side_data_list?: unknown[] }[]
}
const clockFailures = [
  { title: 'frame probe failure', probe: 'frames', failure: 'probe', message: 'interrupted frame probe' },
  { title: 'frame report with no frames', probe: 'frames', update: (report: ClockReport) => { report.frames = [] },
    message: '不能读取完整视频帧时钟' },
  { title: 'frame clock jump', probe: 'frames', update: (report: ClockReport) => {
    const frame = report.frames?.[3]
    if (frame === undefined) throw new Error('Fixture video lacks the expected frame')
    frame.best_effort_timestamp += 1
  }, message: '仅支持从零开始且等间隔的视频帧' },
  { title: 'video packet probe failure', probe: 'v:0', failure: 'probe', message: 'interrupted frame probe' },
  { title: 'video report with no packets', probe: 'v:0', update: (report: ClockReport) => { report.packets = [] },
    message: '媒体未提供完整的单一音视频数据和时钟' },
  { title: 'video report missing its last packet', probe: 'v:0', update: (report: ClockReport) => { report.packets?.pop() },
    message: '视频包数量与完整的零起点视频时钟不符' },
  { title: 'audio rate inconsistent with its clock', probe: 'a:0', update: (report: ClockReport) => {
    const stream = report.streams[0]
    if (stream === undefined) throw new Error('Fixture video lacks its audio stream')
    stream.sample_rate = '1000'
  }, message: '仅支持无偏移、已知采样率的单声道或立体声音频' },
  { title: 'AAC priming without Skip Samples', probe: 'a:0', update: (report: ClockReport) => {
    const packet = report.packets?.[0]
    if (packet === undefined || packet.pts >= 0) throw new Error('Fixture AAC lacks a priming packet')
    delete packet.side_data_list
  }, message: '音频起点有偏移或编码延迟不明确' },
  { title: 'discontinuous audio packet clock', probe: 'a:0', update: (report: ClockReport) => {
    const packet = report.packets?.[3]
    if (packet === undefined) throw new Error('Fixture audio lacks the expected packet')
    packet.pts += 1
  }, message: '音频存在断点、重叠或时钟偏移' },
  { title: 'audio report missing its final packet', probe: 'a:0', update: (report: ClockReport) => { report.packets?.pop() },
    message: '音频包覆盖的采样数与声音时钟不符' },
] as const

it.skipIf(!hasFfmpeg).each(clockFailures)('binds clip clocks before publication when $title', async (fault) => {
  const f = await fixture()
  await f.encode(f.target, false)
  await f.encode(f.donor, true)
  const args = await f.args()
  const channel = { run: async (command: string, argv: readonly string[]) => {
    const result = await f.toolkit.channel.run(command, argv)
    const path = argv.at(-1)
    if (command !== ffprobe || result.code !== 0 || path === undefined || basename(path) !== 'target.mov') return result
    const probe = argv.includes('-show_frames') ? 'frames' : argv[argv.indexOf('-select_streams') + 1]
    if (probe !== fault.probe) return result
    if ('failure' in fault) return { ...result, code: 1, stdout: '', stderr: 'interrupted frame probe' }
    const parsed = JSON.parse(result.stdout) as ClockReport
    fault.update(parsed)
    return { ...result, stdout: JSON.stringify(parsed) }
  } }
  await expect(patchLocalDialogue({ ...f.toolkit, channel }, args)).rejects.toThrow(fault.message)
  expect(await f.args()).toEqual(args)
  expect(await readdir(f.editing)).toEqual([])
}, 45_000)

it.skipIf(!hasFfmpeg)('requires millisecond boundaries to land on exact input samples', async () => {
  const f = await fixture()
  await f.encode(f.target, false, { rate: 44_100 })
  await f.encode(f.donor, true, { rate: 44_100 })
  const args = await f.args(451)
  await expect(patchLocalDialogue(f.toolkit, args)).rejects.toThrow('所选毫秒边界不能精确落到采样点')
  expect(await f.args(451)).toEqual(args)
  expect(await readdir(f.editing)).toEqual([])
}, 45_000)

it.skipIf(!hasFfmpeg).each(['short decode', 'snapshot replaced', 'cancelled'] as const)(
  'removes temporary files after %s and preserves both source files', async (fault) => {
    const f = await fixture()
    await f.encode(f.target, false)
    await f.encode(f.donor, true)
    const args = await f.args()
    const controller = new AbortController()
    const reason = new Error('cancelled at verified media readback')
    const channel = { run: async (command: string, argv: readonly string[]) => {
      const result = await f.toolkit.channel.run(command, argv)
      const path = argv.at(-1)
      if (command !== ffmpeg || result.code !== 0 || path === undefined) return result
      if (fault === 'short decode' && basename(path) === 'target.pcm') await truncate(path, (await stat(path)).size - 4)
      if (basename(path) === 'verified.pcm') {
        if (fault === 'snapshot replaced') await writeFile(join(dirname(path), 'donor.mov'), 'superseded temporary snapshot')
        if (fault === 'cancelled') controller.abort(reason)
      }
      return result
    } }
    const patch = patchLocalDialogue({ ...f.toolkit, channel }, args, controller.signal)
    if (fault === 'cancelled') await expect(patch).rejects.toBe(reason)
    else await expect(patch).rejects.toThrow(fault === 'short decode' ? '解码后的实际采样数与音频时钟不符' : '来源字节与已核对的摘要不一致')
    expect(await f.args()).toEqual(args)
    expect(await readdir(f.editing)).toEqual([])
  }, 45_000)
