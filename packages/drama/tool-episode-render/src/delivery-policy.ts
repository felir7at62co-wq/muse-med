/**
 * Validate persisted delivery metadata and resolve medium-specific output treatment.
 * @module @deepseek-ai/dsh-tool-episode-render/delivery-policy
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_DELIVERY, ENDING_SECONDS } from './delivery.ts'
import type { DeliveryPolicy, Timeline, TimelineDelivery, VisualMedium } from './types.ts'

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
  return {
    ...(Object.hasOwn(row, 'visual_medium') ? { visual_medium: medium(row.visual_medium, `${path}.visual_medium`) } : {}),
    width, height, fps,
  }
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
 * @returns Snapshot geometry and explicit medium treatment, or legacy geometry when absent.
 * @throws {Error} When project and snapshot explicitly select different media.
 */
export async function resolveDeliveryPolicy(project: string, snapshot?: TimelineDelivery): Promise<DeliveryPolicy> {
  const current = await readProjectDelivery(project)
  if (snapshot?.visual_medium !== undefined && current.visual_medium !== undefined
    && snapshot.visual_medium !== current.visual_medium) {
    throw new Error('时间线 delivery.visual_medium 与 project_bible.visual_medium 冲突；请重跑 prepare，禁止沿用旧时间线。')
  }
  const visualMedium = snapshot?.visual_medium ?? current.visual_medium
  return deliveryPolicyFor({
    ...(snapshot ?? DEFAULT_DELIVERY),
    ...(visualMedium === undefined ? {} : { visual_medium: visualMedium }),
  })
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
