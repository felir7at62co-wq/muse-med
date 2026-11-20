/** Checked readings of Script Workshop's `/script-library` responses; a reply that does not match fails as invalid. @module */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isRecord } from './http.ts'
import type { ScriptDetail, ScriptEpisode, ScriptKind, ScriptList, ScriptPerson, ScriptRights, ScriptStatus, ScriptStyle, ScriptSummary } from './types.ts'

const STATUSES: readonly ScriptStatus[] = ['waiting', 'picked', 'in_production']
const RIGHTS: readonly ScriptRights[] = ['original', 'licensed']
const KINDS: readonly ScriptKind[] = ['drama', 'narration']
const STYLES: readonly ScriptStyle[] = ['realistic', '3d']
/** Longest episode text accepted from the Workshop, matching its own limit. */
const EPISODE_CHARS = 60_000

function invalid(): HarnessError {
  return new HarnessError('剧本工坊返回了无法识别的剧本库数据。', 'WORKSHOP_INVALID_RESULT')
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid()
  return value
}

function int(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw invalid()
  return value
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw invalid()
  return value
}

function optionalText(value: unknown, limit: number): string | null {
  return value === null || value === undefined ? null : text(value, limit)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  const found = allowed.find(item => item === value)
  if (found === undefined) throw invalid()
  return found
}

function person(value: unknown): ScriptPerson {
  const source = record(value)
  return { id: int(source.id, 1), name: optionalText(source.name, 200) }
}

function list<T>(value: unknown, limit: number, read: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) throw invalid()
  const items: unknown[] = value
  return items.map(read)
}

/**
 * Read one script card.
 * @param value - Decoded Workshop `script` object.
 * @returns The checked card.
 */
export function scriptSummary(value: unknown): ScriptSummary {
  const source = record(value)
  const picked = source.picked === null || source.picked === undefined ? null : record(source.picked)
  const project = source.project === null || source.project === undefined ? null : record(source.project)
  return {
    id: int(source.id, 1), title: text(source.title, 200), owner: person(source.owner), rights: oneOf(source.rights, RIGHTS),
    originWorkId: optionalText(source.origin_work_id, 80), originTitle: optionalText(source.origin_title, 500),
    kind: oneOf(source.kind, KINDS), style: oneOf(source.style, STYLES), episodes: int(source.episodes), words: int(source.words),
    status: oneOf(source.status, STATUSES), latestVersion: int(source.latest_version, 1),
    picked: picked === null ? null : { by: person(picked.by), version: int(picked.version, 1), at: optionalText(picked.at, 64) },
    project: project === null ? null : { id: text(project.id, 80), title: text(project.title, 200) },
    createdAt: optionalText(source.created_at, 64), updatedAt: optionalText(source.updated_at, 64),
  }
}

/**
 * Read one library page.
 * @param value - Decoded Workshop list response.
 * @returns The checked page and counts.
 */
export function scriptList(value: unknown): ScriptList {
  const source = record(value)
  const counts = record(source.counts)
  if (typeof source.can_pick !== 'boolean') throw invalid()
  return {
    items: list(source.items, 100, scriptSummary), total: int(source.total), page: int(source.page, 1), limit: int(source.limit, 1),
    counts: { waiting: int(counts.waiting), picked: int(counts.picked), inProduction: int(counts.in_production), all: int(counts.all) },
    canPick: source.can_pick,
  }
}

function episode(value: unknown): ScriptEpisode {
  const source = record(value)
  return { order: int(source.order, 1), title: text(source.title ?? '', 200), content: text(source.content, EPISODE_CHARS) }
}

/**
 * Read one script with its versions and one version's text.
 * @param value - Decoded Workshop script response.
 * @returns The checked script.
 */
export function scriptDetail(value: unknown): ScriptDetail {
  const source = record(value)
  const content = record(source.content)
  if (typeof source.can_pick !== 'boolean') throw invalid()
  return {
    script: scriptSummary(source.script), canPick: source.can_pick,
    versions: list(source.versions, 1000, (item) => {
      const row = record(item)
      return { number: int(row.number, 1), words: int(row.words), createdAt: optionalText(row.created_at, 64), by: person(row.by) }
    }),
    content: { version: int(content.version, 1), episodes: list(content.episodes, 300, episode) },
  }
}

/**
 * Read the `script` field of a pick, production or finalize response.
 * @param value - Decoded Workshop response.
 * @returns The checked card.
 */
export function scriptOf(value: unknown): ScriptSummary {
  return scriptSummary(record(value).script)
}
