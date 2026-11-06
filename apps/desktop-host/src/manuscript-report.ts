/** Bounded, versioned views of complete manuscript review collections. */
import { createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Current review data, including notes and reading progress rather than only source versions. */
export type ManuscriptReportVersion = Branded<'ManuscriptReportVersion'>

/** An optional collection read within one immutable review version. */
export interface ManuscriptReportCursor {
  report_sha256?: ManuscriptReportVersion
  report_section?: string
  report_offset?: number
  report_limit?: number
}

/**
 * Display a workspace-local filesystem path without changing external or already-relative paths.
 * @param value - Declared filesystem path, separate from manuscript prose.
 * @param cwd - Canonical workspace; omitted when no workspace is available.
 * @returns A portable ./ path inside the workspace, or the unchanged value outside it.
 */
export function formatManuscriptPath(value: string, cwd?: string): string {
  if (cwd === undefined || !isAbsolute(value)) return value
  const path = relative(cwd, value)
  return isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`) ? value : `./${path.split(sep).join('/')}`
}

const pathArrayKeys = new Set(['paths', 'source_paths', 'candidate_paths', 'missing_files'])
const formatPathArray = (values: readonly unknown[], cwd?: string): readonly unknown[] =>
  values.map(entry => typeof entry === 'string' ? formatManuscriptPath(entry, cwd) : entry)

/**
 * Encode declared manuscript paths relative to their owning workspace before applying text budgets.
 * External paths and manuscript prose remain exact; stored filesystem identities are not changed.
 * @param input - Complete review, source page, checkpoint, or scene response.
 * @param cwd - Canonical workspace; absent for a formatter without a workspace.
 * @returns JSON with workspace-local path fields using portable relative spellings.
 */
export function serializeManuscriptData(input: object, cwd?: string): string {
  if (cwd === undefined) return JSON.stringify(input)
  return JSON.stringify(input, (key: string, value: unknown): unknown => {
    if ((key === 'path' || key === 'source_path' || key === 'file_path') && typeof value === 'string') return formatManuscriptPath(value, cwd)
    if (pathArrayKeys.has(key) && Array.isArray(value)) return formatPathArray(value, cwd)
    return value
  })
}

/**
 * Identify current review inputs without making their workspace location part of the version.
 * Only declared file-path properties are made workspace-relative; manuscript and note text remain exact.
 * @param input - Complete durable task data, current file identities and relevant configuration.
 * @param cwd - Canonical owning workspace.
 * @returns A digest that changes when review data or its configuration changes.
 */
export function manuscriptReportVersion(input: object, cwd: string): ManuscriptReportVersion {
  const encoded = serializeManuscriptData(input, cwd)
  return brandString<ManuscriptReportVersion>(createHash('sha256').update(encoded).digest('hex'))
}

/**
 * Return a complete small report or a collection index and bounded collection pages.
 * A page never claims earlier pages were read. Large rows expose nested collection requests rather than losing text.
 * @param report - Complete JSON-compatible review data with a task key.
 * @param version - Digest of current review inputs, including saved notes.
 * @param options - Complete-result character ceiling, optional collection cursor, and canonical workspace for local paths.
 * @returns JSON within the ceiling; continuations select item offsets, not platform-dependent text columns.
 * @throws When the cursor is stale, a collection or offset is absent, or a minimum result cannot fit.
 */
export function formatManuscriptReport(report: { task_key: string } & Record<string, unknown>, version: ManuscriptReportVersion,
  options: { maxCharacters: number; cursor?: ManuscriptReportCursor; cwd?: string }): string {
  const encode = (value: object) => serializeManuscriptData(value, options.cwd)
  if (!Number.isSafeInteger(options.maxCharacters) || options.maxCharacters < 1024) {
    throw new RangeError('MANUSCRIPT_REPORT_LIMIT: 完整审查结果预算至少为1024个UTF-16单元。')
  }
  const cursor = options.cursor ?? {}
  if (cursor.report_sha256 !== undefined && cursor.report_sha256 !== version) {
    throw Error('MANUSCRIPT_REPORT_STALE: 来源、采用稿、阅读覆盖或笔记已更新，请重新audit读取当前目录。')
  }
  if (cursor.report_section !== undefined && cursor.report_sha256 === undefined) {
    throw Error('MANUSCRIPT_REPORT_VERSION: 读取审查分组须携带目录返回的report_sha256。')
  }
  if (cursor.report_section === undefined && (cursor.report_offset !== undefined || cursor.report_limit !== undefined)) {
    throw Error('MANUSCRIPT_REPORT_SECTION: report_offset和report_limit须同时指定report_section。')
  }
  const complete = encode(report)
  if (cursor.report_section === undefined && complete.length <= options.maxCharacters) return complete
  const collections = new Map<string, readonly unknown[]>()
  const outline = (value: unknown, path: string, groups: Map<string, readonly unknown[]>): unknown => {
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value
      if (items.length === 0) return []
      groups.set(path, items)
      return { report_section: path, total_items: items.length }
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, outline(entry, path ? `${path}.${key}` : key, groups)]))
    }
    return value
  }
  const summary = outline(report, '', collections)
  const requests = (groups: Map<string, readonly unknown[]>) => [...groups].map(([section, items]) => ({
    section, total_items: items.length,
    request: { action: 'audit', report_sha256: version, report_section: section, report_offset: 1 } }))
  if (cursor.report_section === undefined) {
    const result = encode({ task_key: report.task_key, report_sha256: version, report_paged: true,
      summary, report_sections: requests(collections),
      advisory: true, semantic_assessment: 'not_performed',
      notice: '这是当前完整审查的分组目录，不是全部正文。按report_sections中的request读取各组，连续跟随continuation到null；不能把目录或最后一页当作已读全，也不能用覆盖率证明理解。' })
    if (result.length > options.maxCharacters) throw Error('MANUSCRIPT_REPORT_SIZE: 审查目录超出完整结果预算，请增加manuscriptReportMaxResultCharacters。')
    return result
  }
  let selected: unknown = report
  for (const key of cursor.report_section.split('.')) {
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) {
      throw Error('MANUSCRIPT_REPORT_SECTION: 当前审查没有该分组，请重新audit读取目录。')
    }
    selected = Reflect.get(selected, key)
  }
  if (!Array.isArray(selected) || selected.length === 0) throw Error('MANUSCRIPT_REPORT_SECTION: 当前审查没有该非空分组，请重新audit读取目录。')
  const items: readonly unknown[] = selected
  const isPathArray = pathArrayKeys.has(cursor.report_section.slice(cursor.report_section.lastIndexOf('.') + 1))
  const offset = cursor.report_offset ?? 1
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > items.length) throw Error('MANUSCRIPT_REPORT_OFFSET: 分组起始条目不存在。')
  if (cursor.report_limit !== undefined && (!Number.isSafeInteger(cursor.report_limit) || cursor.report_limit < 1)) {
    throw Error('MANUSCRIPT_REPORT_LIMIT: report_limit须为正整数。')
  }
  let count = Math.min(items.length - offset + 1, cursor.report_limit ?? items.length)
  for (;;) {
    const end = offset - 1 + count
    const page = (rows: readonly unknown[]) => encode({ task_key: report.task_key,
      report_sha256: version, report_section: cursor.report_section,
      report_offset: offset, items: isPathArray ? formatPathArray(rows, options.cwd) : rows, total_items: items.length,
      is_last_page: end === items.length,
      continuation: end === items.length ? null : { action: 'audit', report_sha256: version,
        report_section: cursor.report_section, report_offset: end + 1 },
      advisory: true, semantic_assessment: 'not_performed',
      notice: '完整条目或report_item_paged子目录均未截断原句；子目录须按report_sections读完。按continuation续读；is_last_page仅表示到达本组尾，不证明此前或子组已读。' })
    const result = page(items.slice(offset - 1, end))
    if (result.length <= options.maxCharacters) return result
    if (count === 1) {
      const nested = new Map<string, readonly unknown[]>()
      const summary = outline(items[offset - 1], `${cursor.report_section}.${offset - 1}`, nested)
      const grouped = page([{ report_item_paged: true, report_offset: offset, summary, report_sections: requests(nested) }])
      if (nested.size > 0 && grouped.length <= options.maxCharacters) return grouped
      throw Error('MANUSCRIPT_REPORT_SIZE: 单条记录的非集合字段或子目录超出完整结果预算，请增加manuscriptReportMaxResultCharacters；未截断记录。')
    }
    count = Math.max(1, Math.floor(count / 2))
  }
}
