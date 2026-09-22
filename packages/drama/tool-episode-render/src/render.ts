/**
 * `render`: encode one episode into the delivered file.
 *
 * The pipeline is the delivery specification, in order: every body clip is
 * re-encoded to the delivery geometry under its own timeline duration, the ending
 * is rebuilt from the last body shot's *proved* tail frame, the body and the
 * ending are concatenated with stream copy, the ASS script is burned in, and the
 * three audio sources are mixed and muxed with a fast-start index. The result is
 * then measured and judged against the delivery specification.
 *
 * Everything that makes the render impossible — a missing input, a failed
 * command, an unprovable tail frame — throws. The delivered file's own
 * properties do not: a file that misses the bitrate floor is reported with
 * `ok: false` and its repair instructions, because the operator still needs the
 * file and the measurement.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/render
 */

import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dirname, resolve } from 'node:path'
import { readBgmPlan } from './bgm.ts'
import { fileSha256, readCacheIdentity } from './cache.ts'
import { buildProvenance, provenancePathFor, writeProvenance } from './provenance.ts'
import {
  audioMixFilter,
  deliveryScaleFilter,
  ENDING_SECONDS,
  MAX_BITRATE,
  MIN_BITRATE_BPS,
  subtitleBurnFilter,
  TARGET_BITRATE,
} from './delivery.ts'
import { chooseEncoder } from './encoder.ts'
import { buildEndingClip, extractTailFrame } from './ending.ts'
import { firstStreamOfType, frameRateOf, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodePaths, pathExists, shotFileName } from './paths.ts'
import { buildReport, type ReportInput } from './report.ts'
import { readSubtitleCues, buildAssDocument } from './subtitles.ts'
import { bodyEndSecondsOf, readTimeline, selectBodyClips } from './timeline.ts'
import type { DramaRenderReport, MediaFacts, MediaToolkit, RenderCheck, RenderSettings } from './types.ts'
import { deliveryChecks } from './verify.ts'
import { assertVideoHashesAllowed, assertVideosAllowed } from './video.ts'

/** Microseconds in one second. */
const MICROSECONDS_PER_SECOND = 1_000_000

/** Everything one `render` call needs. */
export interface RenderInput {
  /** The binaries and channel to use, or a stub in tests. */
  readonly toolkit: MediaToolkit
  /** The deployment-varying choices this render resolves. */
  readonly settings: RenderSettings
  /** Absolute project root. */
  readonly project: string
  /** Two-digit episode number. */
  readonly episode: string
  /** Absolute path of the timeline to render. */
  readonly timelinePath: string
  /** Absolute path of the subtitle to burn. */
  readonly subtitleSrt: string
  /** The last body shot this render delivers. */
  readonly lastShot: number
  /** Absolute path of the BGM bed. */
  readonly bgm: string
  /** Optional declared segment plan; never substitutes for listening review. */
  readonly bgmPlan?: string
  /** Absolute path of the ending sound. */
  readonly endingAudio: string
  /** Absolute path of the ending effect video. */
  readonly endingEffect: string
  /** Absolute path of the file to write. */
  readonly output: string
  /** Whether the per-shot cache is ignored and every clip re-encoded. */
  readonly force: boolean
}

/** Fail loud when one required input is not a readable file. */
async function requireFile(path: string, label: string, fix: string): Promise<void> {
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    throw new Error(`${label}不存在或不可读：${path}。${fix}`)
  }
  if (size === 0) throw new Error(`${label}是空文件：${path}。${fix}`)
}

/** One line of the concat list, in the form the concat demuxer reads. */
function concatLine(path: string): string {
  return `file '${path.split('\\').join('/')}'`
}

/** Read the delivered file's measurable facts. */
async function measure(toolkit: MediaToolkit, output: string): Promise<MediaFacts> {
  const probed = await probeMedia(toolkit, output)
  const video = firstStreamOfType(probed, 'video')
  const audio = firstStreamOfType(probed, 'audio')
  return {
    durationSeconds: probed.durationSeconds,
    sizeBytes: probed.sizeBytes,
    bitrateBps: probed.bitRateBps,
    videoCodec: video?.codecName ?? '',
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: frameRateOf(video),
    hasAudio: audio !== undefined,
    audioCodec: audio?.codecName ?? '',
    audioSampleRate: audio?.sampleRate ?? 0,
  }
}

/** Render one line of the render log for a verdict. */
function logCheck(check: RenderCheck): string {
  return `check ${check.id} ${check.ok ? 'ok' : 'FAILED'} ${check.detail}`
}

/**
 * Encode one episode into the delivered file and judge the result.
 * @param input - The resolved call.
 * @returns The canonical result; `ok` is false when a delivery check failed.
 * @throws {Error} When an input is missing, a command fails, or the tail frame cannot be proved.
 */
