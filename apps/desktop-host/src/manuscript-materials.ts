/** Explicit current, reference and candidate manuscript excerpts without selecting or adopting files. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readManuscript, type DocumentLimits } from './manuscript-document.ts'

const lineRangeSchema = z.strictObject({ start: z.number().int().positive(), end: z.number().int().positive() })
  .refine(range => range.end >= range.start, '结束行不能早于起始行。')
const documentSchema = z.strictObject({
  role: z.enum(['current', 'reference', 'candidate']),
  path: z.string().min(1).refine(path => path.trim().length > 0, '路径不能只有空白。'),
  episodes: z.array(z.number().int().positive()).min(1).optional(),
  lines: lineRangeSchema.optional(),
}).superRefine((document, ctx) => {
  if (document.episodes !== undefined && document.lines !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'episodes 与 lines 只能选择一种范围。' })
  }
  if (document.episodes !== undefined && new Set(document.episodes).size !== document.episodes.length) {
    ctx.addIssue({ code: 'custom', message: 'episodes 不能包含重复集号。' })
  }
})

/** Model/tool JSON requires one explicit current file and at most one separate candidate. */
export const materialDocumentsSchema = z.array(documentSchema).min(1).superRefine((documents, ctx) => {
  if (documents.filter(document => document.role === 'current').length !== 1) {
    ctx.addIssue({ code: 'custom', message: '必须明确且仅提供一份 current 当前稿。' })
  }
  if (documents.filter(document => document.role === 'candidate').length > 1) {
    ctx.addIssue({ code: 'custom', message: '最多提供一份 candidate 候选稿。' })
  }
})

/** Validated explicit document roles and optional episode or extracted-line selections. */
export type ManuscriptMaterialsInput = z.infer<typeof materialDocumentsSchema>

/** Application-owned extraction, file-count and returned-text budgets. */
export interface ManuscriptMaterialsLimits extends DocumentLimits {
  maxDocuments: number
  maxMaterialChars: number
}

/** Inclusive, one-based extracted-text line range; it is not a Word paragraph or page range. */
export interface ManuscriptMaterialRange { start: number; end: number }

/** An explicit episode heading and all following lines up to the next heading. */
export interface ManuscriptMaterialEpisode extends ManuscriptMaterialRange { episode: number }

/** Episode indexing reports uncertainty without treating scene numbers as episode headings. */
export interface ManuscriptMaterialEpisodeIndex {
  state: 'indexed' | 'unavailable' | 'ambiguous'
  episodes: ManuscriptMaterialEpisode[]
  issues: string[]
}

/** The exact requested selection and any adjacent episodes from the same current/candidate file. */
export type ManuscriptMaterialSelection = { kind: 'full' }
  | { kind: 'lines'; start: number; end: number }
  | { kind: 'episodes'; requested: number[]; included: number[]; adjacent: number[] }

/** One separately identified file and its complete selected text, in original line order. */
export interface ManuscriptMaterialsDocument {
  role: ManuscriptMaterialsInput[number]['role']
  path: string
  file_sha256: string
  text_sha256: string
  line_count: number
  lines: { number: number; text: string }[]
  selection: ManuscriptMaterialSelection
  coverage: {
    basis: 'returned_text_lines'
    read_ranges: ManuscriptMaterialRange[]
    unread_ranges: ManuscriptMaterialRange[]
    full_document: boolean
  }
  episode_index: ManuscriptMaterialEpisodeIndex
  unchanged_since_read: true
}

/** Factual materials only; returning text does not establish a semantic review. */
export interface ManuscriptMaterialsResult {
  state: 'materials'
  advisory: true
  semantic_assessment: 'not_performed'
  position_basis: 'extracted_text_lines'
  documents: ManuscriptMaterialsDocument[]
}

const digits = '零一二三四五六七八九'
const units: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 }

function chineseNumber(number: number): string {
  let result = '', gap = false
  for (const unit of [1000, 100, 10, 1]) {
    const digit = Math.floor(number / unit) % 10
    if (digit === 0) { if (result) gap = true; continue }
    if (gap) result += '零'
    gap = false
    if (!(unit === 10 && digit === 1 && result === '')) result += digits.charAt(digit)
    result += unit === 1 ? '' : unit === 10 ? '十' : unit === 100 ? '百' : '千'
  }
  return result
}

