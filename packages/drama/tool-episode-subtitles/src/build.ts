/**
 * Build episode subtitles from the current files: transcripts by audio digest, correction by the shared rules,
 * and a clock laid out again from the measured durations on every call.
 *
 * The per-shot cache key is the transcript, lines, names, rules and the shot's own decisions. New audio redoes
 * recognition for that shot only; a script edit redoes correction only; a trim or reorder redoes only the clock.
 * The SRT and its version 2 receipt are published only when every shot is terminal; an episode with recognition
 * pending or blocked keeps its previous files.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { cueRateFindings, formatSrtDocument, readSubtitleClockReceipt, sourceClockSha256, subtitleClockRows,
  writeSubtitleClock } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import { readShotTranscript, transcribeShots, type AsrDeps, type AsrOutcome, type AsrRequest } from './asr.ts'
import { placeShotCues, sourceSpan } from './clock.ts'
import type { HashCache } from './hash-cache.ts'
import type { BlockReason, DecisionAction, EpisodeSource, ResolvedEpisode, RulesShot, ShotState, SourceShot,
  ShotTranscript, SubtitleRules } from './types.ts'

/** Producer name written into version 2 clock receipts. */
export const PRODUCER = 'episode_subtitles'
/** Review kinds produced by the clock layout rather than the rules. */
const CLOCK_KINDS = new Set(['cut_by_trim', 'too_fast'])

/** Services of one build call. */
export interface BuildDeps {
  readonly source: EpisodeSource
  readonly rules: SubtitleRules
  readonly asr: AsrDeps
  readonly hash: HashCache
}

/** One episode's outcome. */
export type EpisodeOutcome =
  | { readonly episode: number; readonly status: 'ready' | 'needs_review'; readonly pending: number; readonly changed: readonly number[] }
  | { readonly episode: number; readonly status: 'waiting'; readonly changed: readonly number[] }
  | { readonly episode: number; readonly status: 'blocked'; readonly reason: BlockReason; readonly shots: readonly number[] }

/** Everything one build call produced. */
export interface BuildOutcome {
  readonly episodes: readonly EpisodeOutcome[]
  readonly asr: Pick<AsrOutcome, 'newSeconds' | 'pendingPacks' | 'retryAfter'>
}

