/** Validate BGM story intervals and compile their FFmpeg mix graph. */

import { isAbsolute, relative, resolve } from 'node:path'
import type { BgmEpisodePlan, BgmPlanSegment, BgmPolicyFinding, ValidatedBgmEpisodePlan } from './types.ts'

/** Default overlap centered on each story boundary. */
export const DEFAULT_CROSSFADE_SECONDS = 1.5

/** Shared source-window mean used by the short-drama renderer. */
export const TARGET_MEAN_DB = -17.5

/** Largest automatic source boost. */
export const MAX_BOOST_DB = 9

const EPSILON_SECONDS = 0.001

/** Limits one batch of episode plans is held to. */
export interface BgmBatchPolicy {
  /** Suggested distinct tracks per episode with music. */
  readonly minTracksPerEpisode: number
  /** Episodes one track may appear in across the whole batch. */
  readonly maxEpisodesPerTrack: number
  /** Suggested tracks not reused by other batch episodes. */
  readonly freshTracksPerEpisode: number
  /** Seconds a cut may sit away from a package boundary. */
  readonly boundaryToleranceSeconds: number
}

/** The policy the short-drama pipeline runs with. */
export const DEFAULT_BGM_BATCH_POLICY: BgmBatchPolicy = {
  minTracksPerEpisode: 1,
  maxEpisodesPerTrack: 2,
  freshTracksPerEpisode: 0,
  boundaryToleranceSeconds: 0.05,
}

/** One episode row as the batch gate reads it. */
export interface BgmBatchRow {
  /** Episode number, conventionally two digits. */
  readonly episode: string
  /** Explicit no-music plans do not receive selection recommendations. */
  readonly music_decision?: 'music' | 'none'
  /** The episode's ordered segments. */
  readonly segments: readonly Pick<BgmPlanSegment, 'track' | 'source' | 'start_seconds' | 'end_seconds'>[]
}

/** What the batch gate compares. */
export interface BgmBatchContext {
  /** Project root that relative sources resolve against. */
  readonly project: string
  /** Every other episode plan in the same batch, including this episode. */
  readonly batch: readonly BgmBatchRow[]
  /** Package boundaries on the body timeline, in seconds. */
  readonly boundaries: readonly number[]
  /** Limits to enforce; defaults to {@link DEFAULT_BGM_BATCH_POLICY}. */
  readonly limits?: BgmBatchPolicy | undefined
}

/**
 * Resolve the identity one segment's track has across a batch.
 *
 * Two episodes share a track when their sources resolve to the same file. The
 * plan's own `track` label is a display name and is not compared: production
 * plans have carried two labels for one file and one label for two files.
 * @param project - Project root that relative sources resolve against.
 * @param source - The segment's declared source.
 * @returns The absolute path that identifies the track.
 */
export function trackIdentity(project: string, source: string): string {
  return isAbsolute(source) ? resolve(source) : resolve(project, source)
}

/**
 * Audit one episode's plan against the batch rules.
 *
 * The rules are per batch, so a single episode cannot be judged alone: a track
 * two episodes share only becomes a problem when a third one joins, and a fresh
 * track is fresh only relative to what the other episodes used.
 *
 * Nothing here blocks the call. The findings are returned in the tool result so
 * the agent reads them before delivering, and each one says what to change.
 * @param selected - The episode being composed.
 * @param context - The batch, its boundaries, and the limits.
 * @returns One finding per rule the plan breaks, in rule order; empty when it breaks none.
 */
