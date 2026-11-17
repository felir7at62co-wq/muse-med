/** Literal transcript matching for screenplay drafts: comparable text, line kinds and ordered character alignment. */
import { diffArrays } from 'diff'
import { manuscriptDialogue } from './manuscript-advisories.ts'
import { isManuscriptEpisodeHeading } from './manuscript-materials.ts'
import { MANUSCRIPT_HOOK_MARKER } from './manuscript-presentation.ts'
import { MANUSCRIPT_METADATA_LINE } from './manuscript-repeat-scan.ts'

/** Half-open range of original Unicode code points. */
export interface TranscriptSpan { start: number; end: number }

/** Comparable characters of one text; each character keeps the original code-point span it came from. */
export interface TranscriptText {
  /** Original code points; every span indexes this array. */
  source: string[]
  chars: string[]
  spans: TranscriptSpan[]
}

const DIGITS: Readonly<Record<string, number>> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 }
const MAGNITUDES: Readonly<Record<string, number>> = { 万: 10_000, 亿: 100_000_000 }
const NUMERAL = /^[0-9〇零一二两三四五六七八九十百千万亿]$/u
const COMPARABLE = /^[\p{L}\p{N}]$/u

function at<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) throw Error(`TRANSCRIPT_ALIGNMENT_INDEX: position ${index} is outside the aligned text.`)
  return value
}

/** Value of a numeral run mixing Arabic and Chinese digits, or undefined when the run is not one well-formed number. */
function numeralValue(run: readonly string[]): number | undefined {
  let total = 0, section = 0, lastUnit = Infinity, lastMagnitude = Infinity, zero = false, digits = 0
  let digit: number | undefined
  for (const character of run) {
    if (character >= '0' && character <= '9') {
      if (digit !== undefined && digits === 0) return undefined
      digit = (digit ?? 0) * 10 + Number(character); digits++
      continue
    }
    const chinese = DIGITS[character]
    if (chinese !== undefined) {
      if (digit !== undefined) return undefined
      if (chinese === 0) zero = true
      else { digit = chinese; digits = 0 }
      continue
    }
    const unit = UNITS[character]
    if (unit !== undefined) {
      if (unit >= lastUnit) return undefined
      section += (digit ?? 1) * unit; digit = undefined; digits = 0; lastUnit = unit; zero = false
      continue
    }
    const magnitude = MAGNITUDES[character]
    if (magnitude === undefined || magnitude >= lastMagnitude) return undefined
    section += digit ?? 0; digit = undefined; digits = 0
    total += (section || 1) * magnitude; section = 0; lastUnit = Infinity; lastMagnitude = magnitude; zero = false
  }
  if (digit !== undefined) {
    // A bare trailing digit after a unit is colloquial shorthand: 两万四 is 24000 and 一千五 is 1500.
    const previous = run.at(-2) ?? '', unit = MAGNITUDES[previous] ?? UNITS[previous] ?? 1
    section += digit * (zero || digits > 1 || unit <= 10 ? 1 : unit / 10)
  }
  return total + section
}

/**
 * Comparable text: NFKC, lowercase, Chinese and Arabic numerals folded to one decimal value, only letters and numbers kept.
 * A numeral run containing 十, 百, 千, 万 or 亿 that forms one number becomes its decimal digits; other Chinese digits map
 * one by one. Pronunciation is not compared, so homophones stay different.
 * @param text - Original text.
 * @returns Comparable characters with the original code-point span of each.
 */
export function normalizeTranscriptText(text: string): TranscriptText {
  const source = Array.from(text), items: { char: string; span: TranscriptSpan }[] = []
  for (const [index, point] of source.entries()) {
    for (const char of point.normalize('NFKC').toLowerCase()) items.push({ char, span: { start: index, end: index + 1 } })
  }
  const chars: string[] = [], spans: TranscriptSpan[] = []
  const keep = (char: string, span: TranscriptSpan) => {
    if (COMPARABLE.test(char)) { chars.push(char); spans.push(span) }
  }
  let run: typeof items = []
  const flush = () => {
    const first = run[0], last = run.at(-1)
    const value = first !== undefined && last !== undefined && run.some(item => UNITS[item.char] !== undefined
      || MAGNITUDES[item.char] !== undefined) ? numeralValue(run.map(item => item.char)) : undefined
    if (first !== undefined && last !== undefined && value !== undefined && Number.isSafeInteger(value)) {
      for (const char of String(value)) keep(char, { start: first.span.start, end: last.span.end })
    } else for (const item of run) keep(DIGITS[item.char]?.toString() ?? item.char, item.span)
    run = []
  }
  for (const item of items) {
    if (NUMERAL.test(item.char)) { run.push(item); continue }
    flush()
    keep(item.char, item.span)
  }
  flush()
  return { source, chars, spans }
}