/** A review item placed on the episode clock, as `NN.review.json` stores it. */
export type EpisodeReviewItem = {
  readonly id: string
  readonly episode: number
  readonly shot: number
  readonly kind: string
  readonly heard: string
  readonly script: string
  readonly start: number
  readonly end: number
  readonly decision: DecisionAction | null
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Read an episode's decisions.
 * @param file - `NN.decisions.json`.
 * @returns Action by review item ID.
 */
export async function readDecisions(file: string): Promise<Map<string, DecisionAction>> {
  const value = await readJson<{ decisions?: Record<string, DecisionAction> }>(file)
  return new Map(Object.entries(value?.decisions ?? {}))
}

/**
 * Save an episode's decisions.
 * @param file - `NN.decisions.json`.
 * @param decisions - Action by review item ID.
 * @returns When written.
 */
export async function writeDecisions(file: string, decisions: ReadonlyMap<string, DecisionAction>): Promise<void> {
  await writeJson(file, { version: 1, decisions: Object.fromEntries([...decisions].sort(([a], [b]) => a.localeCompare(b))) })
}

/**
 * Read an episode's current review items.
 * @param file - `NN.review.json`.
 * @returns Items on the episode clock, or undefined before the first build.
 */
export async function readReview(file: string): Promise<readonly EpisodeReviewItem[] | undefined> {
  return (await readJson<{ items?: EpisodeReviewItem[] }>(file))?.items
}

interface ShotWork {
  readonly shot: SourceShot
  readonly durationUs: number
  readonly audioSha: string
  transcript?: { readonly transcript: ShotTranscript; readonly sha256: string }
}

interface ReadyShot {
  readonly shot: SourceShot
  readonly durationUs: number
  readonly audioSha: string
  readonly key: string
  readonly rules: RulesShot
  readonly before?: ShotState
}

interface ReadyEpisode {
  readonly episode: ResolvedEpisode
  readonly shots: readonly ReadyShot[]
  readonly decisions: ReadonlyMap<string, DecisionAction>
  readonly changed: readonly number[]
}

/** Build request of one call. */
export interface BuildRequest {
  readonly episodes: readonly number[]
  /** Polling budget for pending recognition, in milliseconds. */
  readonly waitMs: number
  /** Whether shots without a transcript may be transcribed in this call. */
  readonly allowAsr: boolean
}

function workOf(episode: ResolvedEpisode): { shot: SourceShot; durationUs: number }[] {
  return episode.shots.map((shot, index) => {
    const clock = episode.clock[index]
    if (clock === undefined) throw new Error(`EP${episode.code} 的镜头与实测时长数量不一致。`)
    return { shot, durationUs: clock.durationUs }
  })
}

/**
 * Build the requested episodes.
 * @param deps - Source, rules, recognition and digest cache.
 * @param request - Episodes, polling budget and whether new recognition may start.
 * @param signal - Owning call cancellation.
 * @returns Per-episode outcome and the recognition summary.
 */
export async function buildEpisodes(deps: BuildDeps, request: BuildRequest, signal?: AbortSignal): Promise<BuildOutcome> {
  const resolved = await deps.source.resolve(request.episodes, signal)
  const work = new Map<ResolvedEpisode, ShotWork[]>()
  for (const episode of resolved) {
    if (episode.kind !== 'ok') continue
    const shots: ShotWork[] = []
    for (const { shot, durationUs } of workOf(episode)) {
      const audioSha = await deps.hash.sha256(shot.audio, signal)
      const transcript = await readShotTranscript(deps.source.root, audioSha)
      shots.push({ shot, durationUs, audioSha, ...(transcript === undefined ? {} : { transcript }) })
    }
    work.set(episode, shots)
  }
  const misses: AsrRequest[] = [...work.values()].flat().filter(item => item.transcript === undefined)
    .map(item => ({ audio_sha256: item.audioSha, audio: item.shot.audio }))
  const asr: AsrOutcome = misses.length > 0 && request.allowAsr
    ? await transcribeShots(misses, deps.asr, { allowNew: true, waitMs: request.waitMs }, signal)
    : { states: new Map(), newSeconds: 0, pendingPacks: 0 }

  const rulesSha = await deps.rules.digest()
  const outcomes = new Map<number, EpisodeOutcome>()
  const ready: ReadyEpisode[] = []
  const requests = new Map<string, RulesShot>()
  for (const episode of resolved) {
    if (episode.kind !== 'ok') {
      outcomes.set(episode.episode, { episode: episode.episode, status: 'blocked', reason: episode.reason, shots: episode.shots })
      continue
    }
    const shots = work.get(episode) ?? []
    const blocked: { shot: number; reason: BlockReason }[] = []
    const transcripts: { item: ShotWork; transcript: ShotTranscript; sha256: string }[] = []
    for (const item of shots) {
      const state = asr.states.get(item.audioSha)
      const found = item.transcript ?? (state?.kind === 'ready' ? { transcript: state.transcript, sha256: state.sha256 } : undefined)
      if (found !== undefined) transcripts.push({ item, ...found })
      else if (state?.kind === 'blocked') blocked.push({ shot: item.shot.shot, reason: state.reason })
    }
    const [first] = blocked
    if (first !== undefined) {
      outcomes.set(episode.episode, { episode: episode.episode, status: 'blocked', reason: first.reason, shots: blocked.map(row => row.shot) })
      continue
    }
    const stored = await readJson<{ shots?: ShotState[] }>(episode.files.state)
    const previous = new Map((stored?.shots ?? []).map(state => [state.shot, state]))
    const decisions = await readDecisions(episode.files.decisions)
    if (transcripts.length < shots.length) {
      const changed = shots.filter((item) => {
        const before = previous.get(item.shot.shot)
        return before !== undefined && before.audio_sha256 !== item.audioSha
      }).map(item => item.shot.shot)
      outcomes.set(episode.episode, { episode: episode.episode, status: 'waiting', changed })
      continue
    }
    const changed: number[] = []
    const readyShots: ReadyShot[] = []
    for (const { item, transcript, sha256 } of transcripts) {
      const before = previous.get(item.shot.shot)
      const relevantIds = before === undefined ? [...decisions.keys()]
        : before.items.filter(row => !CLOCK_KINDS.has(row.kind)).map(row => row.id)
      const own = relevantIds.flatMap((id) => {
        const action = decisions.get(id)
        return action === undefined ? [] : [{ id, action }]
      }).sort((left, right) => left.id.localeCompare(right.id))
      const key = sha([sha256, item.shot.lines, episode.names, rulesSha, own])
      if (before !== undefined && before.key !== key) changed.push(item.shot.shot)
      const rules: RulesShot = { key, audio_sha256: item.audioSha, words: transcript.words, lines: item.shot.lines, names: episode.names,
        decisions: own, flags: transcript.flags }
      if (before?.key !== key && !requests.has(key)) requests.set(key, rules)
      readyShots.push({ shot: item.shot, durationUs: item.durationUs, audioSha: item.audioSha, key, rules,
        ...(before === undefined ? {} : { before }) })
    }
    ready.push({ episode, shots: readyShots, decisions, changed })
  }

  const ran = requests.size === 0 ? [] : await deps.rules.run([...requests.values()], signal)
  const results = new Map(ran.map(result => [result.key, result]))
  for (const { episode, shots, decisions, changed } of ready) {
    const computed = shots.map((item) => {
      const result = results.get(item.key)
      if (result !== undefined) {
        const state: ShotState = { shot: item.shot.shot, audio_sha256: item.audioSha, key: item.key, cues: result.cues,
          items: result.items }
        return { item, state }
      }
      if (item.before === undefined) throw new Error(`EP${episode.code} 镜头 ${String(item.shot.shot)} 缺少字幕规则结果。`)
      return { item, state: item.before }
    })
    let states = computed.map(row => row.state)
    if (deps.source.store !== undefined) {
      const stored = await deps.source.store(episode,
        computed.map(({ item, state }) => ({ shot: item.shot, rules: item.rules, state })), signal)
      if (stored.kind === 'blocked') {
        outcomes.set(episode.episode, { episode: episode.episode, status: 'blocked', reason: stored.reason, shots: stored.shots })
        continue
      }
      if (stored.kind === 'waiting') {
        outcomes.set(episode.episode, { episode: episode.episode, status: 'waiting',
          changed: [...new Set([...changed, ...stored.changed])].sort((a, b) => a - b) })
        continue
      }
      states = states.map((state) => {
        const row = stored.shots.get(state.shot)
        return row === undefined ? state : { ...state, items: row.items, stored: row.stored }
      })
    }
    const { text, review } = layoutEpisode(episode, shots, states, decisions, deps.source.clockReview)
    const pending = review.filter(row => row.decision === null).length
    await publish(episode, text, rulesSha, pending, deps.hash, signal)
    await writeJson(episode.files.state, { version: 1, episode: episode.code, rules_sha256: rulesSha, shots: states })
    await writeJson(episode.files.review, { version: 1, episode: episode.code, pending, items: review })
    outcomes.set(episode.episode, { episode: episode.episode, status: pending > 0 ? 'needs_review' : 'ready', pending,
      changed: [...changed].sort((a, b) => a - b) })
  }
  return { episodes: request.episodes.map((episode) => {
    const outcome = outcomes.get(episode)
    if (outcome === undefined) throw new Error(`EP${String(episode)} 没有构建结果。`)
    return outcome
  }), asr: { newSeconds: asr.newSeconds, pendingPacks: asr.pendingPacks,
    ...(asr.retryAfter === undefined ? {} : { retryAfter: asr.retryAfter }) } }
}

/**
 * Lay one episode out on its clock: cues, clipped or fast cues as review items, and the SRT text.
 * @param episode - Resolved episode.
 * @param shots - Shots in clip order with measured durations.
 * @param states - Correction results in the same order.
 * @param decisions - Episode decisions by item ID.
 * @param clockReview - Whether clipped and too-fast cues become review items.
 * @returns SRT text and review items on the episode clock.
 */
function layoutEpisode(episode: ResolvedEpisode, shots: readonly ReadyShot[], states: readonly ShotState[],
  decisions: ReadonlyMap<string, DecisionAction>, clockReview: boolean): { text: string; review: EpisodeReviewItem[] } {
  const placedCues: { startSeconds: number; endSeconds: number; text: string }[] = []
  const review: EpisodeReviewItem[] = []
  let clipStartUs = 0
  for (const [position, { shot, durationUs }] of shots.entries()) {
    const state = states[position]
    if (state === undefined) continue
    const clipStart = clipStartUs / 1_000_000
    const at = (start: number, end: number) => {
      const span = sourceSpan(shot.window, start, end)
      const from = clipStart + (span?.[0] ?? (start < shot.window.clipInUs / 1e6 ? 0 : durationUs / 1e6))
      return { start: Math.round(from * 1000) / 1000, end: Math.round((from + (span?.[1] ?? 0)) * 1000) / 1000 }
    }
    for (const item of state.items) {
      review.push({ id: item.id, episode: episode.episode, shot: shot.shot, kind: item.kind, heard: item.heard,
        script: item.script, ...at(item.start, item.end), decision: item.decision })
    }
    const clockItem = (kind: string, cue: { text: string; start: number; end: number }): EpisodeReviewItem => {
      const id = sha([kind, state.audio_sha256, durationUs, cue.start, cue.end, cue.text]).slice(0, 12)
      return { id, episode: episode.episode, shot: shot.shot, kind, heard: cue.text, script: '', ...at(cue.start, cue.end),
        decision: decisions.get(id) ?? null }
    }
    const { placed, cut } = placeShotCues(state.cues, shot.window, clipStart)
    const dropped = new Set<number>()
    if (!clockReview) {
      for (const cue of placed) placedCues.push(cue)
      clipStartUs += durationUs
      continue
    }
    for (const row of cut) {
      const entry = clockItem('cut_by_trim', row)
      review.push(entry)
      if (entry.decision === 'drop') dropped.add(row.cue)
    }
    const starts = new Map([[shot.shot, clipStart]])
    for (const cue of placed) {
      const source = state.cues[cue.cue]
      if (source === undefined || cueRateFindings([{ shot: shot.shot, text: cue.text, startSeconds: cue.startSeconds,
        endSeconds: cue.endSeconds, timingSource: 'asr_aligned' }], starts).length === 0) continue
      const entry = clockItem('too_fast', source)
      review.push(entry)
      if (entry.decision === 'drop') dropped.add(cue.cue)
    }
    for (const cue of placed) if (!dropped.has(cue.cue)) placedCues.push(cue)
    clipStartUs += durationUs
  }
  review.sort((left, right) => left.start - right.start || left.end - right.end)
  placedCues.sort((left, right) => left.startSeconds - right.startSeconds)
  return { text: formatSrtDocument(placedCues.map((cue, index) => ({ index: index + 1, ...cue }))), review }
}

async function publish(episode: ResolvedEpisode, text: string, rulesSha: string, pending: number, hash: HashCache,
  signal?: AbortSignal): Promise<void> {
  const hashFile = (file: string, hashSignal?: AbortSignal) => hash.sha256(file, hashSignal)
  let current: string | undefined
  try { current = await readFile(episode.files.srt, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const receipt = current === text ? (await readSubtitleClockReceipt(episode.files.srt, signal))?.receipt : undefined
  if (receipt?.version === 2 && receipt.rules_sha256 === rulesSha && receipt.review_pending === pending
    && receipt.source_clock_sha256 === sourceClockSha256(episode.code, await subtitleClockRows(episode.clock, signal, hashFile))) return
  const jingliu = new Map(episode.shots.flatMap(shot => shot.jingliu === undefined ? [] : [[shot.shot, shot.jingliu] as const]))
  await writeSubtitleClock(episode.files.srt, text, episode.code, episode.clock, undefined,
    { producer: PRODUCER, rules_sha256: rulesSha, review_pending: pending, ...(jingliu.size === 0 ? {} : { jingliu }) }, hashFile)
  await writeFileAtomic(episode.files.srt, text, { mode: 0o600, dirMode: 0o700 })
}
