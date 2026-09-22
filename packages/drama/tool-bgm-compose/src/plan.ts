/** Validate BGM story intervals and compile their FFmpeg mix graph. */

import { isAbsolute, relative, resolve } from 'node:path'
import type { BgmEpisodePlan, BgmPlanSegment, ValidatedBgmEpisodePlan } from './types.ts'

/** Default overlap centered on each story boundary. */
export const DEFAULT_CROSSFADE_SECONDS = 1.5

/** Shared source-window mean used by the short-drama renderer. */
export const TARGET_MEAN_DB = -17.5

/** Largest automatic source boost. */
export const MAX_BOOST_DB = 9

const EPSILON_SECONDS = 0.001

/** Limits one batch of episode plans is held to. */
export interface BgmBatchPolicy {
  /** Distinct tracks each episode must use. */
  readonly minTracksPerEpisode: number
  /** Episodes one track may appear in across the whole batch. */
  readonly maxEpisodesPerTrack: number
  /** Tracks each episode must use that no other episode in the batch uses. */
  readonly freshTracksPerEpisode: number
  /** Seconds a cut may sit away from a package boundary. */
  readonly boundaryToleranceSeconds: number
}

/** The policy the short-drama pipeline runs with. */
export const DEFAULT_BGM_BATCH_POLICY: BgmBatchPolicy = {
  minTracksPerEpisode: 2,
  maxEpisodesPerTrack: 2,
  freshTracksPerEpisode: 1,
  boundaryToleranceSeconds: 0.05,
}