/** Screenplay line kinds; only `dialogue` speech is compared with source text as dialogue. */
export type ScreenplayLineKind = 'blank' | 'episode_heading' | 'scene_heading' | 'metadata' | 'action' | 'hook' | 'marker'
  | 'dialogue' | 'other'

/** One classified line; dialogue keeps its speaker label and its speech without parentheticals. */
export type ScreenplayLine = { kind: Exclude<ScreenplayLineKind, 'dialogue'> } | { kind: 'dialogue'; speaker: string; speech: string }

/**
 * Classify one extracted manuscript line by its literal form, without judging content.
 * @param raw - One line of extracted manuscript text.
 * @returns Its kind; a speech line whose comparable text is empty is `other`.
 */
export function classifyScreenplayLine(raw: string): ScreenplayLine {
  const plain = raw.trim().replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)/u, '')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1').replace(/__([^_\n]+)__/gu, '$1').trim()
  const line = plain.normalize('NFKC')
  if (!line) return { kind: 'blank' }
  if (isManuscriptEpisodeHeading(line)) return { kind: 'episode_heading' }
  if (/^\d+\s*[-—－]\s*\d+(?:\s|[.、]|$)/u.test(line)) return { kind: 'scene_heading' }
  if (MANUSCRIPT_METADATA_LINE.test(line)) return { kind: 'metadata' }
  if (/^[▲△]/u.test(line)) return { kind: 'action' }
  if (MANUSCRIPT_HOOK_MARKER.test(line)) return { kind: 'hook' }
  if (/^【[^】]*】/u.test(line)) return { kind: 'marker' }
  const dialogue = manuscriptDialogue({ path: '', scene: '', episode: '', line: 0, quote: plain })
  if (dialogue !== undefined) {
    const speech = dialogue.text.replace(/[（(][^（）()]*[）)]/gu, '')
    if (normalizeTranscriptText(speech).chars.length) return { kind: 'dialogue', speaker: dialogue.speaker.normalize('NFKC'), speech }
  }
  return { kind: 'other' }
}

/** Character alignment of source units (ASR or on-screen segments) with draft lines, both in their own order. */
export interface TranscriptAlignment {
  /** Per unit and comparable character: aligned with a linked line. */
  unitMarks: boolean[][]
  /** Per line and comparable character: aligned with a linked unit. */
  lineMarks: boolean[][]
  /** Units whose aligned share reached the minimum similarity. */
  unitMatched: boolean[]
  /** Lines whose aligned share reached the minimum similarity. */
  lineMatched: boolean[]
  /** Per line: linked unit index and the number of its aligned characters. */
  links: Map<number, number>[]
}

interface Sequence { chars: string[]; owners: number[]; positions: number[] }
interface Operation { kind: 'add' | 'del' | 'eq'; count: number }

function concatenate(texts: readonly TranscriptText[], matched: readonly boolean[]): Sequence {
  const sequence: Sequence = { chars: [], owners: [], positions: [] }
  for (const [owner, text] of texts.entries()) {
    if (matched[owner] === true) continue
    for (const [position, char] of text.chars.entries()) {
      sequence.chars.push(char); sequence.owners.push(owner); sequence.positions.push(position)
    }
  }
  return sequence
}

function boundaryScore(owners: readonly number[], start: number, end: number): number {
  return (start === 0 || owners[start - 1] !== owners[start] ? 1 : 0) + (end === owners.length || owners[end - 1] !== owners[end] ? 1 : 0)
}

