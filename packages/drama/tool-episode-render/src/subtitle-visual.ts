/** Validate and resolve optional project visual intent without altering legacy subtitle defaults. */
import type { DeliverySubtitleVisual, TimelineDelivery } from './types.ts'

/** Read one explicit visual section, retaining an empty section as a legacy reset.
 * @param value - Untrusted project or timeline JSON.
 * @param path - Diagnostic field name.
 * @returns Complete versioned intent or an explicit empty reset.
 */
export function parseSubtitleVisual(value: unknown, path: string): NonNullable<TimelineDelivery['subtitle_visual']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} 必须是对象。`)
  const row = value as Record<string, unknown>
  if (Object.keys(row).length === 0) return {}
  if (row.schema_version !== 1) throw new Error(`${path}.schema_version 必须为 1。`)
  const number = (key: string, minimum: number, maximum: number, positive = false): number => {
    const selected = row[key]
    if (typeof selected !== 'number' || !Number.isFinite(selected) || selected < minimum || selected > maximum
      || (positive && selected === minimum)) throw new Error(`${path}.${key} 超出有限数值范围。`)
    return selected
  }
  let font: string | undefined
  if (Object.hasOwn(row, 'font_family')) {
    if (typeof row.font_family !== 'string' || !row.font_family.trim() || row.font_family.trim().length > 128
      || /[,\p{Cc}]/u.test(row.font_family)) throw new Error(`${path}.font_family 必须为 1–128 字符且不含逗号或控制字符。`)
    font = row.font_family.trim()
  }
  return { schema_version: 1,
    reference_width: number('reference_width', 0, 16384, true),
    reference_height: number('reference_height', 0, 16384, true),
    font_size_px: number('font_size_px', 0, 16384, true),
    outline_px: number('outline_px', 0, 100),
    center_y_ratio: number('center_y_ratio', 0, 1),
    max_width_ratio: number('max_width_ratio', 0, 1, true),
    ...(font === undefined ? {} : { font_family: font }),
  }
}

/** Select only a complete opt-in visual profile; an empty snapshot deliberately resets it.
 * @param delivery - Validated effective delivery.
 * @returns Shared intent, absent for every unchanged legacy call.
 */
export function activeSubtitleVisual(delivery: TimelineDelivery): DeliverySubtitleVisual | undefined {
  return delivery.subtitle_visual?.schema_version === 1 ? delivery.subtitle_visual : undefined
}
