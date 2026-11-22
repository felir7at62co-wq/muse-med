/**
 * Local-project episode source: the locked package plan, the approved selections, measured durations and lines.
 *
 * Each package of `episode_packages/NN/package.json` is one render shot whose media come from its approved review
 * `reviews/epNN-pMM.json`. The derived manifest `editing/NN-shots.json` is what `prepare` and the draft consume.
 * Nothing is guessed: a missing approval, a plan changed after approval or media changed after approval blocks the
 * episode and names the packages.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { episodeNumberOf, episodePaths, parseShotManifest, readProjectDelivery, resolveShots, type MediaToolkit }
  from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import type { HashCache } from './hash-cache.ts'
import type { BlockedEpisode, EpisodeFiles, EpisodeSource, ResolvedEpisode } from './types.ts'

const VOICED = new Set(['dialogue', 'vo'])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parse(bytes: Buffer, file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^﻿/u, ''))
  if (!record(value)) throw new Error(`${file} 不是 JSON 对象。`)
  return value
}

/**
 * Output files of one local episode.
 * @param project - Absolute project root.
 * @param code - Two-digit episode.
 * @returns The SRT beside the renderer's subtitle path and the review files under `subtitles/`.
 */
export function localEpisodeFiles(project: string, code: string): EpisodeFiles {
  return { srt: episodePaths(project, code).subtitle, state: join(project, 'subtitles', `${code}.state.json`),
    review: join(project, 'subtitles', `${code}.review.json`), decisions: join(project, 'subtitles', `${code}.decisions.json`) }
}

/**
 * Path of the derived shot manifest of one episode.
 * @param project - Absolute project root.
 * @param code - Two-digit episode.
 * @returns `editing/NN-shots.json`.
 */
export function localShotManifestPath(project: string, code: string): string {
  return join(project, 'editing', `${code}-shots.json`)
}

async function bibleNames(project: string): Promise<string[]> {
  const bytes = await readOptional(join(project, 'project_config.json'))
  if (bytes === undefined) return []
  const config = parse(bytes, join(project, 'project_config.json'))
  const bible = config.project_bible
  if (!record(bible) || !Array.isArray(bible.characters)) return []
  return bible.characters.flatMap((row: unknown) => !record(row) ? []
    : [row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])].filter((name): name is string => typeof name === 'string'))
}

/**
 * Resolve one local episode.
 * @param project - Absolute project root.
 * @param episode - Episode number.
 * @param hash - Stat-keyed digest cache.
 * @param toolkit - Probe-memoizing media toolkit.
 * @returns The resolved episode, or the reason and packages that block it.
 */
