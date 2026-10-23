/**
 * Validate persisted delivery metadata and resolve medium-specific output treatment.
 * @module @deepseek-ai/dsh-tool-episode-render/delivery-policy
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_DELIVERY, ENDING_SECONDS, FONT_FAMILY_PATTERN, subtitleRenderStyle } from './delivery.ts'
import type { DeliveryAudio, DeliveryPolicy, DeliverySubtitle, Timeline, TimelineDelivery, VisualMedium } from './types.ts'

/** Reject malformed explicit metadata instead of treating it as missing. */
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象。请修正项目配置或重新运行 prepare。`)
  }
  return value as Record<string, unknown>
}

/** Read the only two supported medium selectors. */
function medium(value: unknown, path: string): VisualMedium {
  if (value !== 'animation_3d' && value !== 'photorealistic') {
    throw new Error(`${path} 必须是 animation_3d 或 photorealistic，收到 ${JSON.stringify(value)}。`)
  }
  return value
}

/** Validate one geometry value before ffmpeg consumes it. */
function positive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} 必须是正整数。`)
  }
  return value
}

/** Validate a finite numeric override before passing it to ASS or ffmpeg. */
function bounded(value: unknown, path: string, minimum: number, maximum: number, exclusiveMinimum = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || (exclusiveMinimum ? value <= minimum : value < minimum) || value > maximum) {
    throw new Error(`${path} 必须是${exclusiveMinimum ? '大于' : '不小于'} ${String(minimum)} 且不大于 ${String(maximum)} 的有限数值。`)
  }
  return value
}

/** Parse only explicitly selected subtitle fields, preserving an explicit empty section. */
function subtitle(value: unknown, path: string, height: number): DeliverySubtitle {
  const row = object(value, path)
  if (Object.hasOwn(row, 'font_family') && (typeof row.font_family !== 'string' || !FONT_FAMILY_PATTERN.test(row.font_family))) {
    throw new Error(`${path}.font_family 必须是非空 ASS 字体名，不能包含逗号或换行；字体须已安装或在 fontsDir 中提供。`)
  }
  return {
    ...(Object.hasOwn(row, 'font_family') ? { font_family: row.font_family as string } : {}),
    ...(Object.hasOwn(row, 'font_size_px')
      ? { font_size_px: bounded(row.font_size_px, `${path}.font_size_px`, 0, Number.MAX_SAFE_INTEGER, true) } : {}),
    ...(Object.hasOwn(row, 'margin_bottom_px')
      ? { margin_bottom_px: bounded(row.margin_bottom_px, `${path}.margin_bottom_px`, 0, height) } : {}),
  }
}

/** Parse explicit linear gains without treating zero as an omitted value. */
function audio(value: unknown, path: string): DeliveryAudio {
  const row = object(value, path)
  return {
    ...(Object.hasOwn(row, 'master_gain') ? { master_gain: bounded(row.master_gain, `${path}.master_gain`, 0, 8) } : {}),
    ...(Object.hasOwn(row, 'bgm_gain') ? { bgm_gain: bounded(row.bgm_gain, `${path}.bgm_gain`, 0, 8) } : {}),
  }
}

/** Reject a positive output size that rounds to zero in the actual ASS representation. */
function assertRepresentableSubtitle(delivery: TimelineDelivery, path: string): void {
  if (delivery.subtitle?.font_size_px !== undefined && subtitleRenderStyle(delivery).font_size_design <= 0) {
    throw new Error(`${path}.subtitle.font_size_px 在 ${String(delivery.width)}×${String(delivery.height)} 输出画幅下`
      + '换算后为 0 ASS 设计单位，无法表达正字号；请使用换算后可保留为正数的字号（ASS 字号精度为 0.001 设计单位）。')
  }
}

/**
 * Parse a complete timeline delivery snapshot.
 * @param value - The delivery JSON value; absence is handled by the caller.
 * @param path - File and field named in diagnostics.
 * @returns Validated medium and geometry.
 */
export function parseTimelineDelivery(value: unknown, path: string): TimelineDelivery {
  const row = object(value, path)
  const width = positive(row.width, `${path}.width`)
  const height = positive(row.height, `${path}.height`)
  const fps = positive(row.fps, `${path}.fps`)
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error(`${path} 的 width 和 height 必须是偶数（H.264 yuv420p）。`)
  if (fps > 240) throw new Error(`${path}.fps 不得超过 240。`)
  const delivery: TimelineDelivery = {
    ...(Object.hasOwn(row, 'visual_medium') ? { visual_medium: medium(row.visual_medium, `${path}.visual_medium`) } : {}),
    width, height, fps,
    ...(Object.hasOwn(row, 'subtitle') ? { subtitle: subtitle(row.subtitle, `${path}.subtitle`, height) } : {}),
    ...(Object.hasOwn(row, 'audio') ? { audio: audio(row.audio, `${path}.audio`) } : {}),
  }
  assertRepresentableSubtitle(delivery, path)
  return delivery
}