export async function renderEpisode(input: RenderInput): Promise<DramaRenderReport> {
  const { toolkit, settings } = input
  const paths = episodePaths(input.project, input.episode)
  const timeline = await readTimeline(input.timelinePath)
  const clips = selectBodyClips(timeline, input.lastShot)
  const selectedVideos = clips.map(clip => resolve(paths.videoDir, shotFileName(clip.shot)))
  await assertVideosAllowed(input.project, [...selectedVideos, input.endingEffect])
  const bodyEndSeconds = bodyEndSecondsOf(clips)
  const totalSeconds = bodyEndSeconds + ENDING_SECONDS
  const expectedDurationSeconds = Number(totalSeconds.toFixed(6))

  await requireFile(paths.masterAudio, '整集原声 master', '请先跑 prepare 生成 audio/<集>.wav。')
  await requireFile(input.bgm, 'BGM', '请给出这部剧实际使用的 BGM 文件路径。')
  await requireFile(input.endingAudio, '片尾音', '请给出片尾音文件路径（技能 assets 目录下的 ending_audio.mp3）。')
  await requireFile(input.endingEffect, '片尾特效', '请给出片尾特效文件路径（技能 assets 目录下的 ending_effect.mp4）。')

  const bgmPlan = await readBgmPlan(input.bgmPlan, input.episode, bodyEndSeconds, input.bgm, input.project)
  const choice = await chooseEncoder(toolkit, settings.preferNvenc)
  const gpuUsed = choice.encoder !== 'libx264'
  await mkdir(paths.cacheDir, { recursive: true })
  await mkdir(dirname(input.output), { recursive: true })

  const log: string[] = [
    `episode=${input.episode}`,
    `project=${input.project}`,
    `bgm_plan=${JSON.stringify(bgmPlan)}`,
    `encoder=${choice.encoder} gpu_requested=${String(settings.preferNvenc)} gpu_used=${String(gpuUsed)}`,
    `encoder_fallback_reason=${choice.fallbackReason === '' ? '(none)' : choice.fallbackReason}`,
    `body_end_seconds=${bodyEndSeconds.toFixed(6)} ending_seconds=${ENDING_SECONDS.toFixed(3)} `
      + `expected_duration_seconds=${expectedDurationSeconds.toFixed(6)}`,
    `target_bitrate=${TARGET_BITRATE} max_bitrate=${MAX_BITRATE} min_bitrate_bps=${String(MIN_BITRATE_BPS)}`,
  ]

  const scaleFilter = deliveryScaleFilter()
  const encodedShots: number[] = []
  const reusedShots: number[] = []
  const segments: string[] = []
  const consumedHashes: string[] = [await fileSha256(input.endingEffect)]
  for (const clip of clips) {
    const source = resolve(paths.videoDir, shotFileName(clip.shot))
    await requireFile(source, `镜头 ${String(clip.shot)} 的渲染输入`,
      `请先跑 prepare，把该镜的成片放进 video/${input.episode}/。`)
    const target = resolve(paths.cacheDir, shotFileName(clip.shot))
    const args = [
      '-y', '-v', 'error', '-i', source,
      '-t', (clip.durationUs / MICROSECONDS_PER_SECOND).toFixed(6),
      '-vf', scaleFilter, '-an', '-c:v', choice.encoder, ...choice.args, target,
    ]
    const sourceHash = await fileSha256(source)
    consumedHashes.push(sourceHash)
    await assertVideoHashesAllowed(input.project, [sourceHash])
    const identity = JSON.stringify([sourceHash, toolkit.ffmpeg, args])
    const sidecar = `${target}.identity`
    if (!input.force && await pathExists(target) && await readCacheIdentity(sidecar) === identity) {
      reusedShots.push(clip.shot)
    } else {
      await rm(sidecar, { force: true })
      await runFfmpeg(toolkit, args)
      await requireFile(target, '编码缓存', '请重跑 render。')
      if (await fileSha256(source) !== sourceHash) throw new Error(`编码期间源视频发生变化：${source}。请重跑 render。`)
      await writeFile(sidecar, identity, 'utf8')
      encodedShots.push(clip.shot)
    }
    await assertVideosAllowed(input.project, [target])
    consumedHashes.push(await fileSha256(target))
    segments.push(target)
  }
  log.push(`encoded_shots=${encodedShots.join(',') || '(none)'} reused_shots=${reusedShots.join(',') || '(none)'}`)

  const tailFrame = await extractTailFrame(
    toolkit,
    resolve(paths.videoDir, shotFileName(input.lastShot)),
    resolve(paths.cacheDir, 'last_video_tail_frame.png'),
  )
  log.push(`tail_frame=${tailFrame.path} frame_md5=${tailFrame.frameMd5} `
    + `sequential_tail_md5=${tailFrame.sequentialTailMd5} `
    + `from_sequential_decode=${String(tailFrame.fromSequentialDecode)}`)
  const ending = resolve(paths.cacheDir, 'ending.mp4')
  await buildEndingClip(toolkit, tailFrame.path, input.endingEffect, ending, choice.encoder, choice.args)
  consumedHashes.push(await fileSha256(ending))
  await assertVideoHashesAllowed(input.project, consumedHashes)
  segments.push(ending)

  const concatFile = resolve(paths.cacheDir, 'concat.txt')
  await writeFile(concatFile, `${segments.map(concatLine).join('\n')}\n`, 'utf8')
  const base = resolve(paths.cacheDir, 'base.mp4')
  await runFfmpeg(toolkit, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', base])

  const cues = await readSubtitleCues(input.subtitleSrt)
  const ass = resolve(paths.cacheDir, 'display.ass')
  await writeFile(ass, `\ufeff${buildAssDocument(cues)}`, 'utf8')
  const subtitled = resolve(paths.cacheDir, 'subtitled.mp4')
  await runFfmpeg(toolkit, [
    '-y', '-v', 'error', '-i', base, '-vf', subtitleBurnFilter(ass, settings.fontsDir),
    '-an', '-c:v', choice.encoder, ...choice.args, subtitled,
  ])

  consumedHashes.push(await fileSha256(subtitled))
  await assertVideoHashesAllowed(input.project, consumedHashes)
  await assertVideosAllowed(input.project, [...selectedVideos, ...segments, subtitled, input.endingEffect])
  const staging = await mkdtemp(resolve(dirname(input.output), '.drama-render-'))
  const stagedOutput = resolve(staging, 'output.mp4')
  try {
    await runFfmpeg(toolkit, [
      '-y', '-v', 'error', '-i', subtitled, '-i', paths.masterAudio,
      '-stream_loop', '-1', '-i', input.bgm, '-i', input.endingAudio,
      '-filter_complex', audioMixFilter({
        bodyEndSeconds,
        totalSeconds,
        endingSeconds: ENDING_SECONDS,
        masterVolume: settings.masterVolume,
        bgmVolume: settings.bgmVolume,
      }),
      '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', stagedOutput,
    ])
    consumedHashes.push(await fileSha256(stagedOutput))
    await withFileLock(resolve(input.project, 'video-bans.json'), async () => {
      await assertVideoHashesAllowed(input.project, consumedHashes)
      await rename(stagedOutput, input.output)
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  await writeFile(paths.renderLog, `${log.join('\n')}\n`, 'utf8')
  const media = await measure(toolkit, input.output)
  const checks = deliveryChecks(media, expectedDurationSeconds)
  log.push(`output=${input.output} size_bytes=${String(media.sizeBytes)} `
    + `bitrate_bps=${String(media.bitrateBps)} duration_seconds=${media.durationSeconds.toFixed(6)}`)
  log.push(...checks.map(logCheck))
  await appendFile(paths.renderLog, `${log.join('\n')}\n`, 'utf8')

  // The record that answers "made from what, checked against which file". It keeps the
  // output's own digest beside the digests consumed, so replacing the delivery at the
  // same path leaves this record describing bytes that are no longer there — and
  // `verify` reports that instead of letting these checks stand in for a newer file.
  const provenancePath = provenancePathFor(input.output)
  await writeProvenance(provenancePath, buildProvenance({
    episode: input.episode,
    output: input.output,
    outputSha256: await fileSha256(input.output),
    sizeBytes: media.sizeBytes,
    durationSeconds: media.durationSeconds,
    inputs: consumedHashes,
    encoder: choice.encoder,
    checks,
    now: new Date(),
  }))

  const sources = new Map(clips.map(clip => [clip.shot, resolve(paths.videoDir, shotFileName(clip.shot))]))
  const reportInput: ReportInput = {
    method: 'render',
    bgmPlan,
    project: input.project,
    episode: input.episode,
    timeline: { clips, bodyEndSeconds },
    sources,
    expectedDurationSeconds,
    written: [input.output, provenancePath, paths.renderLog],
    output: input.output,
    encoder: choice.encoder,
    gpuRequested: settings.preferNvenc,
    gpuUsed,
    encoderFallbackReason: choice.fallbackReason,
    encodedShots,
    reusedShots,
    tailFrame,
    media,
    checks,
    warnings: tailFrame.fromSequentialDecode
      ? ['sseof 抽到的帧不是真实尾帧，已改用顺序解码的最后一帧作为片尾定格（见 tail_frame 字段）。']
      : [],
    logPath: paths.renderLog,
  }
  return buildReport(reportInput)
}
