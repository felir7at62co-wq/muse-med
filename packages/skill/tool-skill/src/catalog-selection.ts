/** Stable source-limited summary selection; loading permissions remain registry-owned. */
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

/** Limits indexed by the exact provider source label. */
export type CatalogSourceLimits = Readonly<Record<string, number>>

function sourceLimit(limits: CatalogSourceLimits, source: string): number | undefined {
  return Object.hasOwn(limits, source) ? limits[source] : undefined
}

/** Return whether a complete eligible directory needs source-specific truncation.
 * @param skills - Model-invocable summaries in registry order.
 * @param limits - Validated positive limits; omitted sources remain complete.
 * @returns Whether at least one source exceeds its limit.
 */
export function needsCatalogSelection(skills: readonly SkillSummary[], limits: CatalogSourceLimits): boolean {
  const counts = new Map<string, number>()
  for (const skill of skills) {
    const count = (counts.get(skill.source) ?? 0) + 1
    counts.set(skill.source, count)
    const limit = sourceLimit(limits, skill.source)
    if (limit !== undefined && count > limit) return true
  }
  return false
}

/** Select source-limited recommendations while preserving their original catalog order.
 * @param skills - Complete, model-invocable summaries.
 * @param limits - Validated limits by exact source.
 * @param intent - Direct user text; empty on tool-only continuations.
 * @param preferred - Explicit names, or the previous selection without new user input.
 * @returns Selected summary references, including all unconfigured sources.
 */
export function selectCatalogSkills(
  skills: readonly SkillSummary[], limits: CatalogSourceLimits, intent: string, preferred: readonly string[],
): SkillSummary[] {
  const named = new Set(preferred)
  const terms = [...new Set(intent.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  const groups = new Map<string, { index: number; named: boolean; score: number }[]>()
  for (const [index, skill] of skills.entries()) {
    if (sourceLimit(limits, skill.source) === undefined) continue
    const text = `${skill.name} ${skill.whenToUse ?? ''} ${skill.description}`.normalize('NFKC').toLowerCase()
    const rows = groups.get(skill.source) ?? []
    rows.push({ index, named: named.has(skill.name), score: terms.filter(term => text.includes(term)).length })
    groups.set(skill.source, rows)
  }
  const retained = new Set<number>()
  for (const [source, rows] of groups) {
    rows.sort((a, b) => Number(b.named) - Number(a.named) || b.score - a.score || a.index - b.index)
    for (const row of rows.slice(0, sourceLimit(limits, source))) retained.add(row.index)
  }
  return skills.filter((skill, index) => sourceLimit(limits, skill.source) === undefined || retained.has(index))
}
