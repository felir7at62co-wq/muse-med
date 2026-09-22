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

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileSha256 } from './cache.ts'
import { assertVideoHashesAllowed, assertVideosAllowed } from './video.ts'
import { firstStreamOfType, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodePaths, pathExists, shotFileName } from './paths.ts'
import { readSubtitleCues } from './subtitles.ts'
import { appendClips, formatTimelineDocument } from './timeline.ts'
import type { MediaToolkit, ShotSource, SubtitleCue, Timeline, TimelineClip } from './types.ts'

/** Microseconds in one second. */
const MICROSECONDS_PER_SECOND = 1_000_000

/** Everything one `prepare` call needs. */
export interface PrepareInput {
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
 * @returns One resolved shot per row.
 * @throws {Error} When a source cannot be probed, has no video stream, has no audio and none was declared, or reports no duration.
 */
export async function resolveShots(
  toolkit: MediaToolkit,
  project: string,
  rows: readonly ShotSource[],
): Promise<ResolvedShot[]> {
  const resolved: ResolvedShot[] = []
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
    if (firstStreamOfType(media, 'video') === undefined) {
      throw new Error(`镜头 ${String(row.shot)} 的成片没有视频流：${video}。`
        + '请把 video 指向该镜真正的成片文件后重试。')
    }
    const hasOwnAudio = firstStreamOfType(media, 'audio') !== undefined
    const audio = declaredAudio === video && !hasOwnAudio ? undefined : declaredAudio
    if (audio === undefined) {
      throw new Error(`镜头 ${String(row.shot)} 的成片没有音轨：${video}。`
        + '请在清单里为该镜显式指定 audio（例如该镜自己的 provider 视频），否则整集原声会缺这一段。')
    }
    const durationUs = Math.round(media.durationSeconds * MICROSECONDS_PER_SECOND)
    if (durationUs <= 0) {
      throw new Error(`镜头 ${String(row.shot)} 的成片时长为 0：${video}。`
        + '请重新导出该镜的成片；空文件不能进入渲染。')
    }
    resolved.push({ source: row, video, audio, durationUs })
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
  shots: readonly ResolvedShot[],
  clips: readonly TimelineClip[],
  target: string,
): Promise<void> {
  const args: string[] = ['-y', '-v', 'error']
  for (const shot of shots) args.push('-i', shot.audio)
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
  const rows = parseShotManifest(
    await readJsonDocument(input.shotsPath, '成片清单'),
    input.shotsPath,
  )
  await assertVideosAllowed(input.project, rows.flatMap(row => [
    resolveAgainst(input.project, row.video), resolveAgainst(input.project, row.audio),
  ]))
  const shots = await resolveShots(input.toolkit, input.project, rows)
  const timeline = appendClips(shots.map(shot => shot.durationUs))
  const packagePath = resolve(input.project, 'episode_packages', input.episode, 'package.json')
  const packageHash = rows.some(row => row.package !== undefined) && await pathExists(packagePath)
    ? await fileSha256(packagePath) : undefined

  await assertVideosAllowed(input.project, shots.flatMap(shot => [shot.video, shot.audio]))
  const written: string[] = []
  await rm(paths.sources, { force: true })
  const selected = []
  await mkdir(paths.videoDir, { recursive: true })
  for (const shot of shots) {
    const target = resolve(paths.videoDir, shotFileName(shot.source.shot))
    await copyFile(shot.video, target)
    const sha256 = await fileSha256(target)
    await assertVideoHashesAllowed(input.project, [sha256])
    written.push(target)
    selected.push({
      ...shot.source, video: shot.video, audio: shot.audio, sha256,
      ...(shot.source.package === undefined || packageHash === undefined ? {} : { package_sha256: packageHash }),
    })
  }

  await mkdir(resolve(input.project, 'editing'), { recursive: true })
  await writeFile(paths.timeline, formatTimelineDocument(timeline), 'utf8')
  written.push(paths.timeline)

  await mkdir(resolve(input.project, 'audio'), { recursive: true })
  await buildMaster(input.toolkit, shots, timeline.clips, paths.masterAudio)
  written.push(paths.masterAudio)

  const cues = await readSubtitleCues(input.subtitleSrt)
  await copyFile(input.subtitleSrt, paths.subtitle)
  written.push(paths.subtitle)
  await assertVideoHashesAllowed(input.project, selected.map(shot => shot.sha256))
  await writeFile(paths.sources, `${JSON.stringify({ shots: selected }, null, 2)}\n`, 'utf8')
  written.push(paths.sources)

  return { shots, timeline, cues, written, warnings: cueOverrunWarnings(cues, timeline.bodyEndSeconds) }
}
