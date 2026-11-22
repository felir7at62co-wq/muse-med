/**
 * `episode_subtitles` call handling: argument checks, the per-root build lock, review paging and decisions, and the
 * compact results the model reads.
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { createMediaToolkit, type MediaToolkit } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import type { AudioAccount, AudioMediaOperations } from '@deepseek-ai/dsh-tool-audio-transcribe/runner'
import { buildEpisodes, readDecisions, readReview, writeDecisions, type BuildOutcome, type EpisodeReviewItem } from './build.ts'
import { HashCache } from './hash-cache.ts'
import { localSource } from './shots.ts'
import { jingliuSource, unavailableJingliuSource } from './source.ts'
import { projectMediaFolder, type JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { DecisionAction, EpisodeSource, EpisodeSourceKind, SubtitleRules } from './types.ts'

/** A JSON object result. */
export type JsonObject = { [key: string]: JsonValue }

/** Model arguments of one call. */
export interface EpisodeSubtitlesArgs {
  readonly method?: 'build' | 'review' | undefined
  readonly source: EpisodeSourceKind
  readonly project: string
  readonly episodes: readonly number[]
  readonly wait_seconds?: number | undefined
  readonly decisions?: readonly { readonly id: string; readonly action: DecisionAction }[] | undefined
  readonly offset?: number | undefined
}

/** Deployment settings the call handler reads. */
export interface EpisodeSubtitlesSettings {
  /** FFmpeg executable that decodes shot speech for packing and staging. */
  readonly ffmpegPath: string
  /** ffprobe executable that measures shot and pack durations. */
  readonly ffprobePath: string
  /** Longest packed upload in seconds, silence included; at most the transcription chunk, so a pack is never split. */
  readonly packSeconds: number
  /** Digital silence after each shot in a pack, in seconds. */
  readonly gapSeconds: number
  /** Most episodes one call accepts. */
  readonly maxEpisodes: number
  /** Review items per page. */
  readonly reviewPageSize: number
  /** Deadline of one probe or extraction command, in milliseconds. */
  readonly commandTimeoutMs: number
  /** Longest pack the transcription runner accepts, in seconds. */
  readonly maxDurationSeconds: number
  /** Largest staged pack, in bytes. */
  readonly maxAudioBytes: number
  /** Delay between read-only queries of a pending pack, in milliseconds. */
  readonly pollIntervalMs: number
  /** Total wait one call spends on `upload_busy` and `request_rate` refusals before reporting them, in milliseconds. */
  readonly uploadRetryBudgetMs: number
  /** Packs submitted by one runner batch. */
  readonly maxBatchInputs: number
  /** How long a call waits for another build of the same root, in milliseconds. */
  readonly lockWaitMs: number
  /** Longest wait for one Jingliu subtitle job inside a call, in milliseconds. */
  readonly jingliuJobWaitMs: number
}

/** Services of one call. */
export interface EpisodeSubtitlesServices {
  readonly account: AudioAccount
  readonly rules: SubtitleRules
  /** Rules with Jingliu's cue width, for the preview of a Jingliu project; `rules` when omitted. */
  readonly jingliuRules?: SubtitleRules
  /**
   * Signed-in Jingliu session for the project the call names.
   * @param project - Jingliu project ID.
   * @returns The session, or undefined when this Host has no Jingliu connection.
   */
  readonly jingliu?: (project: string) => Promise<JingliuSession | undefined>
  /** Session workspace; relative project paths resolve against it. */
  readonly cwd: string | undefined
  /** Deterministic media replacements in tests; production uses FFmpeg and ffprobe from the settings. */
  readonly media?: {
    readonly runner?: AudioMediaOperations
    readonly extractPcm?: (source: string, target: string, signal?: AbortSignal) => Promise<void>
    readonly toolkit?: MediaToolkit
  }
}

/** A suggested next call. */
type NextCall = { readonly tool: 'episode_subtitles' | 'jianying_draft'; readonly args: JsonObject }

const LIST_LIMIT = 10

function capped(shots: readonly number[]): { shots: number[]; more?: number } {
  return { shots: shots.slice(0, LIST_LIMIT), ...(shots.length > LIST_LIMIT ? { more: shots.length - LIST_LIMIT } : {}) }
}

