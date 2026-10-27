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

import { appendFile, link, mkdir, mkdtemp, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dirname, parse, resolve } from 'node:path'
import { audioMixReport, loadAudioMixProfile, requireNewAudioOutput, requireProjectAudioFile } from './audio.ts'
import { readBgmPlan } from './bgm.ts'
import { fileSha256, readCacheIdentity } from './cache.ts'
import { buildSourceRecord, sourceRecordPathFor, writeSourceRecord } from './source-record.ts'
import {
  audioMixFilter,
  deliveryRenderSettings,
  deliveryScaleFilter,
  ENDING_AUDIO_ASSET,
  ENDING_EFFECT_ASSET,
  MAX_BITRATE,
  MIN_BITRATE_BPS,
  subtitleBurnFilter,
  TARGET_BITRATE,
} from './delivery.ts'
import { assertBodyOnlyAnimation, resolveDeliveryPolicy } from './delivery-policy.ts'
import { chooseEncoder } from './encoder.ts'
import {
  buildEndingClip,
  extractTailFrame,
  requireEndingAssetFile,
  requireEndingEffectFits,
  requireShippedEndingAsset,
} from './ending.ts'
import { mediaFactsOf, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodePaths, pathExists, shotFileName } from './paths.ts'
import { buildRenderPreview, renderPreviewWarnings } from './preview.ts'
import { buildReport, NO_TAIL_FRAME, type ReportInput } from './report.ts'
import { subtitleReviewWarnings, subtitleTextWarnings, readSubtitleCues, buildAssDocument } from './subtitles.ts'
import { bodyEndSecondsOf, readTimeline, selectBodyClips } from './timeline.ts'
import type { DramaRenderReport, MediaFacts, MediaToolkit, RenderCheck, RenderSettings } from './types.ts'
import { deliveryChecks } from './verify.ts'
import { assertVideoHashesAllowed, assertVideosAllowed } from './video.ts'
import { resolveSubtitleOverlay } from './subtitle-plan.ts'
import type { EndingEffectTiming } from './types.ts'
import { measureSubtitleLayout } from './subtitle-layout.ts'

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
  /** Optional explicit source-bound subtitle-overlay plan. */
  readonly subtitlePlan?: string
  /** The last body shot this render delivers. */
  readonly lastShot: number
  /** Absolute path of the BGM bed. */
  readonly bgm?: string
  /** Optional declared segment plan; never substitutes for listening review. */
  readonly bgmPlan?: string
  /** Explicit project-owned audio profile; omission retains legacy behavior. */
  readonly mixProfile?: string
  /** Absolute path of the ending sound. */
  readonly endingAudio?: string
  /** Absolute path of the ending effect video. */
  readonly endingEffect?: string
  /** Absolute path of the file to write. */
  readonly output: string
  /** Whether the per-shot cache is ignored and every clip re-encoded. */
  readonly force: boolean
}