export function auditBgmBatch(selected: BgmBatchRow, context: BgmBatchContext): BgmPolicyFinding[] {
  if (selected.music_decision === 'none') return []
  const limits = context.limits ?? DEFAULT_BGM_BATCH_POLICY
  const episode = selected.episode
  const findings: BgmPolicyFinding[] = []
  const tracks = selected.segments.map(segment => trackIdentity(context.project, segment.source))
  const distinct = [...new Set(tracks)]
  if (distinct.length < limits.minTracksPerEpisode) {
    findings.push({ rule: 'R1',
      detail: `第 ${episode} 集用了 ${String(distinct.length)} 首曲子，低于配置建议的 ${String(limits.minTracksPerEpisode)} 首。`,
      fix: '结合剧情和用户偏好考虑是否需要更多曲目；单曲或明确无配乐也可接受，不必为了数量换曲。' })
  }
  if (distinct.length !== tracks.length) {
    const repeated = tracks.filter((track, index) => tracks.indexOf(track) !== index)
    findings.push({ rule: 'R2',
      detail: `第 ${episode} 集在 ${String(tracks.length)} 段里重复使用了同一首曲子：${[...new Set(repeated)].join('、')}。`,
      fix: '检查重复是否符合剧情与用户偏好；需要变化时再替换，不强制每段换曲。' })
  }
  const users = new Map<string, Set<string>>()
  const members = new Map<string, BgmBatchRow>()
  for (const row of [...context.batch, selected]) members.set(row.episode.padStart(2, '0'), row)
  for (const row of members.values()) {
    for (const segment of row.segments) {
      const id = trackIdentity(context.project, segment.source)
      const list = users.get(id) ?? new Set<string>()
      list.add(row.episode.padStart(2, '0'))
      users.set(id, list)
    }
  }
  const selectedTracks = [...users].filter(([id]) => distinct.includes(id))
    .sort(([left], [right]) => distinct.indexOf(left) - distinct.indexOf(right))
  for (const [id, trackUsers] of selectedTracks) {
    const episodes = [...trackUsers].sort()
    if (episodes.length > limits.maxEpisodesPerTrack) {
      findings.push({ rule: 'R3',
        detail: `曲目 ${id} 出现在 ${String(episodes.length)} 集（${episodes.join('、')}），`
          + `超过整批上限 ${String(limits.maxEpisodesPerTrack)} 集。`,
        fix: `复核 ${episodes.slice(limits.maxEpisodesPerTrack).join('、')} 的剧情与偏好；可保留合适的复用，或试听其它曲目。` })
    }
  }
  const fresh = selectedTracks.filter(([, trackUsers]) => trackUsers.size === 1)
  if (fresh.length < limits.freshTracksPerEpisode) {
    findings.push({ rule: 'R4',
      detail: `第 ${episode} 集有 ${String(fresh.length)} 首本批未复用曲目，低于配置建议的 ${String(limits.freshTracksPerEpisode)} 首。`,
      fix: '需要新鲜感时可用 bgm_match 获取其它候选；已认可曲目可以继续使用。' })
  }
  if (context.boundaries.length === 0) {
    findings.push({ rule: 'R5',
      detail: `第 ${episode} 集的切点无法核对：时间线里没有镜头包边界（clips）。`,
      fix: '确认传的是本集时间线（含 clips，通常是 prepare 写出的 editing/<集>-timeline.json），再重跑。' })
    return findings.sort((left, right) => left.rule.localeCompare(right.rule))
  }
  for (const [index, segment] of selected.segments.entries()) {
    if (index === 0) continue
    const nearest = context.boundaries.reduce((closest, boundary) =>
      Math.abs(boundary - segment.start_seconds) < Math.abs(closest - segment.start_seconds) ? boundary : closest)
    if (Math.abs(nearest - segment.start_seconds) > limits.boundaryToleranceSeconds) {
      findings.push({ rule: 'R5',
        detail: `第 ${episode} 集的切点 ${segment.start_seconds.toFixed(3)}s 不在任何镜头包边界上`
          + `（最近的是 ${nearest.toFixed(3)}s）。`,
        fix: '考虑把切点移到镜头包起点；需要段内音乐变化时可保留当前切点并记录理由。' })
    }
  }
  return findings.sort((left, right) => left.rule.localeCompare(right.rule))
}

/**
 * Derive the amount of source audio each story interval contributes before overlaps are removed.
 * @param segments - Contiguous story intervals.
 * @param crossfadeSeconds - Adjacent overlap duration.
 * @returns One source duration per segment.
 */
export function segmentInputDurations(
  segments: readonly Pick<BgmPlanSegment, 'start_seconds' | 'end_seconds'>[],
  crossfadeSeconds: number,
): number[] {
  return segments.map((segment, index) => sourceDuration(segment, segments[index - 1], segments[index + 1], crossfadeSeconds))
}

/** Consume overlap audio only when the neighboring story interval touches. */
function sourceDuration(segment: Pick<BgmPlanSegment, 'start_seconds' | 'end_seconds'>,
  previous: Pick<BgmPlanSegment, 'start_seconds' | 'end_seconds'> | undefined,
  next: Pick<BgmPlanSegment, 'start_seconds' | 'end_seconds'> | undefined, crossfadeSeconds: number): number {
  const before = previous !== undefined && Math.abs(previous.end_seconds - segment.start_seconds) <= EPSILON_SECONDS
  const after = next !== undefined && Math.abs(segment.end_seconds - next.start_seconds) <= EPSILON_SECONDS
  return Number((segment.end_seconds - segment.start_seconds
    + (before ? crossfadeSeconds / 2 : 0) + (after ? crossfadeSeconds / 2 : 0)).toFixed(6))
}

/**
 * Validate one episode row against the measured body duration.
 * @param input - Parsed plan row.
 * @param bodyDurationSeconds - Body duration measured from the episode timeline.
 * @returns Values safe to pass to the analyzer and FFmpeg graph builder.
 */
