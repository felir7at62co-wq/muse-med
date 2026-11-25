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
 *
 * A shot with legacy rows (written before Jingliu recorded where a subtitle came from, so possibly added by hand) is
 * sent only when the call allows replacing them; otherwise it is reported for the user to choose. Hand-added rows are
 * never replaced, so every shot is sent whatever hand-added rows it has.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JingliuSession, LocalMedia } from '@deepseek-ai/dsh-jingliu-connection'
import { mediaPath } from '@deepseek-ai/dsh-jingliu-connection/media'
import { existingSubmission, missingRoute, submitOnce } from '@deepseek-ai/dsh-tool-jingliu/library'
import { episodeNumberOf, type ResolvedShot } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import type { BlockedEpisode, BlockReason, DecisionAction, EpisodeFiles, EpisodeSource, RemoteSubtitles, ResolvedEpisode,
  ReviewItem, SourceShot, StoredMark, StoreOptions, StoreOutcome, StoreShot } from './types.ts'

/**
 * Provider used when this Host has no Jingliu connection.
 * @param root - Workspace folder of the Jingliu project.
 * @param project - Jingliu project ID as the model passed it.
 * @returns A source that blocks every episode with `jingliu_outdated`.
 */
export function unavailableJingliuSource(root: string, project: string): EpisodeSource {
  return { kind: 'jingliu', root, clockReview: false, filesPattern: filesPattern(project),
    resolve: episodes => Promise.resolve(episodes.map(episode => ({ kind: 'blocked', episode, reason: 'jingliu_outdated', shots: [] }))) }
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
/** Submissions of one segments payload: the first, then resubmissions after a lost answer or a failed job. */
const MAX_ATTEMPTS = 3
const outcomeUnknown = (error: unknown) => error instanceof HarnessError && error.code === 'JINGLIU_JOB_OUTCOME_UNKNOWN'

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
  const { status, legacy } = value.subtitles
  if (typeof status !== 'string' || !STATUSES.has(status as RemoteSubtitles['status'])
    || !(legacy === undefined || Number.isSafeInteger(legacy))) throw invalidPlan()
  const speed = finite(value.speed, 0)
  if (speed <= 0) throw invalidPlan()
  return { shotId: value.shot_id, order: value.order as number, videoPath: value.video_path ? mediaPath(value.video_path).path : null,
    etag: typeof value.video_etag === 'string' ? value.video_etag : '', clipInSec: finite(value.clip_in_sec, 0),
    clipDurSec: finite(value.clip_dur_sec, 0), speed, outputSec: finite(value.output_sec, 0), lines: value.lines,
    // A server that does not count legacy rows reports them only as `unverified`; treat that as legacy rows.
    remote: { status: status as RemoteSubtitles['status'], legacy: typeof legacy === 'number' ? legacy : status === 'unverified' ? 1 : 0 } }
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
    const filmed = shots.filter((shot): shot is PlanShot & { readonly videoPath: string } => shot.videoPath !== null)
    if (filmed.length !== shots.length) return blocked('video_missing', shots.filter(shot => shot.videoPath === null).map(shot => shot.order))
    const paths = filmed.map(shot => shot.videoPath)
    let local: Map<string, LocalMedia>
    try { local = await download(paths, signal) }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof HarnessError && error.code === 'JINGLIU_MEDIA_LOCAL_DISABLED') throw error
      // One failed file rejects the batch after the others are indexed; find which shots cannot be read.
      const settled = await Promise.allSettled(paths.map(async path => await download([path], signal)))
      const failed = filmed.filter((_shot, index) => settled[index]?.status === 'rejected').map(shot => shot.order)
      if (failed.length > 0) return blocked('media_unavailable', failed)
      local = await download(paths, signal)
    }
    const sources: SourceShot[] = [], clock: ResolvedShot[] = []
    for (const shot of filmed) {
      const file = local.get(shot.videoPath)
      if (file === undefined) return blocked('media_unavailable', [shot.order])
      sources.push({ shot: shot.order, audio: file.file, lines: shot.lines, remote: shot.remote,
        window: { clipInUs: micro(shot.clipInSec), durationUs: micro(shot.clipDurSec), speed: shot.speed },
        jingliu: {
          shot_id: shot.shotId, video_path: shot.videoPath, etag: shot.etag, clip_in_us: micro(shot.clipInSec), speed: shot.speed,
        } })
      clock.push({ source: { shot: shot.order, video: file.file, audio: file.file }, video: file.file, audio: file.file,
        durationUs: Math.max(1, micro(shot.outputSec)) })
    }
    const code = episodeNumberOf(episode)
    return { kind: 'ok', episode, code, shots: sources, clock, names, files: episodeFiles(root, code) }
  }

  // Set once the edit plan answered in this call: Jingliu is reachable and the shots' videos are the ones resolved.
  let planned = false
  const readJob = async (id: string, signal: AbortSignal): Promise<Fields> => {
    const job = await session.request(`/jobs/${encodeURIComponent(id)}`, { signal })
    if (!isFields(job) || typeof job.status !== 'string') throw invalidPlan()
    return job
  }
  const segmentsResult = (job: Fields): { readonly shots: readonly unknown[]; readonly refused: readonly unknown[] } | undefined => {
    let result: unknown
    try { result = typeof job.result === 'string' ? JSON.parse(job.result) : undefined }
    catch (error) { throw new HarnessError('镜流字幕任务返回的结果无法读取。', 'EPISODE_SUBTITLES_JINGLIU_INVALID', { cause: error }) }
    return isFields(result) && result.mode === 'segments' && Array.isArray(result.shots) && Array.isArray(result.refused)
      ? { shots: result.shots, refused: result.refused } : undefined
  }

  const store = async (episode: ResolvedEpisode, shots: readonly StoreShot[], choice: StoreOptions,
    signal: AbortSignal): Promise<StoreOutcome> => {
    const kept = new Map<number, { items: readonly ReviewItem[]; stored: StoredMark }>()
    const send: (StoreShot & { readonly jingliu: NonNullable<SourceShot['jingliu']> })[] = [], legacy: number[] = []
    for (const row of shots) {
      const { shot, state } = row
      const { jingliu, remote } = shot
      if (jingliu === undefined || remote === undefined) throw invalidPlan()
      const current = state.stored?.key === state.key && state.stored.video_path === jingliu.video_path
      if (remote.status === 'fresh' && current) continue
      if (remote.legacy > 0 && !choice.replaceLegacy) { legacy.push(shot.shot); continue }
      send.push({ ...row, jingliu })
    }
    if (send.length === 0) return { kind: 'stored', shots: kept, legacy }
    const byId = new Map(send.map(row => [row.jingliu.shot_id, row]))
    const segments = send.map(({ jingliu, rules }) => ({ shot_id: jingliu.shot_id, video_url: jingliu.video_path,
      source_sha256: rules.audio_sha256, words: rules.words, decisions: rules.decisions, flags: rules.flags }))
    const payload = { project_id: project, episode: episode.episode, ...(choice.replaceLegacy ? { replace_legacy: true } : {}), segments }
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    // A shot whose stored rows vanished is sent again with the same payload; the prior job IDs make that a new submission.
    const prior = send.map(row => row.state.stored?.job ?? '').sort()
    const dir = join(root, 'subtitles', 'jobs')
    const base = [session.identity, project, String(episode.episode), digest, ...prior]
    const input = [session.identity, project, episode.episode, digest]
    const sent = send.map(row => row.shot.shot)
    // The segments job is free and replaces only these shots' rows, so once the edit plan answered in this call, an earlier
    // submission whose answer was lost or whose job failed is sent again under the next attempt key. Paid recognition never
    // takes this path: its receipts are only queried or resumed.
    let receipt: Fields | undefined, job: Fields | undefined
    let lost = false
    for (let attempt = 0; receipt === undefined; attempt++) {
      if (attempt >= MAX_ATTEMPTS || (attempt > 0 && !planned)) {
        return { kind: 'blocked', reason: lost ? 'subtitle_job_unknown' : 'subtitle_job_failed', shots: sent }
      }
      const key = attempt === 0 ? base : [...base, `attempt:${String(attempt)}`]
      let saved: Fields | undefined
      try { saved = await existingSubmission(dir, key, input) }
      catch (error) {
        if (!outcomeUnknown(error)) throw error
        lost = true
        continue
      }
      if (saved === undefined) {
        try {
          receipt = await submitOnce(dir, key, input, async () => await session.request('/jobs', { method: 'POST', signal,
            body: { kind: 'auto_subtitles', payload } }))
        } catch (error) {
          if (outcomeUnknown(error)) return { kind: 'blocked', reason: 'subtitle_job_unknown', shots: sent }
          throw error
        }
        break
      }
      const previous = await readJob(String(saved.job_id), signal)
      lost = false
      if (previous.status === 'failed' && segmentsResult(previous) === undefined) continue
      receipt = saved
      job = previous
    }
    const deadline = Date.now() + options.jobWaitMs
    while (job === undefined || job.status === 'pending' || job.status === 'running') {
      if (job !== undefined) {
        if (Date.now() + options.pollIntervalMs > deadline) return { kind: 'waiting', changed: [] }
        await sleep(options.pollIntervalMs, undefined, { signal })
      }
      job = await readJob(String(receipt.job_id), signal)
    }
    const result = segmentsResult(job)
    if (result === undefined) {
      return { kind: 'blocked', reason: job.status === 'done' ? 'jingliu_outdated' : 'subtitle_job_failed', shots: sent }
    }
    const changed: number[] = [], failed: number[] = []
    for (const refused of result.refused) {
      if (!isFields(refused) || typeof refused.shot_id !== 'string') throw invalidPlan()
      const row = byId.get(refused.shot_id)
      if (row === undefined) throw invalidPlan()
      if (refused.reason === 'video_changed') changed.push(row.shot.shot)
      else if (refused.reason === 'legacy_subtitles') legacy.push(row.shot.shot)
      else failed.push(row.shot.shot)
    }
    if (changed.length > 0) return { kind: 'waiting', changed: changed.sort((a, b) => a - b) }
    if (failed.length > 0) return { kind: 'blocked', reason: 'subtitle_job_failed', shots: failed.sort((a, b) => a - b) }
    for (const written of result.shots) {
      if (!isFields(written) || typeof written.shot_id !== 'string' || !Array.isArray(written.items)) throw invalidPlan()
      const row = byId.get(written.shot_id)
      if (row === undefined) throw invalidPlan()
      kept.set(row.shot.shot, { items: written.items.map(reviewItem),
        stored: { video_path: row.jingliu.video_path, key: row.state.key, job: String(receipt.job_id) } })
    }
    const unwritten = send.filter(row => !kept.has(row.shot.shot) && !legacy.includes(row.shot.shot)).map(row => row.shot.shot)
    if (unwritten.length > 0) return { kind: 'blocked', reason: 'subtitle_job_failed', shots: unwritten }
    return { kind: 'stored', shots: kept, legacy: legacy.sort((a, b) => a - b) }
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
      planned = true
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
    store: async (episode, shots, storeOptions, signal) => await store(episode, shots, storeOptions, call(signal)) }
}