/**
 * Snapshot project settings before media work, using legacy geometry only for omitted fields.
 * @param project - Absolute project root.
 * @returns Validated settings from project_config.json.project_bible, or legacy defaults.
 */
export async function readProjectDelivery(project: string): Promise<TimelineDelivery> {
  const path = resolve(project, 'project_config.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { ...DEFAULT_DELIVERY }
    throw error
  }
  const config = object(JSON.parse(text.replace(/^\ufeff/, '')), path)
  if (!Object.hasOwn(config, 'project_bible')) return { ...DEFAULT_DELIVERY }
  const bible = object(config.project_bible, `${path}.project_bible`)
  const geometry = Object.hasOwn(bible, 'delivery') ? object(bible.delivery, `${path}.project_bible.delivery`) : {}
  return parseTimelineDelivery({
    ...DEFAULT_DELIVERY,
    ...(Object.hasOwn(geometry, 'width') ? { width: geometry.width } : {}),
    ...(Object.hasOwn(geometry, 'height') ? { height: geometry.height } : {}),
    ...(Object.hasOwn(geometry, 'fps') ? { fps: geometry.fps } : {}),
    ...(Object.hasOwn(geometry, 'subtitle') ? { subtitle: geometry.subtitle } : {}),
    ...(Object.hasOwn(geometry, 'audio') ? { audio: geometry.audio } : {}),
    ...(Object.hasOwn(bible, 'visual_medium') ? { visual_medium: bible.visual_medium } : {}),
  }, `${path}.project_bible.delivery`)
}

/**
 * Choose treatment from an explicit medium, never from style text or aspect ratio.
 * @param delivery - Validated geometry and optional medium.
 * @returns Ending, mark, and any legacy warning.
 */
export function deliveryPolicyFor(delivery: TimelineDelivery = DEFAULT_DELIVERY): DeliveryPolicy {
  const animation = delivery.visual_medium === 'animation_3d'
  return {
    delivery,
    addWatermark: !animation,
    endingSeconds: animation ? 0 : ENDING_SECONDS,
    warnings: delivery.visual_medium === undefined
      ? ['未设置 visual_medium，沿用旧版交付：保留「内容由AI生成」标记与 2 秒片尾；请在 project_bible 明确设置媒介后重跑 prepare。']
      : [],
  }
}

/**
 * Resolve a timeline snapshot against the current project's explicit medium.
 * @param project - Absolute project root.
 * @param snapshot - Delivery metadata read from the timeline, if present.
 * Subtitle and audio sections inherit independently: a saved section (even `{}`)
 * wins over the current project section; only a missing section inherits it.
 * Omitted fields inside the selected section retain deployment/legacy defaults.
 * @returns Snapshot geometry and selected sections, or legacy geometry when absent.
 * @throws {Error} When project and snapshot explicitly select different media.
 */
export async function resolveDeliveryPolicy(project: string, snapshot?: TimelineDelivery): Promise<DeliveryPolicy> {
  const current = await readProjectDelivery(project)
  if (snapshot?.visual_medium !== undefined && current.visual_medium !== undefined
    && snapshot.visual_medium !== current.visual_medium) {
    throw new Error('时间线 delivery.visual_medium 与 project_bible.visual_medium 冲突；请重跑 prepare，禁止沿用旧时间线。')
  }
  const visualMedium = snapshot?.visual_medium ?? current.visual_medium
  const delivery: TimelineDelivery = {
    ...(snapshot ?? DEFAULT_DELIVERY),
    ...(visualMedium === undefined ? {} : { visual_medium: visualMedium }),
    ...(snapshot?.subtitle !== undefined || current.subtitle === undefined ? {} : { subtitle: current.subtitle }),
    ...(snapshot?.audio !== undefined || current.audio === undefined ? {} : { audio: current.audio }),
  }
  // A legacy timeline may retain different geometry from the current project.
  // Validate the inherited margin against the frame that will actually be rendered.
  if (delivery.subtitle?.margin_bottom_px !== undefined) {
    bounded(delivery.subtitle.margin_bottom_px, 'delivery.subtitle.margin_bottom_px', 0, delivery.height)
  }
  assertRepresentableSubtitle(delivery, 'delivery')
  return deliveryPolicyFor(delivery)
}

/**
 * Refuse a 3D timeline whose declared body ends before or after its actual clips.
 * @param timeline - Parsed timeline retaining its declared body_end.
 * @param policy - Effective medium, including an explicit project-only selection.
 */
export function assertBodyOnlyAnimation(timeline: Timeline, policy: DeliveryPolicy): void {
  if (policy.delivery.visual_medium === 'animation_3d' && timeline.declaredBodyEndSeconds !== undefined
    && Math.round(timeline.declaredBodyEndSeconds * 1_000_000) !== Math.round(timeline.bodyEndSeconds * 1_000_000)) {
    throw new Error('animation_3d 时间线的 body_end 与镜头结束不一致，可能已包含片尾；请仅保留正片镜头并重跑 prepare。')
  }
}