/** Move each pure insertion or deletion between two equal runs across identical text to its best owner boundaries. */
function slide(operations: Operation[], unitSide: Sequence, lineSide: Sequence): Operation[] {
  let x = 0, y = 0
  for (const [index, operation] of operations.entries()) {
    const before = operations[index - 1], after = operations[index + 1]
    if (operation.kind !== 'eq' && before?.kind === 'eq' && after?.kind === 'eq') {
      const side = operation.kind === 'add' ? lineSide : unitSide, start = operation.kind === 'add' ? y : x, count = operation.count
      let best = 0, bestScore = boundaryScore(side.owners, start, start + count)
      for (let shift = -1; -shift <= before.count && side.chars[start + shift] === side.chars[start + shift + count]; shift--) {
        const score = boundaryScore(side.owners, start + shift, start + shift + count)
        if (score > bestScore) { best = shift; bestScore = score }
      }
      for (let shift = 1; shift <= after.count && side.chars[start + shift - 1] === side.chars[start + shift - 1 + count]; shift++) {
        const score = boundaryScore(side.owners, start + shift, start + shift + count)
        if (score > bestScore) { best = shift; bestScore = score }
      }
      before.count += best; after.count -= best; x += best; y += best
    }
    if (operation.kind !== 'add') x += operation.count
    if (operation.kind !== 'del') y += operation.count
  }
  return operations.filter(operation => operation.count > 0)
}

function alignPass(units: readonly TranscriptText[], lines: readonly TranscriptText[], alignment: TranscriptAlignment,
  maxEditLength: number): boolean {
  const unitSide = concatenate(units, alignment.unitMatched), lineSide = concatenate(lines, alignment.lineMatched)
  const changes = diffArrays(unitSide.chars, lineSide.chars, { maxEditLength })
  if (changes === undefined) return false
  const operations = slide(changes.map(change => ({ kind: change.added ? 'add' : change.removed ? 'del' : 'eq', count: change.count })),
    unitSide, lineSide)
  const runs: { unit: number; line: number; x: number; y: number; length: number }[] = []
  let x = 0, y = 0
  for (const operation of operations) {
    if (operation.kind === 'add') { y += operation.count; continue }
    if (operation.kind === 'del') { x += operation.count; continue }
    let start = 0
    for (let offset = 1; offset <= operation.count; offset++) {
      if (offset < operation.count && unitSide.owners[x + offset] === unitSide.owners[x + offset - 1]
        && lineSide.owners[y + offset] === lineSide.owners[y + offset - 1]) continue
      runs.push({ unit: at(unitSide.owners, x + start), line: at(lineSide.owners, y + start), x: x + start, y: y + start,
        length: offset - start })
      start = offset
    }
    x += operation.count; y += operation.count
  }
  // A shared run of two code points (the shortest Chinese word), or a whole unit or line, links a pair; all its runs count.
  const linked = new Set(runs.filter(run => run.length >= 2 || run.length === at(units, run.unit).chars.length
    || run.length === at(lines, run.line).chars.length).map(run => `${run.unit}:${run.line}`))
  for (const run of runs) {
    if (!linked.has(`${run.unit}:${run.line}`)) continue
    const unitMarks = at(alignment.unitMarks, run.unit), lineMarks = at(alignment.lineMarks, run.line)
    for (let offset = 0; offset < run.length; offset++) {
      unitMarks[at(unitSide.positions, run.x + offset)] = true
      lineMarks[at(lineSide.positions, run.y + offset)] = true
    }
    const links = at(alignment.links, run.line)
    links.set(run.unit, (links.get(run.unit) ?? 0) + run.length)
  }
  return true
}

function share(marks: readonly boolean[]): number {
  return marks.length === 0 ? 0 : marks.filter(Boolean).length / marks.length
}

function emptyAlignment(units: readonly TranscriptText[], lines: readonly TranscriptText[]): TranscriptAlignment {
  return { unitMarks: units.map(unit => unit.chars.map(() => false)), lineMarks: lines.map(line => line.chars.map(() => false)),
    unitMatched: units.map(() => false), lineMatched: lines.map(() => false), links: lines.map(() => new Map<number, number>()) }
}

function bigrams(text: TranscriptText): Set<string> {
  const result = new Set<string>()
  for (let index = 1; index < text.chars.length; index++) result.add(at(text.chars, index - 1) + at(text.chars, index))
  return result
}

