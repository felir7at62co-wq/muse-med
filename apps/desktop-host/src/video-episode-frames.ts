/** Per-episode frame-observation status of one source-video folder, read from durable `video_inspect` reports. */
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'

/** Deployment bounds for scanning a source folder and the workspace's observation reports. */
export interface VideoEpisodeFrameLimits {
  /** Maximum directory entries visited below the source folder, depth included. */
  videoEpisodeMaxFiles: number
  /** Maximum `.muse/video-observations` report files considered. */
  videoEpisodeMaxReports: number
  /** Largest observation report read in full. */
  videoEpisodeMaxReportBytes: number
}

/**
 * Observation state of one episode:
 * `complete` — a report for the current video version has a complete scan and an observation on every frame;
 * `incomplete` — a current report lacks scan completion or a frame observation;
 * `stale` — reports exist only for another version of the video;
 * `not_viewed` — no report names the video;
 * `no_video` / `ambiguous_video` — the folder has zero or several videos numbered as this episode.
 */
export type EpisodeFrameState = 'complete' | 'incomplete' | 'stale' | 'not_viewed' | 'no_video' | 'ambiguous_video'

/** One episode's state, its matched video path and frame counts from the best current report. */
export interface EpisodeFrameStatus {
  episode: number
  state: EpisodeFrameState
  video?: string
  frames?: number
  recorded?: number
}

/** Folder-level result; `videos` counts the numbered source videos found. */
export interface VideoEpisodeFrames {
  video_dir: string
  videos: number
  episodes: EpisodeFrameStatus[]
}

/** Filesystem operations the check needs; the Host `ctx.fs` provides them. */
export type VideoEpisodeFs = Pick<FileSystem, 'resolve' | 'stat' | 'listDir' | 'readText' | 'readByteRange'>

const VIDEO_EXTENSION = /\.(?:mp4|mov|m4v|mkv|webm|avi|flv|ts)$/iu
const MAX_DEPTH = 3
const HEAD_BYTES = 4096
const reportSchema = z.object({ path: z.string(), source_version: z.string(), scan_complete: z.boolean(),
  frames: z.array(z.object({ id: z.string(), observation: z.object({ visible: z.string() }).nullish() })) })
type Report = z.infer<typeof reportSchema>

function failure(code: string, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code })
}

/**
 * Episode number of a source video file: the last digit run in its name without extension.
 * @param name - File basename such as `剧名 014.mp4` or `episode-0034.mp4`.
 * @returns The positive episode number, or undefined when the name carries no digits.
 */
