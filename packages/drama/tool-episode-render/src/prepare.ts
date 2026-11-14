/**
 * `prepare`: build the directory layout a render consumes, without encoding any
 * picture.
 *
 * The renderer reads one finished video per shot, one episode master, one
 * timeline, and one subtitle. This method produces exactly those four from a
 * shot-sources manifest: each source video is copied into
 * `video/<集>/shot_00N.mp4`, the timeline is laid out from the *probed* durations
 * rather than declared ones, the master is assembled by placing each shot's own
 * sound at its own start with no gain and no per-shot resampling, and the
 * subtitle is installed at the path the renderer burns from.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/prepare
 */

import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { verifySelectedSourceReviews } from './approved-sources.ts'
import { fileSha256 } from './cache.ts'
import { assertVideoHashesAllowed, assertVideosAllowed } from './video.ts'
import { createMediaToolkit, firstStreamOfType, frameRateOf, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodePaths, pathExists, shotFileName, type EpisodePaths } from './paths.ts'
import { subtitleReviewWarnings, subtitleTextWarnings, readSubtitleCues } from './subtitles.ts'
import { deliveryPolicyFor, readProjectDelivery, resolveDeliveryPolicy } from './delivery-policy.ts'
import { appendClips, formatTimelineDocument, readTimeline } from './timeline.ts'
import { ENDING_AUDIO_ASSET, ENDING_EFFECT_ASSET, type ShippedEndingAsset } from './delivery.ts'
import { subtitleClockPath, verifySubtitleClock } from './subtitle-clock.ts'
import type { RenderSettings, DeliverySubtitleVisual, EndingEffectFit, MediaToolkit, ProbedMedia, ProbedStream, ShotSource, SubtitleCue, Timeline, TimelineClip } from './types.ts'

/** Microseconds in one second. */
const MICROSECONDS_PER_SECOND = 1_000_000

/**
 * Prefer the whole-frame picture length when the muxed audio extends a proven delivery-rate source by at most one frame.
 * @param media - Container and stream metadata for the selected video file.
 * @param video - Its first video stream.
 * @param fps - Delivery frame rate shared by subtitle placement and rendering.
 * @returns Picture frames, or undefined when the container clock must be retained.
 */
export function pictureClockFrames(media: ProbedMedia, video: ProbedStream, fps: number): number | undefined {
  const { durationSeconds, frameCount } = video
  if (video.startSeconds !== 0 || durationSeconds === undefined || frameCount === undefined
    || !Number.isSafeInteger(frameCount) || frameCount <= 0
    || video.avgFrameRate !== video.rFrameRate || frameRateOf(video) !== fps
    || media.streams.filter(stream => stream.codecType === 'video').length !== 1) return undefined
  const picture = frameCount / fps
  const excess = media.durationSeconds - durationSeconds
  if (Math.abs(durationSeconds - picture) > 1 / MICROSECONDS_PER_SECOND
    || excess < 0 || excess > 1 / fps) return undefined
  return frameCount
}

/**
 * Serialize an absolute cut using the same nearest-even tie rule as Jianying's frame planner.
 * @param timeUs - Exact cut time in microseconds.
 * @returns The integer microsecond boundary.
 */
function roundPictureBoundary(timeUs: number): number {
  const nearest = Math.round(timeUs)
  return nearest - timeUs === 0.5 && nearest % 2 !== 0 ? nearest - 1 : nearest
}

/** Everything one `prepare` call needs. */
export interface PrepareInput {
  /** Deployment fallback saved with the new timeline when present. */
  readonly defaultEndingEffectFit?: EndingEffectFit
  /** Deployment fallback captured only when the project has no explicit subtitle style. */
  readonly defaultSubtitleVisual?: DeliverySubtitleVisual
  /** Enforce the deployment subtitle target regardless of saved project overrides. */
  readonly enforceSubtitleVisual?: boolean
  /** The binaries and channel to use, or a stub in tests. */
  readonly toolkit: MediaToolkit
  /** Absolute project root. */
  readonly project: string
  /** Two-digit episode number. */
  readonly episode: string
  /** Absolute path of the shot-sources manifest. */
  readonly shotsPath: string
  /** Absolute path of the subtitle to install. */
  readonly subtitleSrt: string
}