function check(args: EpisodeSubtitlesArgs, settings: EpisodeSubtitlesSettings): void {
  const problems: string[] = []
  if (args.episodes.length === 0 || args.episodes.length > settings.maxEpisodes) problems.push(`episodes must list 1 to ${String(settings.maxEpisodes)} episodes`)
  if (args.episodes.some(episode => !Number.isSafeInteger(episode) || episode < 1)) problems.push('episodes must be positive integers')
  if (new Set(args.episodes).size !== args.episodes.length) problems.push('episodes must not repeat')
  if (args.wait_seconds !== undefined && (!Number.isFinite(args.wait_seconds) || args.wait_seconds < 0 || args.wait_seconds > 30)) problems.push('wait_seconds must be 0 to 30')
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) problems.push('offset must be a non-negative integer')
  if ((args.method ?? 'build') === 'build' && (args.decisions !== undefined || args.offset !== undefined)) problems.push('decisions and offset belong to method review')
  if (!args.project.trim()) problems.push('project must name a project')
  if (problems.length > 0) throw new ToolArgsError(problems)
}

function projectRoot(args: EpisodeSubtitlesArgs, cwd: string | undefined): string {
  if (args.source === 'jingliu') {
    if (cwd === undefined) throw new ToolArgsError(['source jingliu needs a Session workspace for downloaded media'])
    return projectMediaFolder(cwd, args.project)
  }
  if (isAbsolute(args.project)) return args.project
  if (cwd === undefined) throw new ToolArgsError([`project "${args.project}" is relative but this Session has no workspace; pass an absolute project path`])
  return resolve(cwd, args.project)
}

/**
 * Handle one `episode_subtitles` call.
 * @param args - Validated model arguments.
 * @param settings - Deployment settings.
 * @param services - Account, rules and workspace.
 * @param signal - Owning call cancellation.
 * @returns The compact build or review result.
 */
export async function runEpisodeSubtitles(args: EpisodeSubtitlesArgs, settings: EpisodeSubtitlesSettings,
  services: EpisodeSubtitlesServices, signal?: AbortSignal): Promise<JsonObject> {
  check(args, settings)
  const root = projectRoot(args, services.cwd)
  await mkdir(join(root, 'subtitles'), { recursive: true, mode: 0o700 })
  return await withFileLock(join(root, 'subtitles', '.episode-subtitles'), async () => {
    const hash = await HashCache.load(root)
    try {
      const toolkit = hash.memoizeProbes(services.media?.toolkit
        ?? createMediaToolkit({ ffmpeg: settings.ffmpegPath, ffprobe: settings.ffprobePath }))
      const session = args.source === 'jingliu' ? await services.jingliu?.(args.project) : undefined
      const source: EpisodeSource = args.source === 'local' ? localSource(root, args.project, hash, toolkit)
        : session === undefined ? unavailableJingliuSource(root, args.project)
          : jingliuSource({ root, project: args.project, session, jobWaitMs: settings.jingliuJobWaitMs,
            pollIntervalMs: settings.pollIntervalMs })
      const rules = args.source === 'jingliu' ? services.jingliuRules ?? services.rules : services.rules
      const deps = { source, rules, hash, asr: { root, account: services.account,
        runner: { ffmpegPath: settings.ffmpegPath, ffprobePath: settings.ffprobePath, commandTimeoutMs: settings.commandTimeoutMs,
          maxDurationSeconds: settings.maxDurationSeconds, maxAudioBytes: settings.maxAudioBytes },
        pacing: { retryBudgetMs: settings.uploadRetryBudgetMs }, pollIntervalMs: settings.pollIntervalMs,
        packSeconds: settings.packSeconds, gapSeconds: settings.gapSeconds, maxBatchInputs: settings.maxBatchInputs,
        ...(services.media === undefined ? {} : { media: services.media }) } }
      if ((args.method ?? 'build') === 'build') {
        const waitMs = (args.wait_seconds ?? 0) * 1000
        const outcome = await buildEpisodes(deps, { episodes: args.episodes, waitMs, allowAsr: true }, signal)
        return buildResult(outcome, args, source.filesPattern)
      }
      return await review(args, settings, deps, signal)
    } finally { await hash.save() }
  }, { waitMs: settings.lockWaitMs, ...(signal === undefined ? {} : { signal }) })
}

