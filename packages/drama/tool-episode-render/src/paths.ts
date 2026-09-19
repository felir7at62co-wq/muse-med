/**
 * Where one episode's render inputs and outputs live under a project root.
 *
 * The layout is the one the short-drama pipeline already reads and writes —
 * `video/<集>/shot_00N.mp4` for the shots the renderer consumes, `audio/<集>.wav`
 * for the episode's own master, `editing/` for the timeline and the subtitle the
 * renderer burns, and `exports/` for the delivered file and its cache. Naming it
 * once keeps `prepare`, `render`, and `verify` addressing the same files.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/paths
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Every path one episode's render uses. */
export interface EpisodePaths {
  /** Absolute project root. */
  readonly project: string
  /** Two-digit episode number. */
  readonly episode: string
  /** Directory holding the shots the renderer encodes. */
  readonly videoDir: string
  /** The episode's own master audio. */
  readonly masterAudio: string
  /** The timeline `prepare` writes and `render` reads. */
  readonly timeline: string
  /** The subtitle `prepare` writes and `render` burns. */
  readonly subtitle: string
  /** The delivered file, when the caller gives no explicit output path. */
  readonly output: string
  /** Directory holding the per-encode cache the renderer reuses. */
  readonly cacheDir: string
  /** The render log for this episode. */
  readonly renderLog: string
}

/**
 * Report whether one path exists.
 *
 * Only a genuinely absent path is `false`. Any other stat failure — a permission
 * error, an unusable path — is rethrown, so a broken directory never reads as a
 * cache miss and a broken tail-frame path never reads as an empty seek.
 * @param path - The path to stat.
 * @returns Whether the path exists.
 * @throws {Error} When the path exists but cannot be stat'ed.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Pad one episode number to the two digits every project path uses.
 * @param episode - The episode number.
 * @returns The number padded with a leading zero when it is below ten.
 */
export function episodeNumberOf(episode: number): string {
  return String(episode).padStart(2, '0')
}

/**
 * Name one shot's file inside an episode's video directory.
 * @param shot - The shot number.
 * @returns `shot_001.mp4`.
 */
export function shotFileName(shot: number): string {
  return `shot_${String(shot).padStart(3, '0')}.mp4`
}

/**
 * Resolve every path one episode's render touches.
 * @param project - Absolute project root.
 * @param episode - The two-digit episode number.
 * @returns The resolved layout.
 */
export function episodePaths(project: string, episode: string): EpisodePaths {
  return {
    project,
    episode,
    videoDir: join(project, 'video', episode),
    masterAudio: join(project, 'audio', `${episode}.wav`),
    timeline: join(project, 'editing', `${episode}-timeline.json`),
    subtitle: join(project, 'editing', `${episode}.srt`),
    output: join(project, 'exports', `${episode}.mp4`),
    cacheDir: join(project, 'exports', '.render_cache', episode),
    renderLog: join(project, 'exports', '.render_cache', episode, 'render.log'),
  }
}