/** Demand ending paths only after the explicit medium has selected a marked delivery. */
function requiredEndingPaths(input: RenderInput): { audio: string; effect: string } {
  if (input.endingAudio === undefined) {
    throw new Error('drama_render render 需要 endingAudio：写实或旧版交付需要随包片尾音 assets/ending_audio.mp3。')
  }
  if (input.endingEffect === undefined) {
    throw new Error('drama_render render 需要 endingEffect：写实或旧版交付需要随包片尾特效 assets/ending_effect.mp4。')
  }
  return { audio: input.endingAudio, effect: input.endingEffect }
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
  return mediaFactsOf(await probeMedia(toolkit, output))
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
  const subtitleWarnings = await subtitleReviewWarnings(input.subtitleSrt)
  const timeline = await readTimeline(input.timelinePath)
  const policy = await resolveDeliveryPolicy(input.project, timeline.delivery)
  const effectiveSettings = deliveryRenderSettings(settings, policy.delivery)
  assertBodyOnlyAnimation(timeline, policy)
  const endingAssets = policy.endingSeconds === 0 ? undefined : requiredEndingPaths(input)
  const clips = selectBodyClips(timeline, input.lastShot)
  const selectedVideos = clips.map(clip => resolve(paths.videoDir, shotFileName(clip.shot)))
  await assertVideosAllowed(input.project, [...selectedVideos, ...(endingAssets === undefined ? [] : [endingAssets.effect])])
  const bodyEndSeconds = bodyEndSecondsOf(clips)
  const totalSeconds = bodyEndSeconds + policy.endingSeconds
  const expectedDurationSeconds = Number(totalSeconds.toFixed(6))
  const overlay = input.subtitlePlan === undefined ? undefined : await resolveSubtitleOverlay({
    project: input.project, episode: input.episode, timeline: { ...timeline, clips, bodyEndSeconds },
    subtitleSrt: input.subtitleSrt, planPath: input.subtitlePlan,
  })

  const profile = input.mixProfile === undefined ? undefined
    : await loadAudioMixProfile(input.project, input.mixProfile, effectiveSettings)
  const bgm = profile?.mode === 'no_bgm' ? undefined : input.bgm
  if (bgm === undefined && profile?.mode !== 'no_bgm') {
    throw new Error('drama_render render 需要 bgm；无新增配乐请显式使用 no_bgm 音频配置。')
  }
  const musicStem = profile !== undefined && bgm !== undefined
    ? resolve(dirname(input.output), `${parse(input.output).name}.music-stem.wav`) : ''
  if (profile !== undefined) {
    await requireProjectAudioFile(input.project, paths.masterAudio)
    if (bgm !== undefined) await requireProjectAudioFile(input.project, bgm)
    await requireNewAudioOutput(input.project, input.output)
    await requireNewAudioOutput(input.project, sourceRecordPathFor(input.output))
    if (musicStem) await requireNewAudioOutput(input.project, musicStem)
  }

  await requireFile(paths.masterAudio, '整集原声 master', '请先跑 prepare 生成 audio/<集>.wav。')
  if (bgm !== undefined) await requireFile(bgm, 'BGM', '请给出这部剧实际使用的 BGM 文件路径。')
  if (endingAssets !== undefined) {
    await requireEndingAssetFile(endingAssets.audio, ENDING_AUDIO_ASSET, ENDING_EFFECT_ASSET)
    await requireEndingAssetFile(endingAssets.effect, ENDING_EFFECT_ASSET, ENDING_AUDIO_ASSET)
  }

  const bgmPlan = await readBgmPlan(bgm === undefined ? undefined : input.bgmPlan,
    input.episode, bodyEndSeconds, bgm ?? '', input.project)
  const preview = buildRenderPreview({ settings: effectiveSettings, delivery: profile === undefined ? policy.delivery
    : { ...policy.delivery, audio: { master_gain: profile.original_gain, bgm_gain: profile.music_gain } },
  subtitle: overlay?.report.resolved_srt ?? input.subtitleSrt, master: paths.masterAudio, ...(bgm === undefined ? {} : { bgm }),
  ...(bgm === undefined || input.bgmPlan === undefined ? {} : { bgmPlan: input.bgmPlan }) })
  const previewWarnings = renderPreviewWarnings(preview, profile?.mode !== 'no_bgm')
  // Every input is judged before the first media command runs, so a substituted
  // ending asset or an over-long effect costs nothing but the message.
  let endingTiming: EndingEffectTiming | undefined
  if (endingAssets !== undefined) {
    await requireShippedEndingAsset(endingAssets.audio, ENDING_AUDIO_ASSET)
    await requireShippedEndingAsset(endingAssets.effect, ENDING_EFFECT_ASSET)
    endingTiming = await requireEndingEffectFits(toolkit, endingAssets.effect, timeline.endingEffectFit)
  }
  const choice = await chooseEncoder(toolkit, settings.preferNvenc, policy.delivery.fps)
  const gpuUsed = choice.encoder !== 'libx264'
  await mkdir(paths.cacheDir, { recursive: true })
  await mkdir(dirname(input.output), { recursive: true })

  const log: string[] = [
    `episode=${input.episode}`,
    `project=${input.project}`,
    `bgm_plan=${JSON.stringify(bgmPlan)}`,
    `render_preview=${JSON.stringify(preview)}`,
    ...(timeline.endingEffectFit === undefined ? [] : [`ending_effect=${JSON.stringify(endingTiming)}`]),
    ...(overlay === undefined ? [] : [`subtitle_overlay=${JSON.stringify(overlay.report)}`]),
    `delivery=${JSON.stringify(policy.delivery)} add_watermark=${String(policy.addWatermark)}`,
    ...policy.warnings.map(warning => `warning=${warning}`),
    ...previewWarnings.map(warning => `warning=${warning}`),
    `encoder=${choice.encoder} gpu_requested=${String(settings.preferNvenc)} gpu_used=${String(gpuUsed)}`,
    `encoder_fallback_reason=${choice.fallbackReason === '' ? '(none)' : choice.fallbackReason}`,
    `body_end_seconds=${bodyEndSeconds.toFixed(6)} ending_seconds=${policy.endingSeconds.toFixed(3)} `
      + `expected_duration_seconds=${expectedDurationSeconds.toFixed(6)}`,
    `target_bitrate=${TARGET_BITRATE} max_bitrate=${MAX_BITRATE} min_bitrate_bps=${String(MIN_BITRATE_BPS)}`,
  ]

  const scaleFilter = deliveryScaleFilter('yuv420p', policy.delivery)
  const encodedShots: number[] = []
  const reusedShots: number[] = []
  const segments: string[] = []
  const consumedHashes: string[] = endingAssets === undefined ? [] : [await fileSha256(endingAssets.effect)]
  for (const clip of clips) {
    const source = resolve(paths.videoDir, shotFileName(clip.shot))
    await requireFile(source, `镜头 ${String(clip.shot)} 的渲染输入`,
      `请先跑 prepare，把该镜的成片放进 video/${input.episode}/。`)
    const target = resolve(paths.cacheDir, shotFileName(clip.shot))
    const args = [
      '-y', '-v', 'error', '-i', source,
      '-t', (clip.durationUs / MICROSECONDS_PER_SECOND).toFixed(6),
      '-vf', scaleFilter, '-an', '-r', String(policy.delivery.fps), '-c:v', choice.encoder, ...choice.args, target,
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

  let tailFrame = NO_TAIL_FRAME
  if (endingAssets !== undefined) {
    tailFrame = await extractTailFrame(
      toolkit,
      resolve(paths.videoDir, shotFileName(input.lastShot)),
      resolve(paths.cacheDir, 'last_video_tail_frame.png'),
    )
    log.push(`tail_frame=${tailFrame.path} frame_md5=${tailFrame.frameMd5} `
      + `sequential_tail_md5=${tailFrame.sequentialTailMd5} `
      + `from_sequential_decode=${String(tailFrame.fromSequentialDecode)}`)
    const ending = resolve(paths.cacheDir, 'ending.mp4')
    await buildEndingClip(toolkit, tailFrame.path, endingAssets.effect, ending, choice.encoder, choice.args, policy.delivery, endingTiming)
    consumedHashes.push(await fileSha256(ending))
    await assertVideoHashesAllowed(input.project, consumedHashes)
    segments.push(ending)
  }

  const concatFile = resolve(paths.cacheDir, 'concat.txt')
  await writeFile(concatFile, `${segments.map(concatLine).join('\n')}\n`, 'utf8')
  const base = resolve(paths.cacheDir, 'base.mp4')
  await runFfmpeg(toolkit, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', base])

  const cues = overlay?.cues ?? await readSubtitleCues(input.subtitleSrt)
  subtitleWarnings.push(...(overlay?.warnings ?? []), ...subtitleTextWarnings(cues))
  const layout = policy.delivery.subtitle_visual?.schema_version === 1
    ? await measureSubtitleLayout({ toolkit, settings: effectiveSettings, delivery: policy.delivery, cues, directory: paths.cacheDir })
    : undefined
  if (layout !== undefined) {
    subtitleWarnings.push(...layout.warnings)
    log.push(`subtitle_layout=${layout.report.report_path ?? '(not saved)'} status=${layout.report.status}`)
  }
  const ass = resolve(paths.cacheDir, 'display.ass')
  await writeFile(ass, `\ufeff${buildAssDocument(cues, settings, policy)}`, 'utf8')
  const subtitled = resolve(paths.cacheDir, 'subtitled.mp4')
  await runFfmpeg(toolkit, [
    '-y', '-v', 'error', '-i', base, '-t', totalSeconds.toFixed(6),
    '-vf', subtitleBurnFilter(ass, settings.fontsDir, policy.delivery),
    '-an', '-r', String(policy.delivery.fps), '-c:v', choice.encoder, ...choice.args, subtitled,
  ])

  consumedHashes.push(await fileSha256(subtitled))
  await assertVideoHashesAllowed(input.project, consumedHashes)
  await assertVideosAllowed(input.project, [
    ...selectedVideos, ...segments, subtitled, ...(endingAssets === undefined ? [] : [endingAssets.effect]),
  ])
  const staging = await mkdtemp(resolve(dirname(input.output), '.drama-render-'))
  const stagedOutput = resolve(staging, 'output.mp4')
  const stagedStem = resolve(staging, 'music-stem.wav')
  try {
    await runFfmpeg(toolkit, [
      '-y', '-v', 'error', '-i', subtitled, '-i', paths.masterAudio,
      ...(bgm === undefined ? [] : ['-stream_loop', '-1', '-i', bgm]),
      ...(endingAssets === undefined ? [] : ['-i', endingAssets.audio]),
      '-filter_complex', audioMixFilter({
        bodyEndSeconds,
        totalSeconds,
        endingSeconds: policy.endingSeconds,
        masterVolume: effectiveSettings.masterVolume,
        bgmVolume: effectiveSettings.bgmVolume,
        ...(profile === undefined ? {} : { profile, musicStem: Boolean(musicStem), endingInput: bgm === undefined ? 2 : 3 }),
      }),
      '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', stagedOutput,
      ...(musicStem ? ['-map', '[musicstem]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', stagedStem] : []),
    ])
    consumedHashes.push(await fileSha256(stagedOutput))
    await withFileLock(resolve(input.project, 'video-bans.json'), async () => {
      await assertVideoHashesAllowed(input.project, consumedHashes)
      if (profile === undefined) {
        await rename(stagedOutput, input.output)
      } else {
        const published: string[] = []
        try {
          const pairs: [string, string][] = [[stagedOutput, input.output]]
          if (musicStem) pairs.push([stagedStem, musicStem])
          for (const [source, target] of pairs) {
            await link(source, target)
            published.push(target)
          }
        } catch (error) {
          for (const target of published.reverse()) await unlink(target)
          throw error
        }
      }
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  await writeFile(paths.renderLog, `${log.join('\n')}\n`, 'utf8')
  const media = await measure(toolkit, input.output)
  const checks = deliveryChecks(media, expectedDurationSeconds, policy.delivery)
  log.push(`output=${input.output} size_bytes=${String(media.sizeBytes)} `
    + `bitrate_bps=${String(media.bitrateBps)} duration_seconds=${media.durationSeconds.toFixed(6)}`)
  log.push(...checks.map(logCheck))
  await appendFile(paths.renderLog, `${log.join('\n')}\n`, 'utf8')

  // The record that answers "made from what, checked against which file". It keeps the
  // output's own digest beside the digests consumed, so replacing the delivery at the
  // same path leaves this record describing bytes that are no longer there — and
  // `verify` reports that instead of letting these checks stand in for a newer file.
  const sourceRecordPath = sourceRecordPathFor(input.output)
  await writeSourceRecord(sourceRecordPath, buildSourceRecord({
    episode: input.episode,
    output: input.output,
    outputSha256: await fileSha256(input.output),
    sizeBytes: media.sizeBytes,
    durationSeconds: media.durationSeconds,
    inputs: [...consumedHashes, ...(overlay === undefined ? [] : [overlay.report.plan_sha256,
      overlay.report.original_srt_sha256, overlay.report.resolved_srt_sha256])],
    encoder: choice.encoder,
    checks,
    now: new Date(),
  }))

  const sources = new Map(clips.map(clip => [clip.shot, resolve(paths.videoDir, shotFileName(clip.shot))]))
  const reportInput: ReportInput = {
    method: 'render',
    bgmPlan,
    renderPreview: preview,
    ...(layout === undefined ? {} : { subtitleLayout: layout.report }),
    ...(overlay === undefined ? {} : { subtitleOverlay: overlay.report }),
    ...(timeline.endingEffectFit === undefined || endingTiming === undefined ? {} : { endingEffect: endingTiming }),
    project: input.project,
    episode: input.episode,
    timeline: { clips, bodyEndSeconds, delivery: policy.delivery },
    sources,
    expectedDurationSeconds,
    written: [input.output, ...(musicStem ? [musicStem] : []), sourceRecordPath, paths.renderLog,
      ...overlay?.written ?? [], ...layout?.written ?? []],
    ...(profile === undefined ? {} : { audioMix: audioMixReport(profile, paths.masterAudio, bgm ?? '', musicStem) }),
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
    warnings: [...subtitleWarnings, ...policy.warnings, ...previewWarnings, ...(tailFrame.fromSequentialDecode
      ? ['sseof 抽到的帧不是真实尾帧，已改用顺序解码的最后一帧作为片尾定格（见 tail_frame 字段）。']
      : [])],
    logPath: paths.renderLog,
  }
  return buildReport(reportInput)
}
