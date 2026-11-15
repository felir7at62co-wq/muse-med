/** Validate the existing episode/segments BGM plan without choosing or mixing music. */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { LicenseInfoInputSchema, licenseRiskWarnings, normalizeLicenseInfo, parseBgmUsage, type BgmUsage } from '@deepseek-ai/dsh-bgm-license-info'
import { fileSha256 } from './cache.ts'
import type { BgmPlanReport, BgmSegment } from './types.ts'

type MusicDecision = 'music' | 'none'

/** Existing plan fields used by the renderer; creative notes remain caller-owned. */
const Plan: z<{
  episodes: {
    episode: string
    intended_use: BgmUsage
    body_duration_seconds: number
    music_decision?: MusicDecision
    decision_reason?: string
    segments: (BgmSegment & { source_start_seconds?: number; selection_origin?: string })[]
  }[]
}> = z.object({
  episodes: z.array(z.object({
    episode: z.string().required(),
    intended_use: z.union(['commercial', 'non_commercial', 'unknown'] as const).default('unknown'),
    body_duration_seconds: z.number().required(),
    music_decision: z.union(['music', 'none'] as const), decision_reason: z.string(),
    segments: z.array(z.object({
      track: z.string().required(), source: z.string().required(),
      track_id: z.string(), source_sha256: z.string(), license_info: LicenseInfoInputSchema,
      start_seconds: z.number().required(), end_seconds: z.number().required(),
      source_start_seconds: z.number(),
      selection_origin: z.string(),
      reason: z.string().default(''),
    })).required(),
  })).required(),
})

const Generation = z.object({
  method: z.string().required(), episode: z.string().required(), plan: z.string().required(), timeline: z.string().required(),
  body_duration_seconds: z.number().required(),
  media: z.object({ sha256: z.string().required() }).required(),
  segments: z.array(z.object({
    track: z.string().required(), source: z.string().required(), track_id: z.string(), source_sha256: z.string().required(),
    start_seconds: z.number().required(), end_seconds: z.number().required(), source_start_seconds: z.number().required(),
  })).required(),
})

function readPlan(text: string, path: string, episode: string, bodyEnd: number) {
  let plan
  try {
    const document: unknown = JSON.parse(text.replace(/^\ufeff/u, ''))
    plan = Plan(document as Parameters<typeof Plan>[0])
  } catch (error) {
    throw new Error(`BGM 计划不可读：${path}`, { cause: error })
  }
  const ids = plan.episodes.map(row => row.episode.padStart(2, '0'))
  if (new Set(ids).size !== ids.length || ids.some(id => !/^\d+$/u.test(id))) throw new Error('BGM 计划集号重复或无效。')
  const selected = plan.episodes.find(row => row.episode.padStart(2, '0') === episode)
  if (selected === undefined) throw new Error(`BGM 计划缺少第 ${episode} 集。`)
  if (!Number.isFinite(selected.body_duration_seconds) || Math.abs(selected.body_duration_seconds - bodyEnd) > 0.001) {
    throw new Error('BGM 计划正文时长与当前时间线不一致。')
  }
  return { plan, selected }
}

/** Read the explicit music choice and compare any composer receipt to the exact rendered bed and plan.
 * @param input - Current episode, plan and exact rendered music input bindings.
 * @returns The checked music decision and its recorded reason.
 */