export async function resolveLocalEpisode(project: string, episode: number, hash: HashCache, toolkit: MediaToolkit):
Promise<ResolvedEpisode | BlockedEpisode> {
  const code = episodeNumberOf(episode)
  const blocked = (reason: BlockedEpisode['reason'], shots: readonly number[]): BlockedEpisode => ({ kind: 'blocked', episode, reason, shots })
  const planPath = join(project, 'episode_packages', code, 'package.json')
  const planBytes = await readOptional(planPath)
  if (planBytes === undefined) return blocked('package_missing', [])
  const plan = parse(planBytes, planPath)
  const tasks = Array.isArray(plan.video_tasks) ? plan.video_tasks : []
  const rows = Array.isArray(plan.shots) ? plan.shots.filter(record) : []
  if (tasks.length === 0) return blocked('package_missing', [])
  const planSha = createHash('sha256').update(planBytes).digest('hex')

  const missing: number[] = [], changed: number[] = []
  const selected: { shot: number; package: number; video: string; audio: string; videoSha?: string; audioSha?: string }[] = []
  for (let pack = 1; pack <= tasks.length; pack++) {
    const reviewPath = join(project, 'reviews', `ep${code}-p${String(pack).padStart(2, '0')}.json`)
    const bytes = await readOptional(reviewPath)
    const review = bytes === undefined ? undefined : parse(bytes, reviewPath)
    if (review?.status !== 'approved' || typeof review.video_path !== 'string' || !review.video_path.trim()) { missing.push(pack); continue }
    if (review.package_sha256 !== planSha) { changed.push(pack); continue }
    const audio = typeof review.audio_path === 'string' && review.audio_path.trim() ? review.audio_path : review.video_path
    selected.push({ shot: pack, package: pack, video: review.video_path, audio,
      ...(typeof review.video_sha256 === 'string' ? { videoSha: review.video_sha256 } : {}),
      ...(typeof review.audio_sha256 === 'string' ? { audioSha: review.audio_sha256 } : {}) })
  }
  if (missing.length > 0) return blocked('selection_missing', missing)
  if (changed.length > 0) return blocked('package_changed', changed)

  const absolute = (path: string) => isAbsolute(path) ? path : resolve(project, path)
  const drifted: number[] = []
  for (const row of selected) {
    try {
      const video = row.videoSha === undefined || await hash.sha256(absolute(row.video)) === row.videoSha
      const audio = row.audioSha === undefined || await hash.sha256(absolute(row.audio)) === row.audioSha
      if (!video || !audio) drifted.push(row.shot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      drifted.push(row.shot)
    }
  }
  if (drifted.length > 0) return blocked('selection_changed', drifted)

  const manifest = { shots: selected.map(row => ({ shot: row.shot, package: row.package, video: row.video, audio: row.audio })) }
  const manifestPath = localShotManifestPath(project, code)
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  if ((await readOptional(manifestPath))?.toString('utf8') !== text) {
    await writeFileAtomic(manifestPath, text, { mode: 0o600, dirMode: 0o700 })
  }
  const { fps } = await readProjectDelivery(project)
  const sources = parseShotManifest(manifest, manifestPath)
  let clock
  try { clock = await resolveShots(toolkit, project, sources, fps) }
  catch (error) {
    // An unprobeable or soundless selection blocks the episode until that media is replaced; the cause is not model input.
    void error
    return blocked('media_unreadable', selected.map(row => row.shot))
  }

  const linesOf = (pack: number): string[] => {
    const task: unknown = tasks[pack - 1]
    const members = record(task) && Array.isArray(task.shots) ? new Set(task.shots) : new Set()
    return rows.filter(row => members.has(row.shot) && VOICED.has(String(row.voice_type))
      && typeof row.text === 'string' && row.text.trim()).map(row => String(row.text))
  }
  const names = new Set<string>(await bibleNames(project))
  for (const row of rows) {
    if (typeof row.speaker === 'string' && row.speaker.trim()) names.add(row.speaker.trim())
    if (Array.isArray(row.characters)) for (const name of row.characters) if (typeof name === 'string' && name.trim()) names.add(name.trim())
  }
  return { kind: 'ok', episode, code, clock, names: [...names].sort(), files: localEpisodeFiles(project, code),
    shots: clock.map(shot => ({ shot: shot.source.shot, audio: shot.audio, lines: linesOf(shot.source.package ?? shot.source.shot),
      window: { clipInUs: 0, durationUs: shot.durationUs, speed: 1 } })) }
}

/**
 * Create the local-project source.
 * @param project - Absolute project root.
 * @param display - Project path as the model passed it, for the files pattern.
 * @param hash - Digest cache of the project root.
 * @param toolkit - Probe-memoizing media toolkit.
 * @returns The episode source for `source: "local"`.
 */
export function localSource(project: string, display: string, hash: HashCache, toolkit: MediaToolkit): EpisodeSource {
  return { kind: 'local', root: project, clockReview: true, filesPattern: `${display.replace(/\/+$/u, '')}/editing/NN.srt`,
    resolve: async (episodes) => {
      const out: (ResolvedEpisode | BlockedEpisode)[] = []
      for (const episode of episodes) out.push(await resolveLocalEpisode(project, episode, hash, toolkit))
      return out
    } }
}
