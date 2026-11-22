/**
 * The Jingliu provider behind `source: "jingliu"`.
 *
 * Shots, trim windows, speed, spoken lines, names and per-shot subtitle status come from Jingliu's
 * `POST /projects/{pid}/edit-plan`; each shot's video is downloaded once into `<workspace>/jingliu/<pid>` and is also
 * the shot's sound. Corrected words are stored on Jingliu through one `auto_subtitles` segments job per episode, sent
 * through the once-only submission receipts; Jingliu corrects and lays them out with the same rules and its own cue
 * width and returns the review items, whose IDs match the local rules for the same audio digest and words. A server
 * without the edit-plan route answers 404, and every episode is then `jingliu_outdated`: the segments job is never
 * sent to it, because an old server would run its own recognition instead.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { mediaPath, type JingliuSession, type LocalMedia } from '@deepseek-ai/dsh-jingliu-connection'
import { missingRoute, submitOnce } from '@deepseek-ai/dsh-tool-jingliu/library'
import { episodeNumberOf, type ResolvedShot } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import type { BlockedEpisode, BlockReason, DecisionAction, EpisodeFiles, EpisodeSource, RemoteSubtitles, ResolvedEpisode,
  ReviewItem, SourceShot, StoredMark, StoreOutcome, StoreShot } from './types.ts'

/**
 * Provider used when this Host has no Jingliu connection.
 * @param root - Workspace folder of the Jingliu project.
 * @param project - Jingliu project ID as the model passed it.
 * @returns A source that blocks every episode with `jingliu_outdated`.
 */
export function unavailableJingliuSource(root: string, project: string): EpisodeSource {
  return { kind: 'jingliu', root, clockReview: false, filesPattern: filesPattern(project),
    resolve: async episodes => episodes.map(episode => ({ kind: 'blocked', episode, reason: 'jingliu_outdated', shots: [] })) }
}

function filesPattern(project: string): string {
  return `jingliu/${project}/subtitles/epNN.srt`
}

/** Settings of the Jingliu provider. */
export interface JingliuSourceOptions {
  /** `<workspace>/jingliu/<project>`: media folder, transcripts and outputs. */
  readonly root: string
  readonly project: string
  readonly session: JingliuSession
  /** Longest wait for one segments job inside a call, in milliseconds. */
  readonly jobWaitMs: number
  /** Delay between job status reads, in milliseconds. */
  readonly pollIntervalMs: number
}

type Fields = Record<string, unknown>
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const invalidPlan = () => new HarnessError('镜流返回的剪辑计划无效，请稍后重试或更新镜流服务。', 'EPISODE_SUBTITLES_JINGLIU_INVALID')
const STATUSES = new Set<RemoteSubtitles['status']>(['fresh', 'stale', 'unverified', 'missing'])
const ACTIONS = new Set<DecisionAction>(['heard', 'script', 'drop'])

interface PlanShot {
  readonly shotId: string
  readonly order: number
  readonly videoPath: string | null
  readonly etag: string
  readonly clipInSec: number
  readonly clipDurSec: number
  readonly speed: number
  readonly outputSec: number
  readonly lines: readonly string[]
  readonly remote: RemoteSubtitles
}

function finite(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw invalidPlan()
  return value
}

function planShot(value: unknown): PlanShot {
  if (!isFields(value) || typeof value.shot_id !== 'string' || !value.shot_id || !Number.isSafeInteger(value.order)
    || !(value.video_path === null || typeof value.video_path === 'string') || !Array.isArray(value.lines)
    || !value.lines.every(line => typeof line === 'string') || !isFields(value.subtitles)) throw invalidPlan()
  const { status, cues, time_base: timeBase } = value.subtitles
  if (typeof status !== 'string' || !STATUSES.has(status as RemoteSubtitles['status']) || typeof cues !== 'number') throw invalidPlan()
  const speed = finite(value.speed, 0)
  if (speed <= 0) throw invalidPlan()
  return { shotId: value.shot_id, order: value.order as number, videoPath: value.video_path ? mediaPath(value.video_path).path : null,
    etag: typeof value.video_etag === 'string' ? value.video_etag : '', clipInSec: finite(value.clip_in_sec, 0),
    clipDurSec: finite(value.clip_dur_sec, 0), speed, outputSec: finite(value.output_sec, 0), lines: value.lines as string[],
    remote: { status: status as RemoteSubtitles['status'], manualOnly: status === 'fresh' && cues > 0 && timeBase !== 'source' } }
}

function episodeFiles(root: string, code: string): EpisodeFiles {
  const base = join(root, 'subtitles', `ep${code}`)
  return { srt: `${base}.srt`, state: `${base}.state.json`, review: `${base}.review.json`, decisions: `${base}.decisions.json` }
}