/** Align each still-unmatched unit alone with the unmatched line sharing the most distinct two-character sequences. */
function alignLeftovers(units: readonly TranscriptText[], lines: readonly TranscriptText[], alignment: TranscriptAlignment,
  maxEditLength: number): boolean {
  const candidates = lines.map((line, index) => alignment.lineMatched[index] === true ? new Set<string>() : bigrams(line))
  for (const [unitIndex, unit] of units.entries()) {
    if (alignment.unitMatched[unitIndex] === true) continue
    const grams = bigrams(unit)
    let best = -1, shared = 0
    for (const [lineIndex, lineGrams] of candidates.entries()) {
      let count = 0
      for (const gram of grams) if (lineGrams.has(gram)) count++
      if (count > shared) { best = lineIndex; shared = count }
    }
    if (best < 0) continue
    const pair = emptyAlignment([unit], [at(lines, best)])
    if (!alignPass([unit], [at(lines, best)], pair, maxEditLength)) return false
    const unitMarks = at(alignment.unitMarks, unitIndex), lineMarks = at(alignment.lineMarks, best), links = at(alignment.links, best)
    for (const [position, marked] of at(pair.unitMarks, 0).entries()) if (marked) unitMarks[position] = true
    for (const [position, marked] of at(pair.lineMarks, 0).entries()) if (marked) lineMarks[position] = true
    const count = at(pair.links, 0).get(0)
    if (count !== undefined) links.set(unitIndex, (links.get(unitIndex) ?? 0) + count)
  }
  return true
}

/**
 * Align source units with draft lines in order, align the units and lines left unmatched once more in order, then align
 * each unit still unmatched alone with the unmatched line sharing the most two-character sequences, so sparse source
 * text is not lost to scattered single-character matches. A unit under two characters takes part only in the ordered passes.
 * @param units - Source segments in time order.
 * @param lines - Draft lines in text order.
 * @param minSimilarity - Share of a unit's or line's comparable characters that must be aligned for it to match.
 * @param maxEditLength - Character edits searched by each comparison.
 * @param signal - Cancellation checked before each pass.
 * @returns Character marks, matches and links, or `edit_limit` when a comparison exceeds the edit budget.
 */
export function alignTranscript(units: readonly TranscriptText[], lines: readonly TranscriptText[], minSimilarity: number,
  maxEditLength: number, signal: AbortSignal): TranscriptAlignment | 'edit_limit' {
  const alignment = emptyAlignment(units, lines)
  for (let pass = 0; pass < 3; pass++) {
    signal.throwIfAborted()
    if (!(pass < 2 ? alignPass(units, lines, alignment, maxEditLength) : alignLeftovers(units, lines, alignment, maxEditLength))) {
      return 'edit_limit'
    }
    for (const [index, marks] of alignment.unitMarks.entries()) if (share(marks) >= minSimilarity) alignment.unitMatched[index] = true
    for (const [index, marks] of alignment.lineMarks.entries()) if (share(marks) >= minSimilarity) alignment.lineMatched[index] = true
  }
  return alignment
}

/** Matched units split by source order relative to their placed lines. */
export interface TranscriptOrder {
  /** Unit index → the line it is placed on. */
  placement: Map<number, number>
  inOrder: number[]
  outOfOrder: number[]
}

/**
 * Place each matched unit on its linked line with the most aligned characters, preferring matched lines and then
 * earlier lines; the longest non-decreasing run of placements in source order is in order, the rest out of order.
 * @param alignment - Result of {@link alignTranscript}.
 * @returns Placements and the in-order and out-of-order unit indexes, each ascending.
 */
export function orderMatchedUnits(alignment: TranscriptAlignment): TranscriptOrder {
  const best = new Map<number, { line: number; matched: boolean; count: number }>()
  for (const [line, links] of alignment.links.entries()) {
    const matched = alignment.lineMatched[line] === true
    for (const [unit, count] of links) {
      if (alignment.unitMatched[unit] !== true) continue
      const prior = best.get(unit)
      if (prior === undefined || matched && !prior.matched || matched === prior.matched && count > prior.count) {
        best.set(unit, { line, matched, count })
      }
    }
  }
  const placed = [...best.entries()].sort((left, right) => left[0] - right[0])
  const tails: number[] = [], previous: number[] = []
  for (const [index, [, { line }]] of placed.entries()) {
    let low = 0, high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (at(placed, at(tails, middle))[1].line <= line) low = middle + 1
      else high = middle
    }
    previous[index] = low > 0 ? at(tails, low - 1) : -1
    tails[low] = index
  }
  const inOrder = new Set<number>()
  for (let index = tails.at(-1) ?? -1; index >= 0; index = at(previous, index)) inOrder.add(at(placed, index)[0])
  return { placement: new Map([...best].map(([unit, { line }]) => [unit, line])),
    inOrder: placed.map(([unit]) => unit).filter(unit => inOrder.has(unit)),
    outOfOrder: placed.map(([unit]) => unit).filter(unit => !inOrder.has(unit)) }
}

