/** Bounded, position-preserving literal repetition candidates within one explicitly selected manuscript. */
import { createHash } from 'node:crypto'
import type { ManuscriptMaterialRange, ManuscriptMaterialsDocument } from './manuscript-materials.ts'

/** Deployment budgets bound complete seeds, pair enumeration and whole returned candidates. */
export interface RepeatScanLimits {
  repeatMinChars: number
  repeatMaxSeedPairs: number
  repeatMaxCandidates: number
  repeatMaxOutputChars: number
}

/** Inclusive source position measured in Unicode code points, with LF at the preceding line's last column plus one. */
export interface RepeatScanPosition { line: number; column: number }
/** A complete matching span in the assessed manuscript, without inferred episode labels. */
export interface RepeatScanOccurrence {
  start: RepeatScanPosition
  end: RepeatScanPosition
  episode: number | null
}
/** Literal matching text is a review candidate, never evidence that its narrative use is redundant. */
export interface RepeatScanCandidate {
  candidate_sha256: string
  text: string
  characters: number
  occurrences: RepeatScanOccurrence[]
}
type LimitReason = 'seed_pair_budget' | 'candidate_limit' | 'output_chars_limit'
/** The chosen reading scope and actual enumeration/output limits stay separate from semantic review. */
export interface RepeatScanResult {
  state: 'repeat_scan'
  semantic_assessment: 'not_performed'
  target: Pick<ManuscriptMaterialsDocument, 'role' | 'path' | 'file_sha256' | 'text_sha256'>
  threshold_chars: number
  position_basis: 'unicode_code_points_one_based_inclusive'
  coverage: {
    read_ranges: ManuscriptMaterialRange[]
    unread_ranges: ManuscriptMaterialRange[]
    full_document: boolean
    complete: boolean
    enumeration_complete: boolean
    omitted_candidates: number
    stop_reason: LimitReason | null
    examined_seed_pairs: number
    excluded_ranges: ManuscriptMaterialRange[]
    limit_reasons: LimitReason[]
  }
  candidates: RepeatScanCandidate[]
  notice: string
}

interface Chunk { characters: string[]; positions: RepeatScanPosition[]; episode: number | null }
interface SeedOccurrence { chunk: number; offset: number }
interface Interval { start: number; end: number }
interface Diagonal { left: number; right: number; delta: number; intervals: Interval[] }