/** One episode row as the batch gate reads it. */
export interface BgmBatchRow {
  /** Episode number, conventionally two digits. */
  readonly episode: string
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
 * Hold one episode's plan to the batch policy before anything is composed.
 *
 * The rules are per batch, so a single episode cannot be judged alone: a track
 * two episodes share is only a violation when a third one joins, and a fresh
 * track is only fresh relative to what the other episodes used.
 * @param selected - The episode about to be composed.
 * @param context - The batch, its boundaries, and the limits.
 * @throws {Error} With the rule and the offending segment when the batch fails.
 */
export function validateBgmBatch(selected: BgmBatchRow, context: BgmBatchContext): void {
  const limits = context.limits ?? DEFAULT_BGM_BATCH_POLICY
  const episode = selected.episode
  const tracks = selected.segments.map(segment => trackIdentity(context.project, segment.source))
  const distinct = [...new Set(tracks)]
  if (distinct.length < limits.minTracksPerEpisode) {
    throw new Error(`第 ${episode} 集只用了 ${String(distinct.length)} 首曲子，`
      + `要求每集至少 ${String(limits.minTracksPerEpisode)} 首：一集不得压成一首，请按剧情情绪分段选曲。`)
  }
  if (distinct.length !== tracks.length) {
    throw new Error(`第 ${episode} 集在 ${String(tracks.length)} 段里重复使用了同一首曲子：`
      + '同一集内不得重复，请换掉重复的段落。')
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
  for (const id of distinct) {
    const episodes = [...(users.get(id) ?? new Set<string>())].sort()
    if (episodes.length > limits.maxEpisodesPerTrack) {
      throw new Error(`曲目 ${id} 出现在 ${String(episodes.length)} 集（${episodes.join('、')}），`
        + `超过整批上限 ${String(limits.maxEpisodesPerTrack)} 集：请换掉其中几集的这首曲子。`)
    }
  }
  const fresh = distinct.filter(id => (users.get(id) ?? new Set<string>()).size === 1)
  if (fresh.length < limits.freshTracksPerEpisode) {
    throw new Error(`第 ${episode} 集没有任何一首是本批其它集没用的（要求至少 `
      + `${String(limits.freshTracksPerEpisode)} 首）：请为本集换入一首全新曲目。`)
  }
  if (context.boundaries.length === 0) {
    throw new Error(`第 ${episode} 集的切点无法核对：时间线里没有镜头包边界。`
      + '请确认传的是本集时间线（含 clips），再重跑。')
  }
  for (const [index, segment] of selected.segments.entries()) {
    if (index === 0) continue
    const nearest = context.boundaries
      .map(boundary => ({ boundary, distance: Math.abs(boundary - segment.start_seconds) }))
      .sort((left, right) => left.distance - right.distance)[0]
    if (nearest === undefined || nearest.distance > limits.boundaryToleranceSeconds) {
      throw new Error(`第 ${episode} 集的切点 ${segment.start_seconds.toFixed(3)}s 不在任何镜头包边界上`
        + `${nearest === undefined ? '' : `（最近的是 ${nearest.boundary.toFixed(3)}s）`}：`
        + '配乐分段必须落在镜头包边界，请把切点移到某个包的起点。')
    }
  }
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
  const half = crossfadeSeconds / 2
  return segments.map((segment, index) => Number((
    segment.end_seconds - segment.start_seconds
    + (index === 0 ? half : crossfadeSeconds)
    - (index === segments.length - 1 ? half : 0)
  ).toFixed(6)))
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
  const crossfadeSeconds = input.crossfade_seconds ?? DEFAULT_CROSSFADE_SECONDS
  if (!Number.isFinite(crossfadeSeconds) || crossfadeSeconds <= 0) throw new Error('BGM 交叉淡化时长必须大于零。')
  if (!Array.isArray(input.segments) || input.segments.length === 0) throw new Error('BGM 计划没有段落。')
  let expectedStart = 0
  for (const segment of input.segments) {
    if (!segment.track.trim() || !segment.source.trim()) throw new Error('BGM 段落必须包含曲目和来源。')
    if (!segment.reason.trim()) throw new Error('BGM 段落必须记录选曲理由。')
    if (!Number.isFinite(segment.start_seconds) || !Number.isFinite(segment.end_seconds)
      || segment.end_seconds <= segment.start_seconds
      || Math.abs(segment.start_seconds - expectedStart) > EPSILON_SECONDS) {
      throw new Error('BGM 段落必须按顺序连续覆盖正文。')
    }
    if (segment.source_start_seconds !== undefined
      && (!Number.isFinite(segment.source_start_seconds) || segment.source_start_seconds < 0)) {
      throw new Error('BGM 源曲起点必须是非负秒数。')
    }
    expectedStart = segment.end_seconds
  }
  if (Math.abs(expectedStart - bodyDurationSeconds) > EPSILON_SECONDS) {
    throw new Error('BGM 段落必须按顺序连续覆盖正文。')
  }
  const lengths = segmentInputDurations(input.segments, crossfadeSeconds)
  if (input.segments.some((segment, index) => {
    const inputDuration = lengths[index]
    return inputDuration === undefined || inputDuration <= crossfadeSeconds
      || segment.end_seconds - segment.start_seconds < crossfadeSeconds
  })) {
    throw new Error('BGM 交叉淡化不能长于最短剧情段。')
  }
  return {
    bodyDurationSeconds,
    crossfadeSeconds,
    segments: input.segments.map((segment, index) => {
      const inputDurationSeconds = lengths[index]
      if (inputDurationSeconds === undefined) throw new Error('BGM 段落时长数量不一致。')
      return { ...segment, inputDurationSeconds }
    }),
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
 * @param inputDurations - Source contribution durations before overlaps are removed.
 * @param sourceStarts - Source offsets in seconds.
 * @param gainsDb - Per-source gain in decibels.
 * @param bodyDurationSeconds - Exact output duration.
 * @param crossfadeSeconds - Adjacent overlap duration.
 * @returns An FFmpeg filter-complex graph ending at `[bgmout]`.
 */
export function buildMixFilter(
  inputDurations: readonly number[],
  sourceStarts: readonly number[],
  gainsDb: readonly number[],
  bodyDurationSeconds: number,
  crossfadeSeconds: number,
): string {
  if (inputDurations.length === 0 || sourceStarts.length !== inputDurations.length
    || gainsDb.length !== inputDurations.length) throw new Error('BGM 混音参数数量不一致。')
  const filters = inputDurations.map((duration, index) => {
    const sourceStart = sourceStarts[index]
    const gainDb = gainsDb[index]
    if (sourceStart === undefined || gainDb === undefined) throw new Error('BGM 混音参数数量不一致。')
    return `[${index}:a]atrim=start=${sourceStart.toFixed(6)}:duration=${duration.toFixed(6)},`
      + `asetpts=PTS-STARTPTS,volume=${gainDb.toFixed(1)}dB[s${index}]`
  })
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

/**
 * Resolve an output path while rejecting every path outside the project root.
 * @param project - Project root.
 * @param candidate - Absolute or project-relative output path.
 * @returns Absolute path inside the project.
 */
export function resolveOutputPath(project: string, candidate: string): string {
  const root = resolve(project)
  const output = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  const relation = relative(root, output)
  if (relation === '..' || relation.startsWith('..\\') || relation.startsWith('../') || isAbsolute(relation)) {
    throw new Error('BGM 输出必须位于项目目录内。')
  }
  return output
}