function episodeNumber(token: string): number | undefined {
  const normalized = token.replaceAll('〇', '零').replaceAll('两', '二')
  if (/^\d+$/u.test(normalized)) {
    const number = Number(normalized)
    return Number.isSafeInteger(number) && number > 0 ? number : undefined
  }
  if (!/^[零一二三四五六七八九十百千]+$/u.test(normalized)) return undefined
  if (!/[十百千]/u.test(normalized)) {
    const number = Number(normalized.split('').map(digit => digits.indexOf(digit)).join(''))
    return Number.isSafeInteger(number) && number > 0 ? number : undefined
  }
  let result = 0, digit = 0, previousUnit = 10000
  for (const character of normalized) {
    const unit = units[character]
    if (unit === undefined) digit = digits.indexOf(character)
    else {
      if (unit >= previousUnit) return undefined
      result += (digit || 1) * unit
      digit = 0; previousUnit = unit
    }
  }
  result += digit
  return normalized === chineseNumber(result) || result >= 10 && result < 20 && normalized === `一${chineseNumber(result)}`
    ? result : undefined
}

function unwrap(text: string): string {
  for (const [open, close] of [['(', ')'], ['[', ']'], ['【', '】']]) {
    if (open !== undefined && close !== undefined && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, -close.length).trim()
    }
  }
  return text
}