function structural(text: string): boolean {
  let line = text.replace(/^\uFEFF/u, '').trim()
  if (/^#{1,6}\s/u.test(line) || /^(?:`{3,}|~{3,})/u.test(line) || /^(?:[-_*]\s*){3,}$/u.test(line)) return true
  for (const [open, close] of [['(', ')'], ['（', '）'], ['[', ']'], ['【', '】']]) {
    if (open !== undefined && close !== undefined && line.startsWith(open) && line.endsWith(close)) {
      line = line.slice(open.length, -close.length).trim()
    }
  }
  return /^第\s*[\d一二三四五六七八九十百千零〇两]+\s*集(?=$|[\s:：(（【\[])/u.test(line)
    || /^(?:EP(?:ISODE)?\.?\s*\d+)(?=$|[\s:：-])/iu.test(line)
    || /^\d+\s*[-—－]\s*\d+(?:\s|[.、]|$)/u.test(line)
    || /^(?:INT|EXT|INT\/EXT|EXT\/INT)\./iu.test(line)
    || /^(?:人物|出场人物|场景|地点|时间|时长|集数|字数|剧名|作者|编剧|版本|页码|Title|Author|Draft|Version|Cast|Characters|Location|Time)\s*[:：]/iu.test(line)
}

function appendRange(ranges: ManuscriptMaterialRange[], line: number): void {
  const previous = ranges.at(-1)
  if (previous?.end === line - 1) previous.end = line
  else ranges.push({ start: line, end: line })
}

function chunksOf(document: ManuscriptMaterialsDocument, signal: AbortSignal): { chunks: Chunk[]; excluded: ManuscriptMaterialRange[] } {
  const chunks: Chunk[] = [], excluded: ManuscriptMaterialRange[] = []
  let active: Chunk | undefined, previous: { line: number; columns: number } | undefined
  for (const line of document.lines) {
    signal.throwIfAborted()
    if (structural(line.text)) { appendRange(excluded, line.number); active = undefined; previous = undefined; continue }
    const episode = document.episode_index.state === 'indexed'
      ? document.episode_index.episodes.find(value => value.start <= line.number && line.number <= value.end)?.episode ?? null : null
    if (active === undefined || previous?.line !== line.number - 1 || active.episode !== episode) {
      active = { characters: [], positions: [], episode }; chunks.push(active)
    } else {
      active.characters.push('\n'); active.positions.push({ line: previous.line, column: previous.columns + 1 })
    }
    const characters = Array.from(line.text)
    for (const [column, character] of characters.entries()) {
      active.characters.push(character); active.positions.push({ line: line.number, column: column + 1 })
    }
    previous = { line: line.number, columns: characters.length }
  }
  return { chunks, excluded }
}

function positionOrder(left: RepeatScanPosition, right: RepeatScanPosition): number {
  return left.line - right.line || left.column - right.column
}

function literalCandidates(document: ManuscriptMaterialsDocument, chunks: readonly Chunk[], diagonals: Iterable<Diagonal>,
  signal: AbortSignal): RepeatScanCandidate[] {
  const byText = new Map<string, { characters: number; occurrences: Map<string, RepeatScanOccurrence> }>()
  for (const diagonal of diagonals) {
    signal.throwIfAborted()
    const left = chunks[diagonal.left], right = chunks[diagonal.right]
    if (left === undefined || right === undefined) throw Error('REPEAT_SCAN_CHUNK: An indexed body chunk is missing.')
    for (const interval of diagonal.intervals) {
      const length = Math.min(interval.end - interval.start, diagonal.left === diagonal.right ? diagonal.delta : Infinity)
      const text = left.characters.slice(interval.start, interval.start + length).join('')
      if (text.trim().length === 0) continue
      let candidate = byText.get(text)
      if (candidate === undefined) { candidate = { characters: length, occurrences: new Map() }; byText.set(text, candidate) }
      for (const [chunk, start] of [[left, interval.start], [right, interval.start + diagonal.delta]] as const) {
        const rangeStart = chunk.positions[start], rangeEnd = chunk.positions[start + length - 1]
        if (rangeStart === undefined || rangeEnd === undefined) throw Error('REPEAT_SCAN_POSITION: A literal match position is missing.')
        const occurrence = { start: rangeStart, end: rangeEnd, episode: chunk.episode }
        candidate.occurrences.set(JSON.stringify([occurrence.start, occurrence.end]), occurrence)
      }
    }
  }
  const result: { candidate: RepeatScanCandidate; first: RepeatScanPosition }[] = []
  for (const [text, candidate] of byText) {
    signal.throwIfAborted()
    const occurrences: RepeatScanOccurrence[] = []
    for (const occurrence of [...candidate.occurrences.values()].sort((left, right) => positionOrder(left.start, right.start))) {
      const previous = occurrences.at(-1)
      if (previous === undefined || positionOrder(previous.end, occurrence.start) < 0) occurrences.push(occurrence)
    }
    const first = occurrences[0]
    if (occurrences.length < 2 || first === undefined) continue
    const candidate_sha256 = createHash('sha256').update(JSON.stringify([document.file_sha256, text, occurrences])).digest('hex')
    result.push({ candidate: { candidate_sha256, text, characters: candidate.characters, occurrences }, first: first.start })
  }
  return result.sort((left, right) => right.candidate.characters - left.candidate.characters
    || positionOrder(left.first, right.first)
    || (left.candidate.text < right.candidate.text ? -1 : left.candidate.text > right.candidate.text ? 1 : 0)).map(value => value.candidate)
}

/** Scan every possible minimum-length literal seed in the returned target body, without comparing draft versions.
 * @param document - One explicitly assessed document, with actual returned line numbers and reading coverage.
 * @param limits - Validated positive budgets; pair/output exhaustion is explicit and never a zero-repetition conclusion.
 * @param signal - Cancellation checked during chunking, enumeration and result construction.
 * @returns Whole literal candidates and honest chosen-scope coverage; structural lines and unread gaps are never concatenated.
 */
export function scanManuscriptRepetitions(document: ManuscriptMaterialsDocument, limits: RepeatScanLimits,
  signal: AbortSignal): RepeatScanResult {
  signal.throwIfAborted()
  const { chunks, excluded } = chunksOf(document, signal)
  const seeds = new Map<string, SeedOccurrence[]>(), diagonals = new Map<string, Diagonal>()
  let examined = 0, enumerationComplete = true
  enumerate: for (const [chunkIndex, chunk] of chunks.entries()) {
    for (let offset = 0; offset + limits.repeatMinChars <= chunk.characters.length; offset++) {
      signal.throwIfAborted()
      const key = chunk.characters.slice(offset, offset + limits.repeatMinChars).join('')
      const previous = seeds.get(key) ?? []
      for (const occurrence of previous) {
        if (examined >= limits.repeatMaxSeedPairs) { enumerationComplete = false; break enumerate }
        signal.throwIfAborted(); examined++
        if (occurrence.chunk === chunkIndex && offset - occurrence.offset < limits.repeatMinChars) continue
        const delta = offset - occurrence.offset, groupKey = `${occurrence.chunk}:${chunkIndex}:${delta}`
        let diagonal = diagonals.get(groupKey)
        if (diagonal === undefined) {
          diagonal = { left: occurrence.chunk, right: chunkIndex, delta, intervals: [] }; diagonals.set(groupKey, diagonal)
        }
        const interval = diagonal.intervals.at(-1), end = occurrence.offset + limits.repeatMinChars
        if (interval !== undefined && occurrence.offset <= interval.end) interval.end = Math.max(interval.end, end)
        else diagonal.intervals.push({ start: occurrence.offset, end })
      }
      previous.push({ chunk: chunkIndex, offset }); seeds.set(key, previous)
    }
  }
  const all = literalCandidates(document, chunks, diagonals.values(), signal), candidates: RepeatScanCandidate[] = []
  const reasons: LimitReason[] = enumerationComplete ? [] : ['seed_pair_budget']
  let outputChars = 2
  for (const candidate of all) {
    signal.throwIfAborted()
    if (candidates.length >= limits.repeatMaxCandidates) {
      if (!reasons.includes('candidate_limit')) reasons.push('candidate_limit')
      continue
    }
    const characters = Array.from(JSON.stringify(candidate)).length + (candidates.length ? 1 : 0)
    if (outputChars + characters > limits.repeatMaxOutputChars) {
      if (!reasons.includes('output_chars_limit')) reasons.push('output_chars_limit')
      continue
    }
    outputChars += characters; candidates.push(candidate)
  }
  signal.throwIfAborted()
  return { state: 'repeat_scan', semantic_assessment: 'not_performed',
    target: { role: document.role, path: document.path, file_sha256: document.file_sha256, text_sha256: document.text_sha256 },
    threshold_chars: limits.repeatMinChars, position_basis: 'unicode_code_points_one_based_inclusive',
    coverage: { read_ranges: document.coverage.read_ranges.map(range => ({ ...range })),
      unread_ranges: document.coverage.unread_ranges.map(range => ({ ...range })), full_document: document.coverage.full_document,
      complete: enumerationComplete && candidates.length === all.length, enumeration_complete: enumerationComplete,
      omitted_candidates: all.length - candidates.length, stop_reason: reasons[0] ?? null, examined_seed_pairs: examined,
      excluded_ranges: excluded, limit_reasons: reasons }, candidates,
    notice: '仅返回所选稿正文中达到阈值的连续字面重复候选，不判断剧情重复，也不自动删改。集场标题、人物与纯元数据被排除并断开匹配，未读行不拼接。位置为1起始、两端包含的Unicode码点列，LF在前一行末后一列。普通接续、回忆、强调或有新信息的再次行动须结合完整场景独立判断；零候选不代表零剧情重复，预算中止或输出遗漏均不是完整结论。' }
}