const micro = (seconds: number) => Math.round(seconds * 1_000_000)

function reviewItem(value: unknown): ReviewItem {
  if (!isFields(value) || typeof value.id !== 'string' || typeof value.kind !== 'string' || typeof value.heard !== 'string'
    || typeof value.script !== 'string' || typeof value.start !== 'number' || typeof value.end !== 'number'
    || !(value.decision === null || ACTIONS.has(value.decision as DecisionAction))) throw invalidPlan()
  return { id: value.id, kind: value.kind, heard: value.heard, script: value.script, start: value.start, end: value.end,
    decision: value.decision as DecisionAction | null }
}

/**
 * Create the Jingliu provider for one project.
 * @param options - Workspace folder, project, signed-in session and job wait.
 * @returns The episode source for `source: "jingliu"`.
 */
export function jingliuSource(options: JingliuSourceOptions): EpisodeSource {
  const { root, project, session } = options
  const route = `/projects/${encodeURIComponent(project)}`
  const download = async (paths: readonly string[], signal: AbortSignal): Promise<Map<string, LocalMedia>> => {
    if (!session.download) throw new HarnessError('只有桌面版 Muse 能把镜流素材下载到本机做字幕。', 'JINGLIU_MEDIA_LOCAL_DISABLED')
    return await session.download(paths, root, signal)
  }

  const resolveEpisode = async (row: Fields, names: readonly string[], signal: AbortSignal): Promise<ResolvedEpisode | BlockedEpisode> => {
    const episode = row.episode as number
    const blocked = (reason: BlockReason, shots: readonly number[]): BlockedEpisode => ({ kind: 'blocked', episode, reason, shots })
    if (!Array.isArray(row.shots)) throw invalidPlan()
    const shots = row.shots.map(planShot)
    if (shots.length === 0) return blocked('shots_missing', [])
    const unmade = shots.filter(shot => shot.videoPath === null).map(shot => shot.order)
    if (unmade.length > 0) return blocked('video_missing', unmade)
    const paths = shots.map(shot => shot.videoPath ?? '')
    let local: Map<string, LocalMedia>
    try { local = await download(paths, signal) }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof HarnessError && error.code === 'JINGLIU_MEDIA_LOCAL_DISABLED') throw error
      // One failed file rejects the batch after the others are indexed; find which shots cannot be read.
      const settled = await Promise.allSettled(paths.map(async path => await download([path], signal)))
      const failed = shots.filter((_shot, index) => settled[index]?.status === 'rejected').map(shot => shot.order)
      if (failed.length > 0) return blocked('media_unavailable', failed)
      local = await download(paths, signal)
    }
    const sources: SourceShot[] = [], clock: ResolvedShot[] = []
    for (const shot of shots) {
      const file = local.get(shot.videoPath ?? '')
      if (file === undefined) return blocked('media_unavailable', [shot.order])
      sources.push({ shot: shot.order, audio: file.file, lines: shot.lines, remote: shot.remote,
        window: { clipInUs: micro(shot.clipInSec), durationUs: micro(shot.clipDurSec), speed: shot.speed },
        jingliu: { shot_id: shot.shotId, video_path: shot.videoPath ?? '', etag: shot.etag, clip_in_us: micro(shot.clipInSec), speed: shot.speed } })
      clock.push({ source: { shot: shot.order, video: file.file, audio: file.file }, video: file.file, audio: file.file,
        durationUs: Math.max(1, micro(shot.outputSec)) })
    }
    const code = episodeNumberOf(episode)
    return { kind: 'ok', episode, code, shots: sources, clock, names, files: episodeFiles(root, code) }
  }

  const store = async (episode: ResolvedEpisode, shots: readonly StoreShot[], signal: AbortSignal): Promise<StoreOutcome> => {
    const kept = new Map<number, { items: readonly ReviewItem[]; stored: StoredMark }>()
    const send: StoreShot[] = []
    for (const row of shots) {
      const { shot, state } = row
      const videoPath = shot.jingliu?.video_path ?? ''
      const current = state.stored?.key === state.key && state.stored.video_path === videoPath
      if (shot.remote?.status === 'fresh' && current) continue
      if (shot.remote?.manualOnly === true && state.stored === undefined) {
        kept.set(shot.shot, { items: [], stored: { video_path: videoPath, key: state.key, job: 'manual' } })
        continue
      }
      send.push(row)
    }
    if (send.length === 0) return { kind: 'stored', shots: kept }
    const byId = new Map(send.map(row => [row.shot.jingliu?.shot_id ?? '', row]))
    const segments = send.map(({ shot, rules }) => ({ shot_id: shot.jingliu?.shot_id ?? '', video_url: shot.jingliu?.video_path ?? '',
      source_sha256: rules.audio_sha256, words: rules.words, decisions: rules.decisions, flags: rules.flags }))
    const digest = createHash('sha256').update(JSON.stringify(segments)).digest('hex')
    // A shot whose stored rows vanished is sent again with the same payload; the prior job IDs make that a new submission.
    const prior = send.map(row => row.state.stored?.job ?? '').sort()
    let receipt
    try {
      receipt = await submitOnce(join(root, 'subtitles', 'jobs'), [session.identity, project, String(episode.episode), digest, ...prior],
        [session.identity, project, episode.episode, digest], async () => await session.request('/jobs', { method: 'POST', signal,
          body: { kind: 'auto_subtitles', payload: { project_id: project, episode: episode.episode, segments } } }))
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'JINGLIU_JOB_OUTCOME_UNKNOWN') {
        return { kind: 'blocked', reason: 'subtitle_job_unknown', shots: send.map(row => row.shot.shot) }
      }
      throw error
    }
    const deadline = Date.now() + options.jobWaitMs
    let job: unknown
    for (;;) {
      job = await session.request(`/jobs/${encodeURIComponent(String(receipt.job_id))}`, { signal })
      if (!isFields(job) || typeof job.status !== 'string') throw invalidPlan()
      if (job.status !== 'pending' && job.status !== 'running') break
      if (Date.now() + options.pollIntervalMs > deadline) return { kind: 'waiting', changed: [] }
      await sleep(options.pollIntervalMs, undefined, { signal })
    }
    let result: unknown
    try { result = typeof job.result === 'string' ? JSON.parse(job.result) : undefined }
    catch (error) { throw new HarnessError('镜流字幕任务返回的结果无法读取。', 'EPISODE_SUBTITLES_JINGLIU_INVALID', { cause: error }) }
    if (!isFields(result) || result.mode !== 'segments' || !Array.isArray(result.shots) || !Array.isArray(result.refused)) {
      return { kind: 'blocked', reason: job.status === 'done' ? 'jingliu_outdated' : 'subtitle_job_failed', shots: send.map(row => row.shot.shot) }
    }
    const changed: number[] = [], failed: number[] = []
    for (const refused of result.refused) {
      const row = isFields(refused) && typeof refused.shot_id === 'string' ? byId.get(refused.shot_id) : undefined
      if (row === undefined) throw invalidPlan()
      if (isFields(refused) && refused.reason === 'video_changed') changed.push(row.shot.shot)
      else failed.push(row.shot.shot)
    }
    if (changed.length > 0) return { kind: 'waiting', changed: changed.sort((a, b) => a - b) }
    if (failed.length > 0) return { kind: 'blocked', reason: 'subtitle_job_failed', shots: failed.sort((a, b) => a - b) }
    for (const written of result.shots) {
      const row = isFields(written) && typeof written.shot_id === 'string' ? byId.get(written.shot_id) : undefined
      if (row === undefined || !isFields(written) || !Array.isArray(written.items)) throw invalidPlan()
      kept.set(row.shot.shot, { items: written.items.map(reviewItem),
        stored: { video_path: row.shot.jingliu?.video_path ?? '', key: row.state.key, job: String(receipt.job_id) } })
    }
    const unwritten = send.filter(row => !kept.has(row.shot.shot)).map(row => row.shot.shot)
    if (unwritten.length > 0) return { kind: 'blocked', reason: 'subtitle_job_failed', shots: unwritten }
    return { kind: 'stored', shots: kept }
  }

  const call = (signal?: AbortSignal) => signal ?? new AbortController().signal
  return { kind: 'jingliu', root, clockReview: false, filesPattern: filesPattern(project),
    resolve: async (episodes, signal) => {
      let plan: unknown
      try { plan = await session.request(`${route}/edit-plan`, { method: 'POST', body: { episodes: [...episodes] }, signal: call(signal) }) }
      catch (error) {
        if (!missingRoute(error)) throw error
        return episodes.map(episode => ({ kind: 'blocked', episode, reason: 'jingliu_outdated', shots: [] }))
      }
      if (!isFields(plan) || !Array.isArray(plan.names) || !Array.isArray(plan.episodes)) throw invalidPlan()
      const names = plan.names.filter((name): name is string => typeof name === 'string')
      const rows = new Map(plan.episodes.map((row) => {
        if (!isFields(row) || !Number.isSafeInteger(row.episode)) throw invalidPlan()
        return [row.episode as number, row] as const
      }))
      const out: (ResolvedEpisode | BlockedEpisode)[] = []
      for (const episode of episodes) {
        const row = rows.get(episode)
        if (row === undefined) throw invalidPlan()
        out.push(await resolveEpisode(row, names, call(signal)))
      }
      return out
    },
    store: async (episode, shots, signal) => await store(episode, shots, call(signal)) }
}