function episodeIndex(lines: readonly string[]): ManuscriptMaterialEpisodeIndex {
  const headings: { episode: number; start: number }[] = [], issues: string[] = []
  let current: number | undefined, fence: { character: string; length: number } | undefined
  for (const [index, text] of lines.entries()) {
    const normalized = text.normalize('NFKC').trim()
    const marker = /^(`{3,}|~{3,})(.*)$/u.exec(normalized)
    if (fence !== undefined) {
      if (marker?.[1] !== undefined && marker[1][0] === fence.character && marker[1].length >= fence.length
        && marker[2]?.trim().length === 0) fence = undefined
      continue
    }
    if (marker?.[1]?.[0] !== undefined) {
      fence = { character: marker[1][0], length: marker[1].length }
      continue
    }
    const line = normalized.replace(/^#{1,6}\s*/u, '')
    const heading = /^第\s*(.*?)\s*集(?=$|[\s:：(（【\[])/u.exec(unwrap(line))
    if (heading?.[1] !== undefined) {
      const episode = episodeNumber(unwrap(heading[1].trim()))
      if (episode === undefined) { issues.push(`第${index + 1}行集号无法可靠识别；请使用明确行范围。`); continue }
      if (headings.some(value => value.episode === episode)) issues.push(`第${index + 1}行重复出现第${episode}集。`)
      if (current !== undefined && episode < current) issues.push(`第${index + 1}行集号未按正文顺序递增。`)
      current = episode; headings.push({ episode, start: index + 1 })
      continue
    }
    const scene = /^(\d+)\s*[-—－]\s*\d+(?:\s|$|[.、])/u.exec(line)
    if (scene?.[1] !== undefined && Number(scene[1]) !== current) {
      issues.push(`第${index + 1}行场次集号${scene[1]}与${current === undefined ? '缺失的集标题' : `第${current}集标题`}不一致。`)
    }
  }
  return { state: headings.length === 0 ? 'unavailable' : issues.length ? 'ambiguous' : 'indexed',
    episodes: headings.map((heading, index) => ({ ...heading, end: (headings[index + 1]?.start ?? lines.length + 1) - 1 })), issues }
}

function rangesFor(numbers: readonly number[]): ManuscriptMaterialRange[] {
  const ranges: ManuscriptMaterialRange[] = []
  for (const number of numbers) {
    const previous = ranges.at(-1)
    if (previous !== undefined && previous.end + 1 === number) previous.end = number
    else ranges.push({ start: number, end: number })
  }
  return ranges
}

function select(document: ManuscriptMaterialsInput[number], index: ManuscriptMaterialEpisodeIndex,
  lineCount: number): { selection: ManuscriptMaterialSelection; ranges: ManuscriptMaterialRange[] } {
  if (document.lines !== undefined) {
    if (document.lines.end > lineCount) throw Error(`MANUSCRIPT_MATERIALS_RANGE: ${document.path}只有${lineCount}行，不能截短所请求范围。`)
    return { selection: { kind: 'lines', ...document.lines }, ranges: [document.lines] }
  }
  if (document.episodes === undefined) return { selection: { kind: 'full' }, ranges: [{ start: 1, end: lineCount }] }
  if (index.state !== 'indexed') {
    throw Error(`MANUSCRIPT_MATERIALS_EPISODES: ${document.path}集号缺失或存在歧义，请明确行范围。${index.issues.join('')}`)
  }
  const included = new Set(document.episodes)
  for (const episode of document.episodes) {
    const position = index.episodes.findIndex(value => value.episode === episode)
    if (position < 0) throw Error(`MANUSCRIPT_MATERIALS_EPISODES: ${document.path}没有第${episode}集，不以其他集代替。`)
    if (document.role !== 'reference') for (const neighbor of [index.episodes[position - 1], index.episodes[position + 1]]) {
      if (neighbor !== undefined) included.add(neighbor.episode)
    }
  }
  const episodes = index.episodes.filter(episode => included.has(episode.episode))
  return { selection: { kind: 'episodes', requested: document.episodes, included: episodes.map(episode => episode.episode),
    adjacent: episodes.filter(episode => !document.episodes?.includes(episode.episode)).map(episode => episode.episode) },
  ranges: episodes.map(({ start, end }) => ({ start, end })) }
}

/**
 * Read only explicitly named files and return complete selected extracted-text lines.
 * @param raw - Tool JSON documents; roles and mutually exclusive selectors are validated here.
 * @param cwd - Session working directory for relative paths; no ledger, directory scan or mtime selection is used.
 * @param limits - Validated application extraction, document-count and returned-body budgets.
 * @param signal - Cancels reads and the final file-version verification.
 * @returns Separate current/reference/candidate snapshots, coverage and exact hashes; no semantic judgment or persistent binding.
 */
export async function readManuscriptMaterials(raw: unknown, cwd: string, limits: ManuscriptMaterialsLimits,
  signal: AbortSignal): Promise<ManuscriptMaterialsResult> {
  const inputs = materialDocumentsSchema.parse(raw)
  if (inputs.length > limits.maxDocuments) throw Error('MANUSCRIPT_MATERIALS_DOCUMENTS: 文件数超出限制，请按实际范围分批读取。')
  const snapshots: { input: ManuscriptMaterialsInput[number]; path: string; fileHash: string }[] = [], paths = new Set<string>()
  const documents: ManuscriptMaterialsDocument[] = []
  let characters = 0
  for (const input of inputs) {
    const document = await readManuscript(input.path, cwd, limits, signal)
    if (paths.has(document.path)) throw Error('MANUSCRIPT_MATERIALS_ROLES: 同一规范路径不能重复提供或同时充当不同稿件角色。')
    paths.add(document.path)
    const lines = document.text.split(/\r\n|\r|\n/u), index = episodeIndex(lines)
    const selected = select(input, index, lines.length)
    const returned = lines.flatMap((text, position) => selected.ranges.some(range =>
      position + 1 >= range.start && position + 1 <= range.end)
      ? [{ number: position + 1, text }] : [])
    characters += returned.map(line => line.text).join('\n').length
    if (characters > limits.maxMaterialChars) {
      throw Error(`MANUSCRIPT_MATERIALS_BUDGET: 所选完整材料共${characters}字符，超过${limits.maxMaterialChars}字符限制；请缩小集数或明确行范围，不截断为首尾摘录。`)
    }
    const read = new Set(returned.map(line => line.number))
    documents.push({ role: input.role, path: document.path, file_sha256: document.sha256,
      text_sha256: createHash('sha256').update(document.text).digest('hex'), line_count: lines.length,
      lines: returned, selection: selected.selection,
      coverage: { basis: 'returned_text_lines', read_ranges: rangesFor(returned.map(line => line.number)),
        unread_ranges: rangesFor(lines.flatMap((_line, position) => read.has(position + 1) ? [] : [position + 1])),
        full_document: returned.length === lines.length }, episode_index: index, unchanged_since_read: true })
    snapshots.push({ input, path: document.path, fileHash: document.sha256 })
  }
  for (const snapshot of snapshots) {
    const current = await readManuscript(snapshot.input.path, cwd, limits, signal)
    if (current.path !== snapshot.path || current.sha256 !== snapshot.fileHash) {
      throw Error('MANUSCRIPT_MATERIALS_CHANGED: 文件在材料读取期间变化，请重新读取当前版本。')
    }
  }
  return { state: 'materials', advisory: true, semantic_assessment: 'not_performed', position_basis: 'extracted_text_lines', documents }
}