export function validateEpisodePlan(input: BgmEpisodePlan, bodyDurationSeconds: number): ValidatedBgmEpisodePlan {
  if (!Number.isFinite(bodyDurationSeconds) || bodyDurationSeconds <= 0
    || !Number.isFinite(input.body_duration_seconds)
    || Math.abs(input.body_duration_seconds - bodyDurationSeconds) > EPSILON_SECONDS) {
    throw new Error('BGM 计划正文时长与当前时间线不一致。')
  }
  if (input.music_decision !== undefined && !input.decision_reason?.trim()) {
    throw new Error('明确的配乐决定必须记录 decision_reason。')
  }
  if (input.music_decision === 'none') {
    if (input.segments.length !== 0) throw new Error('不加配乐的计划必须使用空 segments。')
    return { bodyDurationSeconds, crossfadeSeconds: 0, segments: [] }
  }
  const crossfadeSeconds = input.crossfade_seconds ?? DEFAULT_CROSSFADE_SECONDS
  if (!Number.isFinite(crossfadeSeconds) || crossfadeSeconds <= 0) throw new Error('BGM 交叉淡化时长必须大于零。')
  if (!Array.isArray(input.segments) || input.segments.length === 0) throw new Error('BGM 计划没有段落。')
  let expectedStart = 0
  for (const segment of input.segments) {
    if (!segment.track.trim() || !segment.source.trim()) throw new Error('BGM 段落必须包含曲目和来源。')
    if (!segment.reason.trim()) throw new Error('BGM 段落必须记录选曲理由。')
    if (!Number.isFinite(segment.start_seconds) || !Number.isFinite(segment.end_seconds)
      || segment.end_seconds <= segment.start_seconds
      || (input.music_decision === 'music'
        ? segment.start_seconds < expectedStart - EPSILON_SECONDS || segment.end_seconds > bodyDurationSeconds + EPSILON_SECONDS
        : Math.abs(segment.start_seconds - expectedStart) > EPSILON_SECONDS)) {
      throw new Error('BGM 段落必须按顺序连续覆盖正文。')
    }
    if (segment.source_start_seconds !== undefined
      && (!Number.isFinite(segment.source_start_seconds) || segment.source_start_seconds < 0)) {
      throw new Error('BGM 源曲起点必须是非负秒数。')
    }
    expectedStart = segment.end_seconds
  }
  if (input.music_decision !== 'music' && Math.abs(expectedStart - bodyDurationSeconds) > EPSILON_SECONDS) {
    throw new Error('BGM 段落必须按顺序连续覆盖正文。')
  }
  const segments = input.segments.map((segment, index) => ({ ...segment,
    inputDurationSeconds: sourceDuration(segment, input.segments[index - 1], input.segments[index + 1], crossfadeSeconds) }))
  if (segments.some((segment, index) => {
    const previous = segments[index - 1], next = segments[index + 1]
    const adjacent = previous !== undefined && Math.abs(previous.end_seconds - segment.start_seconds) <= EPSILON_SECONDS
      || next !== undefined && Math.abs(segment.end_seconds - next.start_seconds) <= EPSILON_SECONDS
    if (input.music_decision === 'music' && !adjacent) return false
    return segment.inputDurationSeconds <= crossfadeSeconds
      || segment.end_seconds - segment.start_seconds < crossfadeSeconds
  })) {
    throw new Error('BGM 交叉淡化不能长于最短剧情段。')
  }
  return {
    bodyDurationSeconds,
    crossfadeSeconds,
    segments,
  }
}

/**
 * Calculate the source-window gain used before crossfading.
 * @param meanDb - Mean volume reported by FFmpeg volumedetect.
 * @returns Gain in decibels, capped at {@link MAX_BOOST_DB}.
 */
export function appliedGain(meanDb: number): number {
  if (!Number.isFinite(meanDb)) throw new Error('BGM 源曲响度不是有效数值。')
  return Number(Math.min(TARGET_MEAN_DB - meanDb, MAX_BOOST_DB).toFixed(1))
}

/**
 * Build the complete audio graph for ordered source tracks.
 * @param inputDurations - Dense ordered source contribution durations before overlaps are removed.
 * @param sourceStarts - Dense source offsets in seconds, with one item per contribution.
 * @param gainsDb - Dense per-source gains in decibels, with one item per contribution.
 * @param bodyDurationSeconds - Exact output duration.
 * @param crossfadeSeconds - Adjacent overlap duration.
 * @param intervals - Optional explicit story intervals, including silent gaps.
 * @returns An FFmpeg filter-complex graph ending at `[bgmout]`.
 */