/** One resolved shot: the source video, its sound, and its probed duration. */
export interface ResolvedShot {
  /** The manifest row. */
  readonly source: ShotSource
  /** Absolute path of the video the renderer will encode. */
  readonly video: string
  /** Absolute path of the sound that supplies this shot's audio. */
  readonly audio: string
  /** Probed duration in microseconds. */
  readonly durationUs: number
}

/** What one `prepare` call produced. */
export interface PreparedEpisode {
  /** The shots the renderer will encode, in shot order. */
  readonly shots: readonly ResolvedShot[]
  /** The timeline laid out from the probed durations. */
  readonly timeline: Timeline
  /** The cues installed with the subtitle. */
  readonly cues: readonly SubtitleCue[]
  /** Absolute paths this call created or overwrote, in write order. */
  readonly written: readonly string[]
  /** One Chinese line per fact worth reading that does not block the render. */
  readonly warnings: readonly string[]
}

/** Resolve one manifest path against the project root. */
function resolveAgainst(project: string, path: string): string {
  return isAbsolute(path) ? path : resolve(project, path)
}

/**
 * Read and validate one shot-sources manifest.
 * @param document - The parsed JSON value.
 * @param path - The manifest path, for diagnostics.
 * @returns One row per shot, ordered by shot number.
 * @throws {Error} When `shots` is missing, a row is malformed, or shot numbers are not 1..N without gaps.
 */
