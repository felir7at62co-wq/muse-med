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

import { appendFile, link, lstat, mkdir, mkdtemp, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dirname, resolve } from 'node:path'
import { audioMixReport, loadAudioMixProfile, requireNewAudioOutput, requireProjectAudioFile } from './audio.ts'
import { readBgmPlan } from './bgm.ts'
import { fileSha256, readCacheIdentity } from './cache.ts'
import { buildSourceRecord, sourceRecordPathFor, writeSourceRecord, type DeliveryRenderInputs } from './source-record.ts'
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
import { firstStreamOfType, mediaFactsOf, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodePaths, pathExists, shotFileName } from './paths.ts'
import { parseShotManifest, readJsonDocument, pictureClockFrames, verifyPreparedSubtitleClock } from './prepare.ts'
import { verifySelectedSourceReviews } from './approved-sources.ts'
import { summarizeSourceQa, type SourceQaVerifier } from './source-qa.ts'
import { buildRenderPreview, renderPreviewWarnings } from './preview.ts'
import { buildReport, NO_MEDIA, NO_TAIL_FRAME, type ReportInput } from './report.ts'
import { subtitleReviewWarnings, subtitleTextWarnings, readSubtitleCues, buildAssDocument, formatSrtDocument, normalizeSubtitleDisplay, subtitleDisplayWarnings } from './subtitles.ts'
import { bodyEndSecondsOf, readTimeline, selectBodyClips } from './timeline.ts'
import type { DramaRenderReport, MediaFacts, MediaToolkit, RenderCheck, RenderSettings } from './types.ts'
import { deliveryChecks } from './verify.ts'
import { assertVideoHashesAllowed, assertVideosAllowed } from './video.ts'
import { resolveSubtitleOverlay } from './subtitle-plan.ts'
import { writeDerivedSubtitleClock } from './subtitle-clock.ts'
import type { EndingEffectTiming } from './types.ts'
import { measureSubtitleLayout, subtitleVisualChecks } from './subtitle-layout.ts'
import { assertRenderResumeDirectory, assertRenderResumeInputs, findRenderResumeCandidate, readRenderResumeFile,
  renderMusicStem, renderResumeRequest, type RenderResumeRequest } from './render-resume.ts'

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
  /** Optional composer receipt for the actual rendered BGM. */
  readonly bgmGeneration?: string
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
  /** Whether to verify and reuse a matching candidate or publish a new one exclusively. */
  readonly resume?: boolean
  /** Host access to actual OCR execution and durable visual observation evidence. */
  readonly sourceQaVerifier?: SourceQaVerifier
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
  if (input.resume === true) await assertRenderResumeDirectory(input.project, dirname(input.output))
  const captured = input.resume === true ? await Promise.all([
    readRenderResumeFile(resolve(input.project, 'project_config.json'), true),
    readRenderResumeFile(input.timelinePath), readRenderResumeFile(input.subtitleSrt),
    ...[input.mixProfile, input.subtitlePlan].flatMap(path => path === undefined ? [] : [readRenderResumeFile(path)]),
  ]) : undefined
  const subtitleWarnings = await subtitleReviewWarnings(input.subtitleSrt)
  const timeline = await readTimeline(input.timelinePath, settings.enforceSubtitleVisual)
  await verifyPreparedSubtitleClock(input.subtitleSrt, paths, timeline)
  const endingEffectFit = timeline.endingEffectFit ?? settings.defaultEndingEffectFit
  const policy = await resolveDeliveryPolicy(
    input.project, timeline.delivery, settings.defaultSubtitleVisual, settings.enforceSubtitleVisual,
  )
  const effectiveSettings = deliveryRenderSettings(settings, policy.delivery)
  assertBodyOnlyAnimation(timeline, policy)
  const endingAssets = policy.endingSeconds === 0 ? undefined : requiredEndingPaths(input)
  const clips = selectBodyClips(timeline, input.lastShot)
  if (captured !== undefined && clips.length !== timeline.clips.length) {
    throw new Error('drama_render render 的 resume 只支持完整单集时间线。')
  }
  const selectedVideos = clips.map(clip => resolve(paths.videoDir, shotFileName(clip.shot)))
  const sourceQa = policy.delivery.require_source_review !== true ? undefined : await (async () => {
    const document = await readJsonDocument(paths.sources, '已准备选源')
    const rows = parseShotManifest(document, paths.sources)
    const reviews = await verifySelectedSourceReviews(paths, rows, true, true, input.sourceQaVerifier)
    const approved = new Map(reviews.map(review => [review.shot, review]))
    const prepared = document as { shots: { shot: number; sha256?: string; review_sha256?: string; audio_sha256?: string }[] }
    if (rows.length !== clips.length || prepared.shots.some((row) => {
      const review = approved.get(row.shot)
      return review === undefined || row.sha256 !== review.videoSha256 || row.review_sha256 !== review.reviewSha256
        || row.audio_sha256 !== review.audioSha256 || !clips.some(clip => clip.shot === row.shot)
    })) throw new Error('正式渲染的选源或审核已变化，请重新 prepare 并复验。')
    for (const clip of clips) {
      if (await fileSha256(resolve(paths.videoDir, shotFileName(clip.shot))) !== approved.get(clip.shot)?.videoSha256) {
        throw new Error('正式渲染的镜头副本与已审看源片字节不符，请重新 prepare。')
      }
    }
    return summarizeSourceQa(reviews)
  })()
  await assertVideosAllowed(input.project, [...selectedVideos, ...(endingAssets === undefined ? [] : [endingAssets.effect])])
  const bodyEndSeconds = bodyEndSecondsOf(clips)
  const totalSeconds = bodyEndSeconds + policy.endingSeconds
  const expectedDurationSeconds = Number(totalSeconds.toFixed(6))
  const profile = input.mixProfile === undefined ? undefined
    : await loadAudioMixProfile(input.project, input.mixProfile, effectiveSettings)
  const bgm = profile?.mode === 'no_bgm' ? undefined : input.bgm
  if (bgm === undefined && profile?.mode !== 'no_bgm') {
    throw new Error('drama_render render 需要 bgm；无新增配乐请显式使用 no_bgm 音频配置。')
  }
  if (profile !== undefined) {
    await requireProjectAudioFile(input.project, paths.masterAudio)
    if (bgm !== undefined) await requireProjectAudioFile(input.project, bgm)
  }

  await requireFile(paths.masterAudio, '整集原声 master', '请先跑 prepare 生成 audio/<集>.wav。')
  if (bgm !== undefined) await requireFile(bgm, 'BGM', '请给出这部剧实际使用的 BGM 文件路径。')
  if (endingAssets !== undefined) {
    await requireEndingAssetFile(endingAssets.audio, ENDING_AUDIO_ASSET, ENDING_EFFECT_ASSET)
    await requireEndingAssetFile(endingAssets.effect, ENDING_EFFECT_ASSET, ENDING_AUDIO_ASSET)
    await requireShippedEndingAsset(endingAssets.audio, ENDING_AUDIO_ASSET)
    await requireShippedEndingAsset(endingAssets.effect, ENDING_EFFECT_ASSET)
  }

  const bgmPlan = await readBgmPlan(bgm === undefined ? undefined : input.bgmPlan,
    input.episode, bodyEndSeconds, bgm ?? '', input.project)
  const fps = policy.delivery.fps
  for (const clip of clips) {
    const source = resolve(paths.videoDir, shotFileName(clip.shot))
    await requireFile(source, `镜头 ${String(clip.shot)} 的渲染输入`,
      `请先跑 prepare，把该镜的成片放进 video/${input.episode}/。`)
    const media = await probeMedia(toolkit, source)
    const picture = firstStreamOfType(media, 'video')
    const available = picture === undefined ? undefined : pictureClockFrames(media, picture, fps)
    const requested = Math.round(clip.durationUs * fps / MICROSECONDS_PER_SECOND)
    if (available !== undefined && requested > available) {
      throw new Error(`镜头 ${clip.shot} 的时间线需要 ${requested} 帧，实际画面只有 ${available} 帧，可能在剪口重复末帧。请用同版素材重跑 prepare，`
        + '已生成字幕需要先以当前切点和同源对齐重建，再使用新时间线、整集原声和字幕渲染。')
    }
  }

  let resumeRequest: RenderResumeRequest | undefined
  const strictSpeech = policy.delivery.subtitle?.require_speech_coverage === true
  const strictMusic = policy.delivery.audio?.require_music_decision === true
  const music = !strictMusic ? undefined : {
    mode: bgm === undefined ? 'none' as const : 'music' as const,
    gain: bgm === undefined ? 0 : profile?.music_gain ?? effectiveSettings.bgmVolume,
    ...(input.bgmPlan === undefined ? {} : { plan_path: input.bgmPlan }),
    ...(bgm === undefined ? {} : { bed_path: bgm,
      ...(input.bgmGeneration === undefined ? {} : { generation_path: input.bgmGeneration }) }),
  }
  const emitsStem = profile !== undefined && bgm !== undefined
  let output = input.output
  if (captured !== undefined) {
    const more = [paths.masterAudio, ...selectedVideos, ...(strictSpeech || sourceQa !== undefined ? [paths.sources] : []),
      ...(sourceQa?.files.map(file => file.path) ?? []),
      ...(bgm === undefined ? [] : [bgm]),
      ...((strictMusic || bgm !== undefined) && input.bgmPlan !== undefined ? [input.bgmPlan] : []),
      ...(music?.generation_path === undefined ? [] : [music.generation_path]),
      ...(endingAssets === undefined ? [] : [endingAssets.audio, endingAssets.effect])]
    const files = [...captured, ...await Promise.all(more.map(file => readRenderResumeFile(file)))]
    if (sourceQa?.files.some(file => files.find(saved => saved.path === file.path)?.sha256 !== file.sha256)) {
      throw new Error('源片复验后文件发生变化，请重新执行OCR与审看核验。')
    }
    const { channel: _channel, ...effective } = effectiveSettings
    resumeRequest = renderResumeRequest(files, [input.project, input.episode, input.lastShot, effective, policy.delivery,
      policy.endingSeconds, policy.addWatermark, endingEffectFit, profile, input.subtitlePlan ?? null,
      input.mixProfile ?? null, bgm ?? null, bgm === undefined ? null : input.bgmPlan ?? null, ...(music === undefined ? [] : [music]),
      ...(sourceQa === undefined ? [] : [sourceQa.sha256]),
      endingAssets?.audio ?? null, endingAssets?.effect ?? null])
    await assertRenderResumeInputs(resumeRequest)
  }

  // Re-resolve an explicit overlay against the actual current sources so the draft can reuse the same decision.
  const overlay = input.subtitlePlan === undefined ? undefined : await resolveSubtitleOverlay({
    project: input.project, episode: input.episode, timeline: { ...timeline, clips, bodyEndSeconds },
    subtitleSrt: input.subtitleSrt, planPath: input.subtitlePlan,
    ...(settings.normalizeSubtitleText ? { normalizeDisplay: true } : {}),
  })
  if (sourceQa !== undefined && (overlay?.report.retained_embedded.length ?? 0) > 0) {
    throw new Error('严格统一字幕交付要求清理源片对白字，不能沿用retain_embedded对白。请按实际原片完成去字幕和源复验后重跑。')
  }
  const originalCues = overlay?.cues ?? await readSubtitleCues(input.subtitleSrt)
  if (settings.normalizeSubtitleText && overlay === undefined) subtitleWarnings.push(...subtitleDisplayWarnings(originalCues))
  const cues = settings.normalizeSubtitleText ? normalizeSubtitleDisplay(originalCues) : originalCues
  let displaySubtitle = overlay?.report.resolved_srt ?? input.subtitleSrt
  const displayWritten: string[] = []
  if (settings.normalizeSubtitleText && overlay === undefined) {
    await mkdir(paths.cacheDir, { recursive: true })
    const directory = await mkdtemp(resolve(paths.cacheDir, 'subtitle-display-'))
    displaySubtitle = resolve(directory, `${input.episode}.srt`)
    const displayText = formatSrtDocument(cues)
    const clock = await writeDerivedSubtitleClock(input.subtitleSrt, displaySubtitle, displayText)
    await writeFile(displaySubtitle, displayText, 'utf8')
    displayWritten.push(displaySubtitle)
    if (clock !== undefined) displayWritten.push(clock)
  }
  const renderedSubtitle = displaySubtitle
  let publicationRequest = resumeRequest === undefined || renderedSubtitle === input.subtitleSrt ? resumeRequest : {
    ...resumeRequest,
    files: [...resumeRequest.files, await readRenderResumeFile(renderedSubtitle)],
  }
  const preview = buildRenderPreview({ settings: effectiveSettings, delivery: profile === undefined ? policy.delivery
    : { ...policy.delivery, audio: { master_gain: profile.original_gain, bgm_gain: profile.music_gain } },
  subtitle: displaySubtitle, master: paths.masterAudio, ...(bgm === undefined ? {} : { bgm }),
  ...(bgm === undefined || input.bgmPlan === undefined ? {} : { bgmPlan: input.bgmPlan }) })
  const previewWarnings = renderPreviewWarnings(preview, profile?.mode !== 'no_bgm')
  subtitleWarnings.push(...(overlay?.warnings ?? []), ...subtitleTextWarnings(cues))
  if (resumeRequest !== undefined) await assertRenderResumeDirectory(input.project, paths.cacheDir)
  const layout = policy.delivery.subtitle_visual?.schema_version === 1
    ? await measureSubtitleLayout({ toolkit, settings: effectiveSettings, delivery: policy.delivery, cues, directory: paths.cacheDir })
    : undefined
  const layoutChecks = layout === undefined ? [] : subtitleVisualChecks(layout.report)
  if (layout !== undefined) subtitleWarnings.push(...layout.warnings)
  const layoutLog = layout === undefined ? []
    : [`subtitle_layout=${layout.report.report_path ?? '(not saved)'} status=${layout.report.status}`, ...layoutChecks.map(logCheck)]
  if (layout !== undefined && layoutChecks.some(check => !check.ok)) {
    await mkdir(dirname(paths.renderLog), { recursive: true })
    await writeFile(paths.renderLog, `${layoutLog.join('\n')}\n`, 'utf8')
    return buildReport({ method: 'render', project: input.project, episode: input.episode,
      timeline: { clips, bodyEndSeconds, delivery: policy.delivery },
      sources: new Map(clips.map(clip => [clip.shot, resolve(paths.videoDir, shotFileName(clip.shot))])),
      expectedDurationSeconds, renderPreview: preview, bgmPlan,
      ...(overlay === undefined ? {} : { subtitleOverlay: overlay.report }),
      subtitleLayout: layout.report,
      written: [...displayWritten, ...overlay?.written ?? [], ...layout.written, paths.renderLog],
      output: '', encoder: '', gpuRequested: settings.preferNvenc, gpuUsed: false, encoderFallbackReason: '',
      encodedShots: [], reusedShots: [], tailFrame: NO_TAIL_FRAME, media: NO_MEDIA, checks: layoutChecks,
      warnings: [...subtitleWarnings, ...policy.warnings, ...previewWarnings], logPath: paths.renderLog })
  }
  const visualVerification: DeliveryRenderInputs['subtitle_visual_verification'] = layout?.report.status === 'measured'
    && layout.report.report_path !== null && policy.delivery.subtitle_visual?.schema_version === 1 ? {
      version: 1, subtitle_sha256: await fileSha256(renderedSubtitle), report_path: layout.report.report_path,
      report_sha256: await fileSha256(layout.report.report_path), requested_font: layout.report.requested_font,
      delivery: { width: policy.delivery.width, height: policy.delivery.height, fps: policy.delivery.fps },
      visual: { ...policy.delivery.subtitle_visual, font_family: layout.report.requested_font },
      checks: layoutChecks.map(check => ({ id: check.id, ok: true })),
    } : undefined
  if (visualVerification !== undefined && publicationRequest !== undefined) {
    publicationRequest = { ...publicationRequest, files: [...publicationRequest.files,
      { path: visualVerification.report_path, sha256: visualVerification.report_sha256 }] }
  }
  if (publicationRequest !== undefined) {
    const candidate = await findRenderResumeCandidate({ toolkit, settings: effectiveSettings,
      project: input.project, episode: input.episode, timelinePath: input.timelinePath,
      subtitleSrt: renderedSubtitle, output, requireSubtitleVisualVerification: visualVerification !== undefined },
    publicationRequest, emitsStem)
    await assertRenderResumeInputs(publicationRequest)
    if (candidate.verified !== undefined) {
      return { ...candidate.verified, method: 'render', encoder: candidate.record.encoder,
        written: [...overlay?.written ?? [], ...displayWritten],
        ...(overlay === undefined ? {} : { subtitle_overlay: overlay.report }),
        ...(profile === undefined ? {} : { audio_mix: audioMixReport(profile, paths.masterAudio, bgm ?? '',
          emitsStem ? renderMusicStem(candidate.output) : '') }),
        warnings: [...candidate.verified.warnings, ...subtitleWarnings, ...overlay?.warnings ?? [],
          '已独立复核并复用与当前输入一致的成片。'] }
    }
    output = candidate.output
  }
  const musicStem = emitsStem ? renderMusicStem(output) : ''
  const sourceRecordPath = sourceRecordPathFor(output)
  if (profile !== undefined || resumeRequest !== undefined) {
    await requireNewAudioOutput(input.project, output)
    await requireNewAudioOutput(input.project, sourceRecordPath)
    if (musicStem) await requireNewAudioOutput(input.project, musicStem)
  }

  // Ending inputs are judged before body encoding, so a substituted
  // ending asset or an over-long effect costs nothing but the message.
  let endingTiming: EndingEffectTiming | undefined
  if (endingAssets !== undefined) {
    endingTiming = await requireEndingEffectFits(toolkit, endingAssets.effect, endingEffectFit)
  }
  const choice = await chooseEncoder(toolkit, settings.preferNvenc, policy.delivery.fps)
  const gpuUsed = choice.encoder !== 'libx264'
  await mkdir(paths.cacheDir, { recursive: true })
  const cacheDir = resumeRequest === undefined ? paths.cacheDir : await mkdtemp(resolve(paths.cacheDir, 'resume-'))
  const renderLog = resumeRequest === undefined ? paths.renderLog : resolve(cacheDir, 'render.log')
  await mkdir(dirname(output), { recursive: true })

  const log: string[] = [
    `episode=${input.episode}`,
    `project=${input.project}`,
    `bgm_plan=${JSON.stringify(bgmPlan)}`,
    `render_preview=${JSON.stringify(preview)}`,
    ...(endingEffectFit === undefined ? [] : [`ending_effect=${JSON.stringify(endingTiming)}`]),
    ...(overlay === undefined ? [] : [`subtitle_overlay=${JSON.stringify(overlay.report)}`]),
    `delivery=${JSON.stringify(policy.delivery)} add_watermark=${String(policy.addWatermark)}`,
    ...policy.warnings.map(warning => `warning=${warning}`),
    ...previewWarnings.map(warning => `warning=${warning}`),
    `encoder=${choice.encoder} gpu_requested=${String(settings.preferNvenc)} gpu_used=${String(gpuUsed)}`,
    `encoder_fallback_reason=${choice.fallbackReason === '' ? '(none)' : choice.fallbackReason}`,
    `body_end_seconds=${bodyEndSeconds.toFixed(6)} ending_seconds=${policy.endingSeconds.toFixed(3)} `
      + `expected_duration_seconds=${expectedDurationSeconds.toFixed(6)}`,
    `target_bitrate=${TARGET_BITRATE} max_bitrate=${MAX_BITRATE} min_bitrate_bps=${String(MIN_BITRATE_BPS)}`,
    ...layoutLog,
  ]

  const scaleFilter = deliveryScaleFilter('yuv420p', policy.delivery)
  const encodedShots: number[] = []
  const reusedShots: number[] = []
  const segments: string[] = []
  const consumedHashes: string[] = endingAssets === undefined ? [] : [await fileSha256(endingAssets.effect)]
  for (const clip of clips) {
    const source = resolve(paths.videoDir, shotFileName(clip.shot))
    const target = resolve(cacheDir, shotFileName(clip.shot))
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
      resolve(cacheDir, 'last_video_tail_frame.png'),
    )
    log.push(`tail_frame=${tailFrame.path} frame_md5=${tailFrame.frameMd5} `
      + `sequential_tail_md5=${tailFrame.sequentialTailMd5} `
      + `from_sequential_decode=${String(tailFrame.fromSequentialDecode)}`)
    const ending = resolve(cacheDir, 'ending.mp4')
    await buildEndingClip(toolkit, tailFrame.path, endingAssets.effect, ending, choice.encoder, choice.args, policy.delivery, endingTiming)
    consumedHashes.push(await fileSha256(ending))
    await assertVideoHashesAllowed(input.project, consumedHashes)
    segments.push(ending)
  }

  const concatFile = resolve(cacheDir, 'concat.txt')
  await writeFile(concatFile, `${segments.map(concatLine).join('\n')}\n`, 'utf8')
  const base = resolve(cacheDir, 'base.mp4')
  await runFfmpeg(toolkit, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', base])

  const ass = resolve(cacheDir, 'display.ass')
  await writeFile(ass, `\ufeff${buildAssDocument(cues, settings, policy)}`, 'utf8')
  const subtitled = resolve(cacheDir, 'subtitled.mp4')
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
  const staging = await mkdtemp(resolve(dirname(output), '.drama-render-'))
  const stagedOutput = resolve(staging, 'output.mp4')
  const stagedStem = resolve(staging, 'music-stem.wav')
  const stagedReceipt = resolve(staging, 'source-record.json')
  // The timeline, display, master and video entries were required captures in this render.
  const deliveryDigest = (request: RenderResumeRequest, path: string) =>
    (request.files.find(file => file.path === path) as { sha256: string }).sha256
  const receipt = (media: MediaFacts, checks: RenderCheck[], outputSha256: string, musicStemSha256?: string) => {
    const request = publicationRequest
    return buildSourceRecord({
      episode: input.episode, output, outputSha256, sizeBytes: media.sizeBytes, durationSeconds: media.durationSeconds,
      inputs: [...consumedHashes, ...(overlay === undefined ? [] : [overlay.report.plan_sha256,
        overlay.report.original_srt_sha256, overlay.report.resolved_srt_sha256]),
      ...(sourceQa === undefined ? [] : [sourceQa.sha256, ...sourceQa.files.map(file => file.sha256)])],
      ...(resumeRequest === undefined ? {} : { requestSha256: resumeRequest.sha256 }),
      ...(request === undefined ? {} : {
        inputFiles: request.files,
        deliveryInputs: {
          timeline_sha256: deliveryDigest(request, input.timelinePath),
          subtitle_sha256: deliveryDigest(request, renderedSubtitle),
          ...(sourceQa === undefined ? {} : { source_qa_sha256: sourceQa.sha256 }),
          ...(visualVerification === undefined ? {} : { subtitle_visual_verification: visualVerification }),
          ...(strictSpeech ? { subtitle_display: overlay === undefined ? 'external' as const : 'overlay' as const } : {}),
          ...(music === undefined ? {} : { music }),
          master_audio_sha256: deliveryDigest(request, paths.masterAudio),
          videos: clips.map(clip => ({ shot: clip.shot,
            sha256: deliveryDigest(request, resolve(paths.videoDir, shotFileName(clip.shot))) }))
            .sort((a, b) => a.shot - b.shot),
        },
      }),
      ...(musicStemSha256 === undefined ? {} : { musicStemSha256 }), encoder: choice.encoder, checks, now: new Date(),
    })
  }
  let measured: { media: MediaFacts; checks: RenderCheck[] } | undefined
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
    const outputSha256 = await fileSha256(stagedOutput)
    consumedHashes.push(outputSha256)
    if (resumeRequest !== undefined) {
      const media = await measure(toolkit, stagedOutput)
      const checks = deliveryChecks(media, expectedDurationSeconds, policy.delivery)
      measured = { media, checks }
      await writeSourceRecord(stagedReceipt, receipt(media, checks, outputSha256, musicStem ? await fileSha256(stagedStem) : undefined))
    }
    await withFileLock(resolve(input.project, 'video-bans.json'), async () => {
      await assertVideoHashesAllowed(input.project, consumedHashes)
      for (const file of sourceQa?.files ?? []) {
        if (await fileSha256(file.path) !== file.sha256) throw new Error('渲染期间源片复验文件已变化，须重新核验。')
      }
      if (publicationRequest !== undefined) await assertRenderResumeInputs(publicationRequest)
      if (profile === undefined && resumeRequest === undefined) {
        await rename(stagedOutput, output)
      } else {
        const published: [source: string, target: string][] = []
        try {
          const pairs: [string, string][] = [[stagedOutput, output]]
          if (musicStem) pairs.push([stagedStem, musicStem])
          if (resumeRequest !== undefined) pairs.push([stagedReceipt, sourceRecordPath])
          for (const [source, target] of pairs) {
            if (resumeRequest !== undefined) await requireNewAudioOutput(input.project, target)
            await link(source, target)
            published.push([source, target])
          }
        } catch (error) {
          for (const [source, target] of published.reverse()) {
            if (resumeRequest !== undefined) {
              const [original, current] = await Promise.all([lstat(source), lstat(target).catch(() => undefined)])
              if (current === undefined || original.dev !== current.dev || original.ino !== current.ino) continue
            }
            await unlink(target)
          }
          throw error
        }
      }
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  await writeFile(renderLog, `${log.join('\n')}\n`, 'utf8')
  const media = measured?.media ?? await measure(toolkit, output)
  const checks = [...layoutChecks, ...(measured?.checks ?? deliveryChecks(media, expectedDurationSeconds, policy.delivery))]
  log.push(`output=${output} size_bytes=${String(media.sizeBytes)} `
    + `bitrate_bps=${String(media.bitrateBps)} duration_seconds=${media.durationSeconds.toFixed(6)}`)
  log.push(...checks.map(logCheck))
  await appendFile(renderLog, `${log.join('\n')}\n`, 'utf8')

  // The record that answers "made from what, checked against which file". It keeps the
  // output's own digest beside the digests consumed, so replacing the delivery at the
  // same path leaves this record describing bytes that are no longer there — and
  // `verify` reports that instead of letting these checks stand in for a newer file.
  if (resumeRequest === undefined) await writeSourceRecord(sourceRecordPath, receipt(media, checks, await fileSha256(output)))
  if (resumeRequest !== undefined) {
    const intermediates = [concatFile, base, subtitled, ass, ...segments,
      ...clips.map(clip => resolve(cacheDir, `${shotFileName(clip.shot)}.identity`))]
    const removed = await Promise.allSettled(intermediates.map(path => rm(path, { force: true })))
    if (removed.some(result => result.status === 'rejected')) subtitleWarnings.push(`续跑候选已保存。部分中间文件保留在 ${cacheDir}。`)
  }

  const sources = new Map(clips.map(clip => [clip.shot, resolve(paths.videoDir, shotFileName(clip.shot))]))
  const reportInput: ReportInput = {
    method: 'render',
    bgmPlan,
    renderPreview: preview,
    ...(layout === undefined ? {} : { subtitleLayout: layout.report }),
    ...(overlay === undefined ? {} : { subtitleOverlay: overlay.report }),
    ...(endingEffectFit === undefined || endingTiming === undefined ? {} : { endingEffect: endingTiming }),
    project: input.project,
    episode: input.episode,
    timeline: { clips, bodyEndSeconds, delivery: policy.delivery },
    sources,
    expectedDurationSeconds,
    written: [output, ...(musicStem ? [musicStem] : []), sourceRecordPath, renderLog,
      ...overlay?.written ?? [], ...layout?.written ?? [], ...displayWritten],
    ...(profile === undefined ? {} : { audioMix: audioMixReport(profile, paths.masterAudio, bgm ?? '', musicStem) }),
    output,
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
    logPath: renderLog,
  }
  return buildReport(reportInput)
}