export function videoEpisodeNumber(name: string): number | undefined {
  const digits = name.replace(VIDEO_EXTENSION, '').match(/\d+/gu)?.at(-1)
  const value = digits === undefined ? undefined : Number(digits)
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

async function videosIn(fs: VideoEpisodeFs, root: FsTarget, limits: VideoEpisodeFrameLimits, signal: AbortSignal) {
  const videos = new Map<number, FsTarget[]>()
  const queue: { target: FsTarget; depth: number }[] = [{ target: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    for (const entry of await fs.listDir(next.target, signal)) {
      visited += 1
      if (visited > limits.videoEpisodeMaxFiles) {
        throw failure('VIDEO_EPISODE_SOURCE_LIMIT', `原片目录下的文件超过 ${limits.videoEpisodeMaxFiles} 个；请指定只含本剧原片的目录。`)
      }
      if (entry.type === 'directory' && next.depth + 1 < MAX_DEPTH) queue.push({ target: entry.target, depth: next.depth + 1 })
      if (entry.type !== 'file' || !VIDEO_EXTENSION.test(entry.name)) continue
      const episode = videoEpisodeNumber(entry.name)
      if (episode !== undefined) videos.set(episode, [...videos.get(episode) ?? [], entry.target])
    }
  }
  return videos
}

async function reportsFor(fs: VideoEpisodeFs, cwd: string, paths: ReadonlySet<string>, limits: VideoEpisodeFrameLimits,
  signal: AbortSignal): Promise<Map<string, Report[]>> {
  const result = new Map<string, Report[]>()
  const folder = await fs.resolve('.muse/video-observations', { cwd, signal })
  if ((await fs.stat(folder, signal))?.type !== 'directory') return result
  const entries = (await fs.listDir(folder, signal)).filter(entry => entry.type === 'file' && entry.name.endsWith('.json'))
  if (entries.length > limits.videoEpisodeMaxReports) {
    throw failure('VIDEO_EPISODE_REPORT_LIMIT', `看帧报告超过 ${limits.videoEpisodeMaxReports} 份；请调高 videoEpisodeMaxReports 或归档旧报告。`)
  }
  for (const entry of entries) {
    signal.throwIfAborted()
    const size = entry.size ?? (await fs.stat(entry.target, signal))?.size
    if (size === undefined || size > limits.videoEpisodeMaxReportBytes) continue
    const head = new TextDecoder().decode(await fs.readByteRange(entry.target, { offset: 0, length: Math.min(size, HEAD_BYTES) }, signal))
    const literal = /"path"\s*:\s*("(?:[^"\\]|\\.)*")/u.exec(head)?.[1]
    if (literal === undefined) continue
    let path: unknown
    try { path = JSON.parse(literal) } catch (error) { if (error instanceof SyntaxError) continue; throw error }
    if (typeof path !== 'string' || !paths.has(path)) continue
    let parsed: unknown
    const text = await fs.readText(entry.target, signal)
    try { parsed = JSON.parse(text) } catch (error) { if (error instanceof SyntaxError) continue; throw error }
    const report = reportSchema.safeParse(parsed)
    if (report.success) result.set(report.data.path, [...result.get(report.data.path) ?? [], report.data])
  }
  return result
}

function observed(report: Report): number {
  return report.frames.filter(frame => (frame.observation?.visible.trim().length ?? 0) > 0).length
}

/**
 * Report, per requested episode, whether every detected frame of its source video was shown to the model and recorded.
 * @param fs - Host filesystem service of the owning Session.
 * @param cwd - Session workspace; reports are read from its `.muse/video-observations` folder.
 * @param videoDir - Folder holding this drama's source videos, numbered by episode in their file names.
 * @param episodes - Episode numbers present in the delivered manuscript.
 * @param limits - Folder and report scan bounds; exceeding one fails instead of truncating.
 * @param signal - Caller cancellation.
 * @returns Folder identity, numbered-video count and one state per requested episode.
 */
export async function videoEpisodeFrames(fs: VideoEpisodeFs, cwd: string, videoDir: string, episodes: readonly number[],
  limits: VideoEpisodeFrameLimits, signal: AbortSignal): Promise<VideoEpisodeFrames> {
  const root = await fs.resolve(videoDir, { cwd, signal })
  if ((await fs.stat(root, signal))?.type !== 'directory') throw failure('VIDEO_EPISODE_SOURCE_DIR', `原片目录不存在或不是目录：${root.displayPath}`)
  const videos = await videosIn(fs, root, limits, signal)
  const wanted = new Set(episodes.flatMap(episode => videos.get(episode)?.length === 1 ? [videos.get(episode)?.[0]?.displayPath ?? ''] : []))
  const reports = await reportsFor(fs, cwd, wanted, limits, signal)
  const statuses: EpisodeFrameStatus[] = []
  for (const episode of episodes) {
    const matches = videos.get(episode) ?? []
    const video = matches[0]
    if (matches.length !== 1 || video === undefined) {
      statuses.push({ episode, state: matches.length === 0 ? 'no_video' : 'ambiguous_video' })
      continue
    }
    const version = (await fs.stat(video, signal))?.version
    const all = reports.get(video.displayPath) ?? []
    const current = all.filter(report => report.source_version === version)
    const best = current.toSorted((a, b) => Number(b.scan_complete) - Number(a.scan_complete) || observed(b) - observed(a))[0]
    if (best === undefined) {
      statuses.push({ episode, state: all.length > 0 ? 'stale' : 'not_viewed', video: video.displayPath })
      continue
    }
    const recorded = observed(best)
    statuses.push({ episode, state: best.scan_complete && recorded === best.frames.length ? 'complete' : 'incomplete',
      video: video.displayPath, frames: best.frames.length, recorded })
  }
  return { video_dir: root.displayPath, videos: [...videos.values()].reduce((sum, list) => sum + list.length, 0), episodes: statuses }
}