export function parseShotManifest(document: unknown, path: string): ShotSource[] {
  if (typeof document !== 'object' || document === null
    || !Array.isArray((document as { shots?: unknown }).shots)) {
    throw new Error(`${path}: 成片清单必须是 {"shots":[{"shot":1,"video":"media/02/p1-clean.mp4"}]}。`
      + '请把每镜的成片路径写进 shots 数组后重试。')
  }
  const rows: ShotSource[] = (document as { shots: readonly unknown[] }).shots.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${path}：第 ${String(index + 1)} 行不是对象。`
        + '请提供 {"shot":N,"video":"<成片路径>","audio":"<可选音轨路径>"} 形式的行。')
    }
    const row = entry as { shot?: unknown; video?: unknown; audio?: unknown; package?: unknown }
    if (row.package !== undefined && (!Number.isInteger(row.package) || (row.package as number) < 1)) {
      throw new Error(`${path}：package 必须是 video_tasks 中从 1 开始的整数包号，不得从镜头号猜测。`)
    }
    if (!Number.isInteger(row.shot) || (row.shot as number) < 1) {
      throw new Error(`${path}：第 ${String(index + 1)} 行的 shot 必须是正整数镜头号，收到 ${JSON.stringify(row.shot)}。`)
    }
    if (typeof row.video !== 'string' || row.video.trim() === '') {
      throw new Error(`${path}：镜头 ${String(row.shot)} 缺少 video。`
        + '请填该镜成片文件的路径（通常是 media/<集>/pN-clean.mp4）。')
    }
    if (row.audio !== undefined && (typeof row.audio !== 'string' || row.audio.trim() === '')) {
      throw new Error(`${path}：镜头 ${String(row.shot)} 的 audio 不是非空字符串。`
        + '请填该镜音轨文件的路径，或整行省略 audio 以使用成片自带的音轨。')
    }
    return {
      shot: row.shot as number,
      ...(row.package === undefined ? {} : { package: row.package as number }),
      video: row.video,
      audio: typeof row.audio === 'string' ? row.audio : row.video,
    }
  })
  if (rows.length === 0) {
    throw new Error(`${path}: 成片清单没有任何镜头，无法构建渲染输入。请至少写入一镜。`)
  }
  const numbers = rows.map(row => row.shot).sort((left, right) => left - right)
  if (numbers.some((shot, index) => shot !== index + 1)) {
    throw new Error(`${path}: 镜头号必须是 1..${String(rows.length)} 连续无重复，收到 [${numbers.join(', ')}]。`
      + '请补上缺失的镜头或改正镜头号后重试。')
  }
  return [...rows].sort((left, right) => left.shot - right.shot)
}

/**
 * Probe every shot's source and pair it with the sound that carries its audio.
 * @param toolkit - The binaries and channel to use.
 * @param project - Absolute project root.
 * @param rows - The manifest rows, in shot order.
 * @param deliveryFps - The episode's selected output frame rate.
 * @returns One resolved shot per row.
 * @throws {Error} When a source cannot be probed, has no video stream, has no audio and none was declared, or reports no duration.
 */
export async function resolveShots(
  toolkit: MediaToolkit,
  project: string,
  rows: readonly ShotSource[],
  deliveryFps: number,
): Promise<ResolvedShot[]> {
  const resolved: ResolvedShot[] = []
  let frames = 0
  let fallbackUs = 0
  let startUs = 0
  for (const row of rows) {
    const video = resolveAgainst(project, row.video)
    const declaredAudio = resolveAgainst(project, row.audio)
    let media
    try {
      media = await probeMedia(toolkit, video)
    } catch (error) {
      throw new Error(`镜头 ${String(row.shot)} 的成片无法探测：${video}。`
        + '请确认该文件存在且可解码（通常是 media/<集>/pN-clean.mp4），修正清单后重试。',
      { cause: error })
    }
    const picture = firstStreamOfType(media, 'video')
    if (picture === undefined) {
      throw new Error(`镜头 ${String(row.shot)} 的成片没有视频流：${video}。`
        + '请把 video 指向该镜真正的成片文件后重试。')
    }
    const hasOwnAudio = firstStreamOfType(media, 'audio') !== undefined
    const audio = declaredAudio === video && !hasOwnAudio ? undefined : declaredAudio
    if (audio === undefined) {
      throw new Error(`镜头 ${String(row.shot)} 的成片没有音轨：${video}。`
        + '请在清单里为该镜显式指定 audio（例如该镜自己的 provider 视频），否则整集原声会缺这一段。')
    }
    const pictureFrames = pictureClockFrames(media, picture, deliveryFps)
    if (pictureFrames === undefined) fallbackUs += Math.round(media.durationSeconds * MICROSECONDS_PER_SECOND)
    else frames += pictureFrames
    const endUs = roundPictureBoundary(fallbackUs + frames * MICROSECONDS_PER_SECOND / deliveryFps)
    const durationUs = endUs - startUs
    if (durationUs <= 0) {
      throw new Error(`镜头 ${String(row.shot)} 的成片时长为 0：${video}。`
        + '请重新导出该镜的成片；空文件不能进入渲染。')
    }
    resolved.push({ source: row, video, audio, durationUs })
    startUs = endUs
  }
  return resolved
}

/**
 * Build the filter graph that lays every shot's own sound on the picture clock.
 *
 * Nothing is resampled per shot, no gain is applied, and no silence is inserted:
 * each input is trimmed to its own shot length, its timestamps are reset, and it
 * is delayed to the shot's start. The single 48 kHz conversion happens once, when
 * the mixed result is written.
 * @param clips - The clips, in shot order.
 * @returns The filter graph, whose only output pad is `[a]`.
 */
export function masterAudioFilter(clips: readonly TimelineClip[]): string {
  const parts = clips.map((clip, index) => {
    const seconds = (clip.durationUs / MICROSECONDS_PER_SECOND).toFixed(6)
    const delayMs = Math.round(clip.startUs / 1000)
    return `[${String(index)}:a]atrim=0:${seconds},asetpts=N/SR/TB,adelay=delays=${String(delayMs)}:all=1[a${String(index)}]`
  })
  const labels = clips.map((_, index) => `[a${String(index)}]`).join('')
  return `${parts.join(';')};${labels}amix=inputs=${String(clips.length)}:duration=longest:normalize=0[a]`
}

/**
 * Warn when a cue would be burned past the end of the assembled picture.
 * @param cues - The installed subtitles.
 * @param bodyEndSeconds - Where the assembled picture ends.
 * @returns One warning per cue that runs past the end, in cue order.
 */
export function cueOverrunWarnings(cues: readonly SubtitleCue[], bodyEndSeconds: number): string[] {
  return cues
    .filter(cue => cue.endSeconds > bodyEndSeconds)
    .map(cue => `字幕第 ${String(cue.index)} 条结束于 ${cue.endSeconds.toFixed(3)}s，`
      + `超过整集画面时长 ${bodyEndSeconds.toFixed(3)}s，烧录后会被截断。`
      + '请把该条字幕的时间收到 body_end 以内后重跑 prepare。')
}

/**
 * Read one JSON document.
 * @param path - Absolute path of the file.
 * @param description - What the document is, named in the diagnostic.
 * @returns The parsed value.
 * @throws {Error} When the file cannot be read or is not valid JSON.
 */
export async function readJsonDocument(path: string, description: string): Promise<unknown> {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text.startsWith('\ufeff') ? text.slice(1) : text)
  } catch (error) {
    throw new Error(`${path}: ${description}不是合法 JSON。`
      + '请确认它是 UTF-8 的 JSON 文件。', { cause: error })
  }
}

/** Build the episode master by mixing every shot's own sound onto the picture clock. */
async function buildMaster(
  toolkit: MediaToolkit,
  audioPaths: readonly string[],
  clips: readonly TimelineClip[],
  target: string,
): Promise<void> {
  const args: string[] = ['-y', '-v', 'error']
  for (const path of audioPaths) args.push('-i', path)
  args.push('-filter_complex', masterAudioFilter(clips), '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', target)
  await runFfmpeg(toolkit, args)
}

/**
 * Lay out one episode's render inputs.
 * @param input - The resolved call.
 * @returns The shots, the timeline, the installed cues, every path written, and the non-blocking warnings.
 * @throws {Error} When the manifest, a source video, the master build, or the subtitle is unusable.
 */
export async function prepareEpisode(input: PrepareInput): Promise<PreparedEpisode> {
  const paths = episodePaths(input.project, input.episode)
  const subtitleWarnings = await subtitleReviewWarnings(input.subtitleSrt)
  const delivery = await readProjectDelivery(input.project, input.defaultSubtitleVisual, input.enforceSubtitleVisual)
  let priorFit: EndingEffectFit | undefined
  if (input.defaultEndingEffectFit !== undefined) {
    try {
      const previous: unknown = JSON.parse((await readFile(paths.timeline, 'utf8')).replace(/^\ufeff/u, ''))
      if (previous !== null && typeof previous === 'object' && 'ending_effect_fit' in previous) {
        const value = previous.ending_effect_fit
        if (value === 'source_once' || value === 'stretch_to_window') priorFit = value
        else subtitleWarnings.push('旧时间线的片尾适配值无效；新候选使用部署默认值，请检查旧时间线。')
      }
    } catch (error) {
      if (error instanceof SyntaxError) subtitleWarnings.push('旧时间线无法解析；新候选使用部署默认片尾适配，请检查旧时间线。')
      else if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  const rows = parseShotManifest(
    await readJsonDocument(input.shotsPath, '成片清单'),
    input.shotsPath,
  )
  const reviewed = await verifySelectedSourceReviews(paths, rows)
  const byShot = new Map(reviewed.map(row => [row.shot, row]))
  const recheckReviews = async () => {
    if (JSON.stringify(await verifySelectedSourceReviews(paths, rows)) !== JSON.stringify(reviewed)) {
      throw new Error(`EP${input.episode} 准备期间已审核选源变化，请重新核对画面与原声。`)
    }
  }
  await assertVideosAllowed(input.project, rows.flatMap(row => [
    resolveAgainst(input.project, row.video), resolveAgainst(input.project, row.audio),
  ]))
  const shots = await resolveShots(input.toolkit, input.project, rows, delivery.fps)
  const endingEffectFit = priorFit ?? input.defaultEndingEffectFit
  const timeline = { ...appendClips(shots.map(shot => shot.durationUs)), delivery,
    ...(endingEffectFit === undefined ? {} : { endingEffectFit }) }
  const subtitleClock = await verifySubtitleClock(input.subtitleSrt, input.episode, () => shots)
  const packagePath = resolve(input.project, 'episode_packages', input.episode, 'package.json')
  const packageHash = rows.some(row => row.package !== undefined) && await pathExists(packagePath)
    ? await fileSha256(packagePath) : undefined

  await assertVideosAllowed(input.project, shots.flatMap(shot => [shot.video, shot.audio]))
  await recheckReviews()
  const written: string[] = []
  await rm(paths.sources, { force: true })
  const selected = []
  await mkdir(paths.videoDir, { recursive: true })
  for (const shot of shots) {
    const target = resolve(paths.videoDir, shotFileName(shot.source.shot))
    await copyFile(shot.video, target)
    const sha256 = await fileSha256(target)
    const review = byShot.get(shot.source.shot)
    if (review !== undefined && review.videoSha256 !== sha256) {
      throw new Error(`镜头 ${shot.source.shot} 复制期间已审核画面变化，请重新核对。`)
    }
    await assertVideoHashesAllowed(input.project, [sha256])
    written.push(target)
    selected.push({
      ...shot.source, video: shot.video, audio: shot.audio, sha256,
      ...(shot.source.package === undefined || packageHash === undefined ? {} : { package_sha256: packageHash }),
      ...(review === undefined ? {} : { audio_sha256: review.audioSha256, review_sha256: review.reviewSha256 }),
    })
  }

  await mkdir(resolve(input.project, 'editing'), { recursive: true })
  await writeFile(paths.timeline, formatTimelineDocument(timeline), 'utf8')
  written.push(paths.timeline)

  await mkdir(resolve(input.project, 'audio'), { recursive: true })
  await buildMaster(input.toolkit, shots.map(shot => shot.audio), timeline.clips, paths.masterAudio)
  const masterAudioSha256 = reviewed.length > 0 || subtitleClock !== undefined
    || timeline.delivery.subtitle?.require_speech_coverage === true
    ? await fileSha256(paths.masterAudio) : undefined
  written.push(paths.masterAudio)

  const cues = await readSubtitleCues(input.subtitleSrt)
  await copyFile(input.subtitleSrt, paths.subtitle)
  written.push(paths.subtitle)
  if (subtitleClock !== undefined) {
    await writeFile(subtitleClockPath(paths.subtitle), subtitleClock, 'utf8')
    written.push(subtitleClockPath(paths.subtitle))
  } else await rm(subtitleClockPath(paths.subtitle), { force: true })
  if (subtitleWarnings.length) {
    await writeFile(`${paths.subtitle}.review.txt`, subtitleWarnings.join('\n'), 'utf8')
    written.push(`${paths.subtitle}.review.txt`)
  }
  await assertVideoHashesAllowed(input.project, selected.map(shot => shot.sha256))
  await recheckReviews()
  await writeFile(paths.sources, `${JSON.stringify({ shots: selected,
    ...(masterAudioSha256 === undefined ? {} : {
      master_audio_sha256: masterAudioSha256,
      timeline_clips: timeline.clips.map(clip => ({ shot: clip.shot, start_us: clip.startUs, duration_us: clip.durationUs })),
    }),
  }, null, 2)}\n`, 'utf8')
  written.push(paths.sources)

  return {
    shots, timeline, cues, written,
    warnings: [...subtitleWarnings, ...subtitleTextWarnings(cues), ...deliveryPolicyFor(delivery).warnings,
      ...cueOverrunWarnings(cues, timeline.bodyEndSeconds)],
  }
}

/**
 * Resolve the bundled ending assets using the captured deployment subtitle policy.
 * @param input - Staged project and immutable timeline path.
 * @param settings - The same resolved policy passed to the current renderer.
 * @returns Exact bundled descriptors, or undefined for a body-only delivery.
 */
export async function stagedEpisodeEndingAssets(
  input: { readonly project: string; readonly timelinePath: string },
  settings: Pick<RenderSettings, 'defaultSubtitleVisual' | 'enforceSubtitleVisual'>,
): Promise<{ readonly audio: ShippedEndingAsset; readonly effect: ShippedEndingAsset } | undefined> {
  const timeline = await readTimeline(input.timelinePath, settings.enforceSubtitleVisual)
  const policy = await resolveDeliveryPolicy(input.project, timeline.delivery,
    settings.defaultSubtitleVisual, settings.enforceSubtitleVisual)
  return policy.endingSeconds === 0 ? undefined : { audio: ENDING_AUDIO_ASSET, effect: ENDING_EFFECT_ASSET }
}

/**
 * Build the original-audio master from verified staged inputs.
 * @param input - Private project, two-digit episode, immutable timeline and optional staged shot-audio paths.
 * @param settings - Captured executables, subtitle policy and guardian media channel.
 * @returns When the complete WAV has been written through the owned channel.
 */
export async function prepareStagedEpisodeAudio(
  input: { readonly project: string
    readonly episode: string
    readonly timelinePath: string
    readonly audioPaths?: readonly string[]
    readonly proofOutputPath?: string },
  settings: Pick<RenderSettings, 'ffmpeg' | 'ffprobe' | 'channel' | 'enforceSubtitleVisual'>,
): Promise<void> {
  const paths = episodePaths(input.project, input.episode)
  const { clips } = await readTimeline(input.timelinePath, settings.enforceSubtitleVisual)
  await mkdir(resolve(input.project, 'audio'), { recursive: true })
  const audioPaths = input.audioPaths ?? clips.map(clip => resolve(paths.videoDir, shotFileName(clip.shot)))
  if (audioPaths.length !== clips.length) throw new Error('原声音轨数量与时间线不一致。')
  let target = paths.masterAudio
  if (input.proofOutputPath !== undefined) {
    target = resolve(input.proofOutputPath)
    const within = relative(input.project, target)
    if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + sep)) {
      throw new Error('音轨核验输出必须在私有项目内。')
    }
    await mkdir(dirname(target), { recursive: true })
    if (await realpath(dirname(target)) !== dirname(target)) throw new Error('音轨核验输出目录不是规范路径。')
    try { await lstat(target); throw new Error('音轨核验输出已存在。') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await buildMaster(createMediaToolkit(settings), audioPaths, clips, target)
}

/**
 * Check a generated SRT against the prepared pictures, selected audio and actual render timeline.
 * @param srt - Subtitle selected for rendering.
 * @param paths - Prepared files for the episode being rendered.
 * @param timeline - The full timeline supplied to render, including shots beyond a preview.
 * @param stagedAudio - Map an original audio reference to a verified private copy, when rendering a private stage.
 * @param signal - Optional owning operation cancellation.
 * @param manifestDocument - Optional parsed manifest from the same captured bytes as the caller.
 */
export async function verifyPreparedSubtitleClock(srt: string, paths: EpisodePaths, timeline: Timeline,
  stagedAudio?: (sourceAudio: string) => string, signal?: AbortSignal, manifestDocument?: object): Promise<void> {
  const requireMaster = timeline.delivery?.subtitle?.require_speech_coverage === true
  const readSources = async () => {
    const source = manifestDocument ?? await readJsonDocument(paths.sources, '已准备分包清单')
    const rows = parseShotManifest(source, paths.sources)
    const prepared = source as { master_audio_sha256?: unknown; timeline_clips?: unknown }
    if (requireMaster || prepared.master_audio_sha256 !== undefined || prepared.timeline_clips !== undefined) {
      const expected = prepared.master_audio_sha256
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/u.test(expected)
        || !await pathExists(paths.masterAudio) || await fileSha256(paths.masterAudio, signal) !== expected) {
        throw new Error(`EP${paths.episode} 整集原声与准备记录不一致，请用当前选源重新 prepare。`)
      }
    }
    const clock = prepared.timeline_clips
    if (requireMaster && (!Array.isArray(clock) || clock.length !== timeline.clips.length
      || timeline.clips.some((clip, index) => {
        const row = clock[index] as { shot?: unknown; start_us?: unknown; duration_us?: unknown } | null
        return row?.shot !== clip.shot || row.start_us !== clip.startUs || row.duration_us !== clip.durationUs
      }))) {
      throw new Error(`EP${paths.episode} 整集原声的准备切点与当前时间线不一致，请重新 prepare。`)
    }
    return rows
  }
  const strictSources = requireMaster ? await readSources() : undefined
  await verifySubtitleClock(srt, paths.episode, async () => {
    const rows = strictSources ?? await readSources()
    const stale = () => new Error('生成字幕与当前集的准备清单或时间线不一致。请核对素材后重跑 drama_render subtitles 和 prepare。')
    if (rows.length !== timeline.clips.length) throw stale()
    let startUs = 0
    return timeline.clips.map((clip, index) => {
      const source = rows[index]
      if (source?.shot !== clip.shot || clip.startUs !== startUs) throw stale()
      startUs += clip.durationUs
      const video = resolve(paths.videoDir, shotFileName(clip.shot))
      const audio = source.audio === source.video ? video : stagedAudio?.(source.audio) ?? resolveAgainst(paths.project, source.audio)
      return { source, video, audio, durationUs: clip.durationUs }
    })
  }, signal)
}

/** Files that establish the prepared source audio and optional generated subtitle clock. */
export interface PreparedSubtitleClockInputs {
  readonly clockPath: string
  readonly manifestPath: string
  readonly manifestSha256: string
  readonly manifestBytes: number
  readonly clockPresent: boolean
  readonly masterPath?: string
  readonly shots: readonly { readonly shot: number; readonly video: string; readonly audio: string }[]
}

/**
 * Read and verify the prepared episode's source inputs and any generated subtitle clock.
 * @param project - Original project directory.
 * @param episode - Two-digit episode identifier.
 * @param timelinePath - Captured timeline selected for this render.
 * @param subtitlePath - Captured subtitle.
 * @param enforceSubtitleVisual - Resolve the timeline with the renderer's configuration.
 * @param signal - Optional owning operation cancellation.
 * @returns Exact paths required to carry the verified clock into a private stage.
 */
export async function preparedSubtitleClockInputs(project: string, episode: string, timelinePath: string,
  subtitlePath: string, enforceSubtitleVisual: boolean | undefined, signal?: AbortSignal): Promise<PreparedSubtitleClockInputs> {
  signal?.throwIfAborted()
  const paths = episodePaths(project, episode), timeline = await readTimeline(timelinePath, enforceSubtitleVisual)
  const bytes = await readFile(paths.sources, { signal })
  let document: unknown
  try {
    const text = bytes.toString('utf8')
    document = JSON.parse(text.startsWith('\ufeff') ? text.slice(1) : text)
  } catch (error) {
    throw new Error(`${paths.sources}: 已准备分包清单不是合法 JSON。`, { cause: error })
  }
  const rows = parseShotManifest(document, paths.sources)
  const prepared = document as { master_audio_sha256?: unknown; timeline_clips?: unknown }
  const clock = prepared.timeline_clips
  const hasSubtitleClock = await pathExists(subtitleClockPath(subtitlePath))
  const hasPreparedMetadata = prepared.master_audio_sha256 !== undefined || clock !== undefined
  // Both readers require contiguous shot numbers starting at one.
  if (rows.length !== timeline.clips.length) {
    throw new Error('字幕来源清单与当前时间线不一致。')
  }
  if (hasSubtitleClock || hasPreparedMetadata || timeline.delivery?.subtitle?.require_speech_coverage === true) {
    if (typeof prepared.master_audio_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(prepared.master_audio_sha256)
      || await fileSha256(paths.masterAudio, signal) !== prepared.master_audio_sha256 || !Array.isArray(clock)
      || clock.length !== timeline.clips.length || timeline.clips.some((clip, index) => {
      const row = clock[index] as { shot?: unknown; start_us?: unknown; duration_us?: unknown } | undefined
      return row?.shot !== clip.shot || row.start_us !== clip.startUs || row.duration_us !== clip.durationUs
    })) throw new Error('生成字幕缺少与当前音轨及时间线一致的准备记录。')
  }
  await verifyPreparedSubtitleClock(subtitlePath, paths, timeline, undefined, signal, prepared)
  const shots = rows.map((row) => {
    const video = resolve(paths.videoDir, shotFileName(row.shot))
    return { shot: row.shot, video, audio: row.audio === row.video ? video : resolveAgainst(project, row.audio) }
  })
  return { clockPath: subtitleClockPath(subtitlePath), manifestPath: paths.sources,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'), manifestBytes: bytes.length, clockPresent: hasSubtitleClock,
    ...(hasPreparedMetadata ? { masterPath: paths.masterAudio } : {}), shots }
}