function quote(text: TranscriptText, from: number, to: number): string {
  return text.source.slice(at(text.spans, from).start, at(text.spans, to - 1).end).join('')
}

/**
 * Quote unaligned stretches of a text.
 * @param text - Comparable text with its original source.
 * @param marks - Per comparable character: aligned.
 * @param minGapChars - Shortest reported stretch, in comparable characters.
 * @returns Original-text quotes of unaligned stretches at least `minGapChars` long.
 */
export function unmarkedFragments(text: TranscriptText, marks: readonly boolean[], minGapChars: number): string[] {
  const fragments: string[] = []
  let start = -1
  for (let index = 0; index <= text.chars.length; index++) {
    if (index < text.chars.length && marks[index] !== true) {
      if (start < 0) start = index
      continue
    }
    if (start >= 0 && index - start >= minGapChars) fragments.push(quote(text, start, index))
    start = -1
  }
  return fragments
}

/** A replaced stretch between a draft line and on-screen text, quoted from both originals. */
export interface TranscriptSubstitution {
  draft: string
  on_screen: string
  /** Index of the on-screen unit holding the first replaced character. */
  unit: number
}

/**
 * Character substitutions of a draft line against its on-screen text; pure insertions and deletions are not reported.
 * @param onScreen - On-screen units linked to the line, in time order.
 * @param line - The draft line's comparable speech.
 * @param maxEditLength - Character edits searched.
 * @returns Each replaced stretch, or `edit_limit` when the comparison exceeds the edit budget.
 */
export function substitutionHunks(onScreen: readonly TranscriptText[], line: TranscriptText,
  maxEditLength: number): TranscriptSubstitution[] | 'edit_limit' {
  const screen = concatenate(onScreen, [])
  const changes = diffArrays(screen.chars, line.chars, { maxEditLength })
  if (changes === undefined) return 'edit_limit'
  const hunks: TranscriptSubstitution[] = []
  let x = 0, y = 0, removed: number[] = [], added: number[] = []
  const flush = () => {
    const first = removed[0], last = added.at(-1), start = added[0]
    if (first !== undefined && last !== undefined && start !== undefined) {
      const pieces: string[] = []
      let pieceStart = first
      for (const [index, position] of removed.entries()) {
        const next = removed[index + 1]
        if (next !== undefined && screen.owners[next] === screen.owners[position]) continue
        const owner = at(onScreen, at(screen.owners, position))
        pieces.push(quote(owner, at(screen.positions, pieceStart), at(screen.positions, position) + 1))
        if (next !== undefined) pieceStart = next
      }
      hunks.push({ draft: quote(line, start, last + 1), on_screen: pieces.join(''), unit: at(screen.owners, first) })
    }
    removed = []; added = []
  }
  for (const change of changes) {
    if (!change.added && !change.removed) { flush(); x += change.count; y += change.count; continue }
    if (change.removed) {
      for (let offset = 0; offset < change.count; offset++) removed.push(x + offset)
      x += change.count
    } else {
      for (let offset = 0; offset < change.count; offset++) added.push(y + offset)
      y += change.count
    }
  }
  flush()
  return hunks
}

/**
 * Levenshtein distance over Unicode code points.
 * @param left - First text.
 * @param right - Second text.
 * @returns Minimum single-code-point insertions, deletions and substitutions.
 */
export function editDistance(left: string, right: string): number {
  const a = Array.from(left), b = Array.from(right)
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index)
  for (const [i, char] of a.entries()) {
    const current = [i + 1]
    for (const [j, other] of b.entries()) {
      current.push(Math.min(at(previous, j + 1) + 1, at(current, j) + 1, at(previous, j) + (char === other ? 0 : 1)))
    }
    previous = current
  }
  return at(previous, b.length)
}