export function checkMusicDecision(input: {
  readonly project: string
  readonly episode: string
  readonly bodyEnd: number
  readonly timelinePath: string
  readonly planPath: string
  readonly planText: string
  readonly mode: MusicDecision
  readonly gain: number
  readonly bedSha?: string
  readonly generationText?: string
}): { decision: MusicDecision; reason: string } {
  const { selected } = readPlan(input.planText, input.planPath, input.episode, input.bodyEnd)
  const decision = selected.music_decision
  const reason = selected.decision_reason?.trim()
  if (decision === undefined || !reason) throw new Error('严格配乐归档需要本集明确的 music_decision 和 decision_reason。')
  if (decision !== input.mode) throw new Error('本集配乐决定与实际渲染的混音模式不符。')
  if (decision === 'none') {
    if (selected.segments.length !== 0 || input.gain !== 0 || input.bedSha !== undefined) {
      throw new Error('决定不加配乐时必须使用 no_bgm，且本集配乐段为空。')
    }
    return { decision, reason }
  }
  if (!Number.isFinite(input.gain) || input.gain <= 0 || selected.segments.length === 0
    || input.bedSha === undefined || input.generationText === undefined) {
    throw new Error('决定加配乐时需要非零实际混音增益、配乐段、采用的 BGM 与 drama_bgm 合成收据。')
  }
  let receipt
  try {
    receipt = Generation(JSON.parse(input.generationText.replace(/^\ufeff/u, '')) as Parameters<typeof Generation>[0])
  } catch (error) {
    throw new Error('配乐合成收据不可读或缺少逐曲来源。', { cause: error })
  }
  if (receipt.method !== 'compose' || receipt.episode.padStart(2, '0') !== input.episode
    || resolve(input.project, receipt.plan) !== input.planPath || resolve(input.project, receipt.timeline) !== input.timelinePath
    || !Number.isFinite(receipt.body_duration_seconds) || Math.abs(receipt.body_duration_seconds - input.bodyEnd) > 0.001
    || receipt.media.sha256 !== input.bedSha) {
    throw new Error('配乐合成收据与实际采用的 BGM 字节、本集计划或时间线不符；请采用同源合成结果后重新渲染。')
  }
  for (const segment of selected.segments) {
    const declared = segment.source_sha256?.replace(/^sha256:/u, '').toLowerCase()
    const catalogTrack = declared !== undefined && segment.track_id === `sha256:${declared}`
    const adopted = segment.selection_origin === 'approved_reuse' && Boolean(segment.reason.trim())
    if (declared === undefined || !/^[0-9a-f]{64}$/u.test(declared) || (!catalogTrack && !adopted)) {
      throw new Error('每段配乐须有曲库 track_id 和源曲 SHA-256，或明确标记 selection_origin=approved_reuse、记录复用理由和源曲 SHA-256。')
    }
  }
  if (receipt.segments.length !== selected.segments.length || receipt.segments.some((row, index) => {
    const segment = selected.segments[index] as typeof selected.segments[number]
    return row.track !== segment.track || resolve(input.project, row.source) !== resolve(input.project, segment.source)
      || row.track_id !== segment.track_id || !/^[0-9a-f]{64}$/u.test(row.source_sha256)
      || segment.source_sha256?.replace(/^sha256:/u, '').toLowerCase() !== row.source_sha256
      || row.start_seconds !== segment.start_seconds || row.end_seconds !== segment.end_seconds
      || !Number.isFinite(row.source_start_seconds) || row.source_start_seconds < 0
      || (segment.source_start_seconds !== undefined && row.source_start_seconds !== segment.source_start_seconds)
  })) throw new Error('配乐合成收据的源曲、曲目顺序或选用区间与本集计划不符。')
  return { decision, reason }
}

/**
 * Read one plan and return its segments, license declarations, use risks, and repeat advice.
 * @param path - Optional existing BGM plan path.
 * @param episode - Two-digit episode number.
 * @param bodyEnd - Actual timeline body end, in seconds.
 * @param bed - The single mixed bed supplied to render.
 * @param project - Base for relative track source identities.
 * @returns Declared plan evidence; no claim about the sound's contents or independently verified rights.
 * @throws {Error} When a supplied plan is malformed, ambiguous, or disagrees with the timeline.
 */
export async function readBgmPlan(
  path: string | undefined, episode: string, bodyEnd: number, bed: string, project: string,
): Promise<BgmPlanReport> {
  if (path === undefined) return { path: '', bed_sha256: '', segments: [], repeated_sequence_episodes: [],
    intended_use: 'unknown', license_records: [] }
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    throw new Error(`BGM 计划不可读：${path}`, { cause: error })
  })
  const { plan, selected } = readPlan(text, path, episode, bodyEnd)
  let previousStart = 0
  for (const segment of selected.segments) {
    if (!segment.track.trim() || !segment.source.trim()
      || !Number.isFinite(segment.start_seconds) || !Number.isFinite(segment.end_seconds)
      || segment.start_seconds < 0 || segment.end_seconds <= segment.start_seconds
      || segment.start_seconds < previousStart || segment.end_seconds > bodyEnd + 0.001) {
      throw new Error('BGM 段落须有曲目来源及按起点排序、不越界的正文时间。')
    }
    previousStart = segment.start_seconds
  }
  if (selected.segments.length === 0) throw new Error('BGM 计划没有段落。')
  const signature = (segments: readonly BgmSegment[]) => JSON.stringify(segments.map(segment => resolve(project, segment.source)))
  const intendedUse = parseBgmUsage(selected.intended_use)
  const segments = selected.segments.map(({
    track, source, track_id, source_sha256, license_info, start_seconds, end_seconds, reason,
  }) => ({
    track, source, start_seconds, end_seconds, reason,
    ...(track_id === undefined ? {} : { track_id }),
    ...(source_sha256 === undefined ? {} : { source_sha256 }),
    license_info: normalizeLicenseInfo(license_info),
  }))
  return {
    intended_use: intendedUse,
    license_records: segments.map(segment => ({
      track: segment.track, source: resolve(project, segment.source),
      ...(segment.track_id === undefined ? {} : { track_id: segment.track_id }),
      ...(segment.source_sha256 === undefined ? {} : { source_sha256: segment.source_sha256 }),
      license_info: segment.license_info,
      warnings: licenseRiskWarnings(segment.license_info, intendedUse),
    })),
    path,
    bed_sha256: await fileSha256(bed),
    segments,
    repeated_sequence_episodes: plan.episodes
      .filter(row => row !== selected && signature(row.segments) === signature(selected.segments))
      .map(row => row.episode.padStart(2, '0')),
  }
}