async function review(args: EpisodeSubtitlesArgs, settings: EpisodeSubtitlesSettings, deps: Parameters<typeof buildEpisodes>[0],
  signal?: AbortSignal): Promise<JsonObject> {
  const resolved = await deps.source.resolve(args.episodes, signal)
  const files = new Map(resolved.flatMap(episode => episode.kind === 'ok' ? [[episode.episode, episode.files] as const] : []))
  let applied = 0
  const unknown: string[] = []
  let outcome: BuildOutcome | undefined
  if (args.decisions !== undefined && args.decisions.length > 0) {
    const owners = new Map<string, number>()
    for (const [episode, paths] of files) for (const item of await readReview(paths.review) ?? []) owners.set(item.id, episode)
    const changes = new Map<number, Map<string, DecisionAction>>()
    for (const decision of args.decisions) {
      const episode = owners.get(decision.id)
      if (episode === undefined) { unknown.push(decision.id); continue }
      const paths = files.get(episode)
      if (paths === undefined) { unknown.push(decision.id); continue }
      const map = changes.get(episode) ?? await readDecisions(paths.decisions)
      map.set(decision.id, decision.action)
      changes.set(episode, map)
      applied++
    }
    for (const [episode, map] of changes) {
      const paths = files.get(episode)
      if (paths !== undefined) await writeDecisions(paths.decisions, map)
    }
    if (changes.size > 0) outcome = await buildEpisodes(deps, { episodes: [...changes.keys()], waitMs: 0, allowAsr: false }, signal)
  }
  const pendingItems: EpisodeReviewItem[] = []
  for (const episode of args.episodes) {
    const paths = files.get(episode)
    if (paths === undefined) continue
    for (const item of await readReview(paths.review) ?? []) if (item.decision === null) pendingItems.push(item)
  }
  const offset = args.offset ?? 0
  const page = pendingItems.slice(offset, offset + settings.reviewPageSize)
    .map(({ decision: _decision, ...item }) => item)
  const nextOffset = offset + settings.reviewPageSize < pendingItems.length ? offset + settings.reviewPageSize : undefined
  const blocked = resolved.filter(episode => episode.kind === 'blocked')
  return { pending: pendingItems.length, items: page, ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
    ...(args.decisions === undefined ? {} : { applied }), ...(unknown.length === 0 ? {} : { unknown }),
    ...(blocked.length === 0 ? {} : {
      blocked: blocked.map(episode => ({ episode: episode.episode, reason: episode.reason, ...capped(episode.shots) })) }),
    ...(outcome === undefined ? {} : { status: overallStatus(outcome) }),
    ...(pendingItems.length === 0 && blocked.length === 0 ? { next: { tool: 'jianying_draft',
      args: { source: args.source, project: args.project, episodes: [...args.episodes] } } satisfies NextCall } : {}) }
}

function overallStatus(outcome: BuildOutcome): 'ready' | 'waiting' | 'needs_review' | 'blocked' {
  const statuses = new Set(outcome.episodes.map(episode => episode.status))
  return statuses.has('waiting') ? 'waiting' : statuses.has('needs_review') ? 'needs_review' : statuses.has('blocked') ? 'blocked' : 'ready'
}

/**
 * Shape a build outcome for the model: grouped by status, at most ten shots per list, about 30 bytes per episode.
 * @param outcome - Per-episode outcome and recognition summary.
 * @param args - The call's source and project, repeated in the next call.
 * @param files - SRT path pattern.
 * @returns The compact result.
 */
export function buildResult(outcome: BuildOutcome, args: Pick<EpisodeSubtitlesArgs, 'source' | 'project'>, files: string): JsonObject {
  const ready: number[] = [], waiting: number[] = [], needsReview: Record<string, number> = {}, changed: Record<string, number[]> = {}
  const blocked: JsonObject[] = []
  for (const episode of outcome.episodes) {
    if (episode.status === 'blocked') { blocked.push({ episode: episode.episode, reason: episode.reason, ...capped(episode.shots) }); continue }
    if (episode.changed.length > 0) changed[String(episode.episode)] = episode.changed.slice(0, LIST_LIMIT)
    if (episode.status === 'waiting') waiting.push(episode.episode)
    else if (episode.status === 'needs_review') needsReview[String(episode.episode)] = episode.pending
    else ready.push(episode.episode)
  }
  const base = { source: args.source, project: args.project }
  const next: NextCall | undefined = waiting.length > 0 ? { tool: 'episode_subtitles', args: { method: 'build', ...base, episodes: waiting, wait_seconds: 30 } }
    : Object.keys(needsReview).length > 0 ? { tool: 'episode_subtitles', args: { method: 'review', ...base, episodes: Object.keys(needsReview).map(Number) } }
      : ready.length > 0 ? { tool: 'jianying_draft', args: { ...base, episodes: ready } } : undefined
  return { status: overallStatus(outcome),
    ...(ready.length === 0 ? {} : { ready }), ...(waiting.length === 0 ? {} : { waiting }),
    ...(Object.keys(needsReview).length === 0 ? {} : { needs_review: needsReview }), ...(blocked.length === 0 ? {} : { blocked }),
    ...(Object.keys(changed).length === 0 ? {} : { changed }),
    asr: { new_seconds: outcome.asr.newSeconds, pending_packs: outcome.asr.pendingPacks,
      ...(outcome.asr.retryAfter === undefined ? {} : { retry_after: outcome.asr.retryAfter }) },
    files, ...(next === undefined ? {} : { next }) }
}
