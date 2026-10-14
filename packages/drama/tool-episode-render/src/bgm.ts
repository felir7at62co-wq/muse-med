/** Validate the existing episode/segments BGM plan without choosing or mixing music. */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { LicenseInfoInputSchema, licenseRiskWarnings, normalizeLicenseInfo, parseBgmUsage, type BgmUsage } from '@deepseek-ai/dsh-bgm-license-info'
import { fileSha256 } from './cache.ts'
import type { BgmPlanReport, BgmSegment } from './types.ts'

/** Existing plan fields used by the renderer; creative notes remain caller-owned. */
const Plan: z<{
  episodes: {
    episode: string
    intended_use: BgmUsage
    body_duration_seconds: number
    segments: BgmSegment[]
  }[]
}> = z.object({
  episodes: z.array(z.object({
    episode: z.string().required(),
    intended_use: z.union(['commercial', 'non_commercial', 'unknown'] as const).default('unknown'),
    body_duration_seconds: z.number().required(),
    segments: z.array(z.object({
      track: z.string().required(), source: z.string().required(),
      track_id: z.string(), source_sha256: z.string(), license_info: LicenseInfoInputSchema,
      start_seconds: z.number().required(), end_seconds: z.number().required(),
      reason: z.string().default(''),
    })).required(),
  })).required(),
})

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
  let plan
  try {
    const document: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\ufeff/, ''))
    // Schemastery's callable validates at runtime; its input type describes valid values, not parsed JSON.
    plan = Plan(document as Parameters<typeof Plan>[0])
  } catch (error) {
    throw new Error(`BGM 计划不可读：${path}`, { cause: error })
  }
  const ids = plan.episodes.map(row => row.episode.padStart(2, '0'))
  if (new Set(ids).size !== ids.length || ids.some(id => !/^\d+$/.test(id))) throw new Error('BGM 计划集号重复或无效。')
  const selected = plan.episodes.find(row => row.episode.padStart(2, '0') === episode)
  if (selected === undefined) throw new Error(`BGM 计划缺少第 ${episode} 集。`)
  if (!Number.isFinite(selected.body_duration_seconds) || Math.abs(selected.body_duration_seconds - bodyEnd) > 0.001) {
    throw new Error('BGM 计划正文时长与当前时间线不一致。')
  }
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