export function buildMixFilter(
  inputDurations: readonly number[],
  sourceStarts: readonly number[],
  gainsDb: readonly number[],
  bodyDurationSeconds: number,
  crossfadeSeconds: number,
  intervals?: readonly Pick<BgmPlanSegment, 'start_seconds' | 'end_seconds'>[],
): string {
  if (inputDurations.length === 0 || sourceStarts.length !== inputDurations.length
    || gainsDb.length !== inputDurations.length
    || (intervals !== undefined && intervals.length !== inputDurations.length)) throw new Error('BGM 混音参数数量不一致。')
  const starts = sourceStarts.map(start => start.toFixed(6))
  const gains = gainsDb.map(gain => gain.toFixed(1))
  const filters = inputDurations.map((duration, index) => {
    return `[${index}:a]atrim=start=${starts[index]}:duration=${duration.toFixed(6)},`
      + `asetpts=PTS-STARTPTS,volume=${gains[index]}dB[s${index}]`
  })
  const groups: { first: number; last: number; start: number; end: number }[] = []
  for (const [index, interval] of (intervals ?? []).entries()) {
    const last = groups.at(-1)
    if (last !== undefined && Math.abs(interval.start_seconds - last.end) <= EPSILON_SECONDS) {
      last.last = index
      last.end = interval.end_seconds
    } else groups.push({ first: index, last: index, start: interval.start_seconds, end: interval.end_seconds })
  }
  if (groups.length > 1 || groups.some(group => group.start > EPSILON_SECONDS
    || Math.abs(group.end - bodyDurationSeconds) > EPSILON_SECONDS)) {
    for (const [groupIndex, group] of groups.entries()) {
      let current = `s${group.first}`
      for (let index = group.first + 1; index <= group.last; index += 1) {
        const next = `x${index}`
        filters.push(`[${current}][s${index}]acrossfade=d=${crossfadeSeconds.toFixed(6)}:c1=tri:c2=tri[${next}]`)
        current = next
      }
      const start = group.start
      const duration = group.end - start
      filters.push(`[${current}]atrim=0:${duration.toFixed(6)},afade=t=in:st=0:d=1.5,`
        + `afade=t=out:st=${Math.max(0, duration - 2.5).toFixed(6)}:d=2.5,`
        + `adelay=delays=${(start * 1000).toFixed(6)}:all=1[g${groupIndex}]`)
    }
    filters.push(groups.map((_, index) => `[g${index}]`).join('')
      + `amix=inputs=${groups.length}:normalize=0,apad,atrim=0:${bodyDurationSeconds.toFixed(6)}[bgmout]`)
    return filters.join(';')
  }
  let current = 's0'
  for (let index = 1; index < inputDurations.length; index += 1) {
    const next = `x${index}`
    filters.push(`[${current}][s${index}]acrossfade=d=${crossfadeSeconds.toFixed(6)}:c1=tri:c2=tri[${next}]`)
    current = next
  }
  const fadeOutStart = Math.max(0, bodyDurationSeconds - 2.5)
  filters.push(`[${current}]atrim=0:${bodyDurationSeconds.toFixed(6)},`
    + `afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOutStart.toFixed(6)}:d=2.5[bgmout]`)
  return filters.join(';')
}

/** A caller path and the absolute project-owned path it resolves to. */
export interface ResolvedProjectPath {
  /** Path supplied by the caller. */
  readonly input: string
  /** Absolute project root used for relative resolution. */
  readonly project: string
  /** Absolute normalized path. */
  readonly resolved: string
}

/**
 * Resolve a project-owned path without consulting the process working directory.
 * @param project - Project root.
 * @param candidate - Absolute or project-relative path.
 * @param label - Model-facing subject used by a rejection.
 * @returns The original input and its absolute project-owned path.
 * @throws {Error} When the resolved path escapes the project.
 */
export function resolveProjectPath(project: string, candidate: string, label: string): ResolvedProjectPath {
  const root = resolve(project)
  const output = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  const resolved = { input: candidate, project: root, resolved: output }
  const relation = relative(root, output)
  if (relation === '..' || relation.startsWith('..\\') || relation.startsWith('../') || isAbsolute(relation)) {
    throw new Error(`${label}必须位于项目目录内：input="${candidate}"; project="${root}"; `
      + `resolved="${output}"; reason=路径越出项目目录。`)
  }
  return resolved
}

/**
 * Resolve an output path while rejecting every path outside the project root.
 * @param project - Project root.
 * @param candidate - Absolute or project-relative output path.
 * @returns Absolute path inside the project.
 */
export function resolveOutputPath(project: string, candidate: string): string {
  return resolveProjectPath(project, candidate, 'BGM 输出').resolved
}
