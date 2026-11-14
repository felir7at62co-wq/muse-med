/** Read-only per-episode literal coverage of a faithful video screenplay draft against saved ASR and on-screen text. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { manuscriptLineRangeSchema, readManuscriptMaterials, type ManuscriptMaterialRange,
  type ManuscriptMaterialsLimits } from './manuscript-materials.ts'
import { alignTranscript, classifyScreenplayLine, editDistance, normalizeTranscriptText, orderMatchedUnits, substitutionHunks,
  unmarkedFragments, type ScreenplayLine, type ScreenplayLineKind, type TranscriptText } from './manuscript-transcript-match.ts'

const nonBlank = z.string().min(1).refine(value => value.trim().length > 0, '不能只有空白。')

/** Tool JSON: one item per episode, pairing a draft selection with that episode's own transcript files. */
export const transcriptSourcesSchema = z.array(z.strictObject({
  path: nonBlank,
  episode: z.number().int().positive().optional(),
  lines: manuscriptLineRangeSchema.optional(),
  asr_path: nonBlank.optional(),
  ocr_paths: z.array(nonBlank).min(1).optional(),
}).refine(source => source.episode === undefined || source.lines === undefined, 'episode 与 lines 只能选择一种范围。'))
  .min(1).superRefine((sources, ctx) => {
    const seen = new Set<string>()
    for (const source of sources) {
      const key = JSON.stringify([source.path, source.episode ?? null, source.lines?.start ?? null, source.lines?.end ?? null])
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `${source.path}的同一范围重复提供。` })
      seen.add(key)
    }
  })

/** Tool JSON: explicit character names and known wrong spellings; nothing is parsed from a project character table. */
export const transcriptCharactersSchema = z.array(z.strictObject({
  name: nonBlank,
  variants: z.array(nonBlank).min(1).optional(),
})).min(1).superRefine((characters, ctx) => {
  const names = new Set(characters.map(character => character.name.normalize('NFKC').trim()))
  if (names.size !== characters.length) ctx.addIssue({ code: 'custom', message: '人物表 name 不能重复。' })
  for (const variant of characters.flatMap(character => character.variants ?? [])) {
    if (names.has(variant.normalize('NFKC').trim())) ctx.addIssue({ code: 'custom', message: `${variant}已是人物表定名，不能同时作为错写。` })
  }
})

/** Validated per-episode source items. */
export type TranscriptSources = z.infer<typeof transcriptSourcesSchema>
/** Validated character table. */
export type TranscriptCharacters = z.infer<typeof transcriptCharactersSchema>

/** Reading budgets shared with manuscript materials, plus the transcript matching and output budgets. */
export interface TranscriptCoverageLimits extends ManuscriptMaterialsLimits {
  transcriptMinSimilarity: number
  transcriptMinGapChars: number
  transcriptMaxEditLength: number
  transcriptMaxOutputChars: number
}

const asrSchema = z.array(z.looseObject({ start: z.number().min(0), end: z.number(), text: z.string() })
  .refine(row => row.end >= row.start)).min(1)
  .refine(rows => rows.every((row, index) => (rows[index - 1]?.start ?? 0) <= row.start))

const secondsRangeSchema = z.looseObject({ start_seconds: z.number().min(0), end_seconds: z.number() })
  .refine(range => range.end_seconds >= range.start_seconds)
const ocrSchema = z.looseObject({
  schema_version: z.literal(1),
  text_source: z.literal('ocr'),
  path: z.string(),
  duration_seconds: z.number().min(0),
  scan_status: z.enum(['complete', 'partial', 'failed']),
  coverage: z.looseObject({ scanned_ranges: z.array(secondsRangeSchema) }),
  segments: z.array(z.looseObject({ start_seconds: z.number().min(0), end_seconds: z.number(), text: z.string(),
    classification: z.enum(['content_candidate', 'persistent_text_candidate']) })),
})

interface LineQuote { line: number; quote: string }
/** Located differences between one episode's draft and its sources; each is a place to check, not a verdict. */
export interface TranscriptCoverageFindings {
  asr_uncovered: { segment_id: string; start_seconds: number; end_seconds: number; text: string; action_line?: number }[]
  lines_without_source: LineQuote[]
  asr_out_of_order: { segment_id: string; start_seconds: number; text: string; line: number }[]
  on_screen_text_differs: { line: number; start_seconds: number; draft: string; on_screen: string; asr_segments: string[] }[]
  ending_after_source: { line: number; kind: ScreenplayLineKind; quote: string }[]
  lines_on_screen_text_only: LineQuote[]
  asr_partly_missing: { segment_id: string; text: string; missing: string[] }[]
  lines_with_added_text: { line: number; quote: string; added: string[] }[]
  /** Present only with a character table. */
  speakers_outside_table?: { label: string; lines: number[]; near: string[] }[]
  /** Present only with a character table. */
  listed_variants?: { name: string; variant: string; lines: number[] }[]
  on_screen_text_not_in_dialogue: { start_seconds: number; text: string }[]
}

type Category = keyof TranscriptCoverageFindings
type Select = <T>(findings: T[], category: Category) => T[]

/** Replace every finding list through `select`, visiting the lists in output priority order. */
function withFindings(episode: TranscriptCoverageEpisode, select: Select): TranscriptCoverageEpisode {
  const { speakers_outside_table: speakers, listed_variants: variants } = episode
  return { ...episode,
    asr_uncovered: select(episode.asr_uncovered, 'asr_uncovered'),
    lines_without_source: select(episode.lines_without_source, 'lines_without_source'),
    asr_out_of_order: select(episode.asr_out_of_order, 'asr_out_of_order'),
    on_screen_text_differs: select(episode.on_screen_text_differs, 'on_screen_text_differs'),
    ending_after_source: select(episode.ending_after_source, 'ending_after_source'),
    lines_on_screen_text_only: select(episode.lines_on_screen_text_only, 'lines_on_screen_text_only'),
    asr_partly_missing: select(episode.asr_partly_missing, 'asr_partly_missing'),
    lines_with_added_text: select(episode.lines_with_added_text, 'lines_with_added_text'),
    ...speakers === undefined ? {} : { speakers_outside_table: select(speakers, 'speakers_outside_table') },
    ...variants === undefined ? {} : { listed_variants: select(variants, 'listed_variants') },
    on_screen_text_not_in_dialogue: select(episode.on_screen_text_not_in_dialogue, 'on_screen_text_not_in_dialogue') }
}

function zeroCounts(): Record<Category, number> {
  return { asr_uncovered: 0, lines_without_source: 0, asr_out_of_order: 0, on_screen_text_differs: 0, ending_after_source: 0,
    lines_on_screen_text_only: 0, asr_partly_missing: 0, lines_with_added_text: 0, speakers_outside_table: 0, listed_variants: 0,
    on_screen_text_not_in_dialogue: 0 }
}

/** Complete per-episode counts; the two table counts are present only with a character table. */
export type TranscriptCoverageCounts = {
  dialogue_lines: number
  asr_segments: number
  asr_covered_in_order: number
  asr_covered_out_of_order: number
  asr_uncovered: number
  asr_in_action_lines: number
  asr_partly_missing: number
  lines_without_source: number
  lines_on_screen_text_only: number
  lines_with_added_text: number
  on_screen_text_differs: number
  on_screen_text_not_in_dialogue: number
  ending_lines_after_source: number
  speaker_lines_outside_table?: number
  listed_variant_lines?: number
}

/** One source file read for an episode. */
interface SourceIdentity { path: string; sha256: string }

/** One episode's identities, status, counts, summary sentence and the findings kept within the output budget. */
export interface TranscriptCoverageEpisode extends TranscriptCoverageFindings {
  label: string
  draft: { path: string; file_sha256: string; lines: ManuscriptMaterialRange }
  /** `segments` counts rows in the file, including rows without comparable text. */
  asr: (SourceIdentity & { segments: number }) | null
  ocr: {
    files: (SourceIdentity & { video_path: string; scan_status: 'complete' | 'partial' | 'failed' })[]
    scanned_seconds: number
    duration_seconds: number
    segments: number
  } | null
  status: 'measured' | 'not_measured'
  reason: 'edit_limit' | null
  counts: TranscriptCoverageCounts | null
  last_supported_line: number | null
  last_asr_segment_covered: boolean | null
  last_asr_end_seconds: number | null
  summary: string
}

/** Advisory literal measurement; it never assesses meaning and never blocks delivery. */
export interface TranscriptCoverageResult {
  state: 'transcript_coverage'
  advisory: true
  semantic_assessment: 'not_performed'
  matching: {
    basis: 'nfkc_letters_numbers_numerals_folded'
    min_similarity: number
    min_gap_chars: number
    homophones: 'not_detected'
    same_source: 'not_verified'
  }
  totals: Record<string, number>
  names: {
    speakers_outside_table: { label: string; near: string[]; episodes: string[]; line_count: number }[]
    listed_variants: { name: string; variant: string; episodes: string[]; line_count: number }[]
  } | null
  episodes: TranscriptCoverageEpisode[]
  output: { complete: boolean; omitted: Record<Category, number>; limit_reasons: 'output_chars_limit'[] }
  notice: string
}

interface DraftLine { number: number; text: string; line: ScreenplayLine }
interface Dialogue { number: number; quote: string; speaker: string; norm: TranscriptText }
interface Unit { start: number; end: number; text: string; norm: TranscriptText }
interface Segment extends Unit { id: string }
interface Measured {
  counts: TranscriptCoverageCounts
  findings: TranscriptCoverageFindings
  last_supported_line: number | null
  last_asr_segment_covered: boolean | null
}

async function readSourceJson(path: string, cwd: string, maxFileBytes: number,
  signal: AbortSignal): Promise<SourceIdentity & { value: unknown }> {
  signal.throwIfAborted()
  const absolute = resolve(cwd, path)
  const info = await lstat(absolute)
  if (!info.isFile() || info.size > maxFileBytes) throw Error(`MANUSCRIPT_TRANSCRIPT_SOURCE: ${path}必须是大小限制内的普通文件，不跟随符号链接。`)
  const bytes = await readFile(absolute, { signal })
  if (bytes.length > maxFileBytes) throw Error(`MANUSCRIPT_TRANSCRIPT_SOURCE: ${path}在读取期间超出大小限制。`)
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch (error) { throw Error(`MANUSCRIPT_TRANSCRIPT_SOURCE: ${path}不是有效JSON。`, { cause: error }) }
  return { path: await realpath(absolute), sha256: createHash('sha256').update(bytes).digest('hex'), value }
}

function unionSeconds(ranges: readonly { start_seconds: number; end_seconds: number }[]): number {
  let total = 0, end = -Infinity
  for (const range of [...ranges].sort((left, right) => left.start_seconds - right.start_seconds)) {
    if (range.end_seconds <= end) continue
    total += range.end_seconds - Math.max(range.start_seconds, end)
    end = range.end_seconds
  }
  return total
}

function nearNames(label: string, characters: TranscriptCharacters): string[] {
  const length = Array.from(label).length
  return characters.filter(({ name, variants }) => {
    const normalized = name.normalize('NFKC').trim()
    if (variants?.some(variant => variant.normalize('NFKC').trim() === label)) return true
    return editDistance(normalized, label) === 1
      && (Math.min(Array.from(normalized).length, length) >= 3 || normalized.includes(label) || label.includes(normalized))
  }).map(character => character.name)
}

function nameFindings(lines: readonly DraftLine[], dialogue: readonly Dialogue[], characters: TranscriptCharacters) {
  const names = characters.map(character => character.name.normalize('NFKC').trim()), labels = new Map<string, number[]>()
  for (const line of dialogue) if (!names.includes(line.speaker)) labels.set(line.speaker, [...labels.get(line.speaker) ?? [], line.number])
  const outside = [...labels].map(([label, numbers]) => ({ label, lines: numbers, near: nearNames(label, characters) }))
  const listed = characters.flatMap(({ name, variants }) => (variants ?? []).flatMap((given) => {
    const variant = given.normalize('NFKC').trim()
    // A variant inside a correct table name (志凯 in 邵志凯) is not counted where that correct name is written.
    const containing = names.filter(other => other.includes(variant))
    const numbers = lines.filter(line => line.line.kind !== 'blank'
      && containing.reduce((text, other) => text.replaceAll(other, '\u0000'), line.text.normalize('NFKC')).includes(variant))
      .map(line => line.number)
    return numbers.length ? [{ name, variant: given, lines: numbers }] : []
  }))
  return { outside, listed }
}

function measureEpisode(lines: readonly DraftLine[], asr: readonly Segment[] | undefined, ocr: readonly Unit[] | undefined,
  characters: TranscriptCharacters | undefined, limits: TranscriptCoverageLimits, signal: AbortSignal): Measured | 'edit_limit' {
  const t = limits.transcriptMinSimilarity, gap = limits.transcriptMinGapChars, edits = limits.transcriptMaxEditLength
  const dialogue: Dialogue[] = lines.flatMap(line => line.line.kind === 'dialogue' ? [{ number: line.number, quote: line.text.trim(),
    speaker: line.line.speaker, norm: normalizeTranscriptText(line.line.speech) }] : [])
  const norms = dialogue.map(line => line.norm)
  const asrAlignment = asr === undefined ? undefined : alignTranscript(asr.map(unit => unit.norm), norms, t, edits, signal)
  const ocrAlignment = ocr === undefined ? undefined : alignTranscript(ocr.map(unit => unit.norm), norms, t, edits, signal)
  if (asrAlignment === 'edit_limit' || ocrAlignment === 'edit_limit') return 'edit_limit'
  const findings: TranscriptCoverageFindings = { asr_uncovered: [], lines_without_source: [], asr_out_of_order: [],
    on_screen_text_differs: [], ending_after_source: [], lines_on_screen_text_only: [], asr_partly_missing: [],
    lines_with_added_text: [], on_screen_text_not_in_dialogue: [] }
  let inOrder = 0, inAction = 0
  if (asr !== undefined && asrAlignment !== undefined) {
    const order = orderMatchedUnits(asrAlignment)
    inOrder = order.inOrder.length
    for (const unit of order.outOfOrder) {
      const segment = asr[unit], line = dialogue[order.placement.get(unit) ?? -1]
      if (segment !== undefined && line !== undefined) {
        findings.asr_out_of_order.push({ segment_id: segment.id, start_seconds: segment.start, text: segment.text, line: line.number })
      }
    }
    const uncovered = asr.filter((_segment, index) => asrAlignment.unitMatched[index] !== true)
    const prose = lines.flatMap(line => ['action', 'other', 'hook', 'marker'].includes(line.line.kind)
      ? [{ number: line.number, norm: normalizeTranscriptText(line.text) }] : []).filter(line => line.norm.chars.length > 0)
    const proseAlignment = uncovered.length && prose.length
      ? alignTranscript(uncovered.map(unit => unit.norm), prose.map(line => line.norm), t, edits, signal) : undefined
    if (proseAlignment === 'edit_limit') return 'edit_limit'
    const placement = proseAlignment === undefined ? undefined : orderMatchedUnits(proseAlignment).placement
    for (const [index, segment] of uncovered.entries()) {
      const actionLine = prose[placement?.get(index) ?? -1]?.number
      if (actionLine !== undefined) inAction++
      findings.asr_uncovered.push({ segment_id: segment.id, start_seconds: segment.start, end_seconds: segment.end, text: segment.text,
        ...actionLine === undefined ? {} : { action_line: actionLine } })
    }
    for (const [index, segment] of asr.entries()) {
      if (asrAlignment.unitMatched[index] !== true) continue
      const missing = unmarkedFragments(segment.norm, asrAlignment.unitMarks[index] ?? [], gap)
      if (missing.length) findings.asr_partly_missing.push({ segment_id: segment.id, text: segment.text, missing })
    }
  }
  const byAsr = (index: number) => asrAlignment?.lineMatched[index] === true
  const byOcr = (index: number) => ocrAlignment?.lineMatched[index] === true
  for (const [index, line] of dialogue.entries()) {
    if (!byAsr(index) && !byOcr(index)) findings.lines_without_source.push({ line: line.number, quote: line.quote })
    else if (!byAsr(index)) findings.lines_on_screen_text_only.push({ line: line.number, quote: line.quote })
    else {
      const marks = line.norm.chars.map((_char, position) => asrAlignment?.lineMarks[index]?.[position] === true
        || ocrAlignment?.lineMarks[index]?.[position] === true)
      const added = unmarkedFragments(line.norm, marks, gap)
      if (added.length) findings.lines_with_added_text.push({ line: line.number, quote: line.quote, added })
    }
  }
  if (ocr !== undefined && ocrAlignment !== undefined) {
    for (const [index, line] of dialogue.entries()) {
      const linked = [...ocrAlignment.links[index]?.keys() ?? []].filter(unit => ocrAlignment.unitMatched[unit] === true)
        .sort((left, right) => left - right)
      if (!linked.length) continue
      const hunks = substitutionHunks(linked.flatMap(unit => ocr[unit]?.norm ?? []), line.norm, edits)
      if (hunks === 'edit_limit') return 'edit_limit'
      const asrSegments = [...asrAlignment === undefined ? [] : asrAlignment.links[index]?.keys() ?? []].sort((left, right) => left - right)
        .flatMap(unit => asr?.[unit]?.id ?? [])
      for (const hunk of hunks) {
        findings.on_screen_text_differs.push({ line: line.number, start_seconds: ocr[linked[hunk.unit] ?? -1]?.start ?? 0,
          draft: hunk.draft, on_screen: hunk.on_screen, asr_segments: asrSegments })
      }
    }
    for (const [index, segment] of ocr.entries()) {
      if (ocrAlignment.unitMatched[index] === true) continue
      findings.on_screen_text_not_in_dialogue.push({ start_seconds: segment.start, text: segment.text })
    }
  }
  const lastSupported = dialogue.findLast((_line, index) => byAsr(index) || byOcr(index))?.number ?? null
  if (lastSupported !== null) {
    const unsupported = new Set(findings.lines_without_source.map(line => line.line))
    for (const line of lines) {
      if (line.number <= lastSupported || !['action', 'hook', 'marker', 'other', 'dialogue'].includes(line.line.kind)) continue
      if (line.line.kind === 'dialogue' && !unsupported.has(line.number)) continue
      findings.ending_after_source.push({ line: line.number, kind: line.line.kind, quote: line.text.trim() })
    }
  }
  const counts: TranscriptCoverageCounts = { dialogue_lines: dialogue.length, asr_segments: asr?.length ?? 0,
    asr_covered_in_order: inOrder, asr_covered_out_of_order: findings.asr_out_of_order.length,
    asr_uncovered: findings.asr_uncovered.length, asr_in_action_lines: inAction, asr_partly_missing: findings.asr_partly_missing.length,
    lines_without_source: findings.lines_without_source.length, lines_on_screen_text_only: findings.lines_on_screen_text_only.length,
    lines_with_added_text: findings.lines_with_added_text.length, on_screen_text_differs: findings.on_screen_text_differs.length,
    on_screen_text_not_in_dialogue: findings.on_screen_text_not_in_dialogue.length,
    ending_lines_after_source: findings.ending_after_source.length }
  if (characters !== undefined) {
    const names = nameFindings(lines, dialogue, characters)
    findings.speakers_outside_table = names.outside
    findings.listed_variants = names.listed
    counts.speaker_lines_outside_table = names.outside.reduce((sum, entry) => sum + entry.lines.length, 0)
    counts.listed_variant_lines = names.listed.reduce((sum, entry) => sum + entry.lines.length, 0)
  }
  const lastAsr = asr?.length ? asr.length - 1 : undefined
  return { counts, findings, last_supported_line: lastSupported,
    last_asr_segment_covered: lastAsr === undefined ? null : asrAlignment?.unitMatched[lastAsr] === true }
}

function summary(label: string, measured: Measured | undefined, hasAsr: boolean, hasOcr: boolean): string {
  if (measured === undefined) return `${label}：未测量（超出比对上限）`
  const c = measured.counts
  return [`${label}：台词${c.dialogue_lines}行`,
    hasAsr ? `ASR ${c.asr_segments}段，按序${c.asr_covered_in_order}、错序${c.asr_covered_out_of_order}、未写入${c.asr_uncovered}`
      + `（入▲行${c.asr_in_action_lines}）、部分缺失${c.asr_partly_missing}` : 'ASR未提供',
    `无来源台词${c.lines_without_source}、仅画面文字${c.lines_on_screen_text_only}、新增措辞${c.lines_with_added_text}`,
    hasOcr ? `画面文字不同${c.on_screen_text_differs}、未入台词${c.on_screen_text_not_in_dialogue}` : '画面文字未提供',
    measured.last_supported_line === null ? '没有有来源的台词' : `最后有来源台词后${c.ending_lines_after_source}行`,
    ...c.speaker_lines_outside_table === undefined ? [] : [`表外说话人${c.speaker_lines_outside_table}行、已知错写${c.listed_variant_lines ?? 0}处`],
  ].join('；')
}

async function measureSource(source: TranscriptSources[number], index: number, characters: TranscriptCharacters | undefined,
  cwd: string, limits: TranscriptCoverageLimits, signal: AbortSignal): Promise<TranscriptCoverageEpisode> {
  const selector = source.episode !== undefined ? { episodes: [source.episode] } : source.lines !== undefined ? { lines: source.lines } : {}
  const materials = await readManuscriptMaterials([{ role: 'current', path: source.path, ...selector }], cwd, limits, signal)
  const document = materials.documents[0]
  if (document === undefined) throw Error('MANUSCRIPT_TRANSCRIPT_EPISODE: 未返回所选稿件。')
  const headings = document.episode_index.episodes
  let range: ManuscriptMaterialRange
  if (source.episode !== undefined) {
    const episode = headings.find(value => value.episode === source.episode)
    if (episode === undefined) throw Error(`MANUSCRIPT_TRANSCRIPT_EPISODE: ${source.path}没有第${source.episode}集。`)
    range = { start: episode.start, end: episode.end }
  } else if (source.lines !== undefined) range = { ...source.lines }
  else if (headings.length > 1) throw Error(`MANUSCRIPT_TRANSCRIPT_EPISODE: ${source.path}含${headings.length}集，用 episode 或 lines 指定一集。`)
  else range = { start: 1, end: document.line_count }
  const inRange = headings.filter(heading => heading.start >= range.start && heading.start <= range.end)
  const label = source.episode !== undefined ? `第${source.episode}集` : inRange.length === 1 && inRange[0] !== undefined
    ? `第${inRange[0].episode}集` : `条目${index + 1}`
  const lines: DraftLine[] = document.lines.filter(line => line.number >= range.start && line.number <= range.end)
    .map(line => ({ number: line.number, text: line.text, line: classifyScreenplayLine(line.text) }))

  let asr: TranscriptCoverageEpisode['asr'] = null, asrSegments: Segment[] | undefined, lastAsrEnd: number | null = null
  if (source.asr_path !== undefined) {
    const file = await readSourceJson(source.asr_path, cwd, limits.maxFileBytes, signal)
    const rows = asrSchema.safeParse(file.value)
    if (!rows.success) throw Error(`MANUSCRIPT_TRANSCRIPT_SOURCE: ${source.asr_path}不是audio_transcribe的output_json（秒制segments数组）。`)
    asr = { path: file.path, sha256: file.sha256, segments: rows.data.length }
    lastAsrEnd = Math.max(...rows.data.map(row => row.end))
    asrSegments = rows.data.map((row, position) => ({ id: `S${String(position + 1).padStart(5, '0')}`, start: row.start, end: row.end,
      text: row.text, norm: normalizeTranscriptText(row.text) })).filter(segment => segment.norm.chars.length > 0)
  }
  let ocr: TranscriptCoverageEpisode['ocr'] = null, ocrSegments: Unit[] | undefined
  if (source.ocr_paths !== undefined) {
    const files: NonNullable<TranscriptCoverageEpisode['ocr']>['files'] = [], ranges: { start_seconds: number; end_seconds: number }[] = []
    const content: { start: number; end: number; text: string }[] = []
    let duration = 0
    for (const path of source.ocr_paths) {
      const file = await readSourceJson(path, cwd, limits.maxFileBytes, signal)
      const evidence = ocrSchema.safeParse(file.value)
      if (!evidence.success) throw Error(`MANUSCRIPT_TRANSCRIPT_OCR: ${path}不是video_ocr的raw_json_path。`)
      files.push({ path: file.path, sha256: file.sha256, video_path: evidence.data.path, scan_status: evidence.data.scan_status })
      ranges.push(...evidence.data.coverage.scanned_ranges)
      duration = Math.max(duration, evidence.data.duration_seconds)
      for (const segment of evidence.data.segments) {
        if (segment.classification === 'content_candidate') {
          content.push({ start: segment.start_seconds, end: segment.end_seconds, text: segment.text })
        }
      }
    }
    ocrSegments = []
    for (const segment of content.sort((left, right) => left.start - right.start || left.end - right.end)) {
      const norm = normalizeTranscriptText(segment.text), previous = ocrSegments.at(-1)
      if (!norm.chars.length) continue
      if (previous !== undefined && previous.norm.chars.join('') === norm.chars.join('')) {
        previous.end = Math.max(previous.end, segment.end)
        continue
      }
      ocrSegments.push({ ...segment, norm })
    }
    ocr = { files, scanned_seconds: unionSeconds(ranges), duration_seconds: duration, segments: ocrSegments.length }
  }
  signal.throwIfAborted()
  const result = measureEpisode(lines, asrSegments, ocrSegments, characters, limits, signal)
  const measured = result === 'edit_limit' ? undefined : result
  const empty: TranscriptCoverageFindings = { asr_uncovered: [], lines_without_source: [], asr_out_of_order: [], on_screen_text_differs: [],
    ending_after_source: [], lines_on_screen_text_only: [], asr_partly_missing: [], lines_with_added_text: [],
    ...characters === undefined ? {} : { speakers_outside_table: [], listed_variants: [] }, on_screen_text_not_in_dialogue: [] }
  return { label, draft: { path: document.path, file_sha256: document.file_sha256, lines: range }, asr, ocr,
    status: measured === undefined ? 'not_measured' : 'measured', reason: measured === undefined ? 'edit_limit' : null,
    counts: measured?.counts ?? null, last_supported_line: measured?.last_supported_line ?? null,
    last_asr_segment_covered: measured?.last_asr_segment_covered ?? null, last_asr_end_seconds: lastAsrEnd,
    summary: summary(label, measured, asr !== null, ocr !== null), ...measured?.findings ?? empty }
}

function characters(value: unknown): number {
  return Array.from(JSON.stringify(value)).length
}

function aggregateNames(episodes: readonly TranscriptCoverageEpisode[]): NonNullable<TranscriptCoverageResult['names']> {
  const outside = new Map<string, { label: string; near: string[]; episodes: string[]; line_count: number }>()
  const listed = new Map<string, { name: string; variant: string; episodes: string[]; line_count: number }>()
  for (const episode of episodes) {
    for (const entry of episode.speakers_outside_table ?? []) {
      const total = outside.get(entry.label) ?? { label: entry.label, near: entry.near, episodes: [], line_count: 0 }
      total.episodes.push(episode.label); total.line_count += entry.lines.length; outside.set(entry.label, total)
    }
    for (const entry of episode.listed_variants ?? []) {
      const key = JSON.stringify([entry.name, entry.variant])
      const total = listed.get(key) ?? { name: entry.name, variant: entry.variant, episodes: [], line_count: 0 }
      total.episodes.push(episode.label); total.line_count += entry.lines.length; listed.set(key, total)
    }
  }
  return { speakers_outside_table: [...outside.values()], listed_variants: [...listed.values()] }
}

const NOTICE = '逐集字面计量：台词去掉标点空白、统一数字写法后与ASR原段按序对齐，并与video_ocr画面文字对齐；低于min_similarity记为未覆盖或无来源。'
  + '不识别同音字、改写和说话人，不核对动作、原音或文件同源；与ASR一致不等于台词正确，画面文字含招牌、手机屏幕和识别错误。'
  + '列出的是回原片核对的位置，不是结论；交付说明照录各集summary，本结果不拦截交付。'

/**
 * Measure each listed episode of a faithful video screenplay draft against that episode's own ASR and on-screen text.
 * @param sources - One item per episode with an explicit draft selection and source files; nothing is paired by file name.
 * @param table - Optional explicit character names and known wrong spellings.
 * @param cwd - Session workspace for relative paths.
 * @param limits - Validated reading, matching and output budgets.
 * @param signal - Cancellation, checked between files and episodes.
 * @returns Complete counts and summaries, with whole findings kept within `transcriptMaxOutputChars` and omissions counted.
 */
export async function measureTranscriptCoverage(sources: TranscriptSources, table: TranscriptCharacters | undefined, cwd: string,
  limits: TranscriptCoverageLimits, signal: AbortSignal): Promise<TranscriptCoverageResult> {
  if (sources.length > limits.maxDocuments || sources.some(source => (source.ocr_paths?.length ?? 0) > limits.maxDocuments)) {
    throw Error('MANUSCRIPT_DOCUMENT_LIMIT: 本次集数过多，请分批。')
  }
  const all: TranscriptCoverageEpisode[] = []
  for (const [index, source] of sources.entries()) {
    signal.throwIfAborted()
    all.push(await measureSource(source, index, table, cwd, limits, signal))
  }
  const totals: Record<string, number> = { episodes: all.length, measured: all.filter(episode => episode.counts !== null).length,
    not_measured: all.filter(episode => episode.counts === null).length, without_asr: all.filter(episode => episode.asr === null).length,
    with_ocr: all.filter(episode => episode.ocr !== null).length }
  for (const episode of all) {
    const counts: Record<string, number> = episode.counts ?? {}
    for (const [key, value] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + value
  }
  const result: TranscriptCoverageResult = { state: 'transcript_coverage', advisory: true, semantic_assessment: 'not_performed',
    matching: { basis: 'nfkc_letters_numbers_numerals_folded', min_similarity: limits.transcriptMinSimilarity,
      min_gap_chars: limits.transcriptMinGapChars, homophones: 'not_detected', same_source: 'not_verified' },
    totals, names: table === undefined ? null : aggregateNames(all), episodes: all,
    output: { complete: true, omitted: zeroCounts(), limit_reasons: [] }, notice: NOTICE }
  const budget = limits.transcriptMaxOutputChars
  if (characters(result) <= budget) return result
  // The fixed part is sized with every finding counted as omitted, so the final JSON cannot exceed the budget.
  const available = zeroCounts()
  const fixed = all.map(episode => withFindings(episode, (findings, category) => { available[category] += findings.length; return [] }))
  let used = characters({ ...result, episodes: fixed, output: { complete: false, omitted: available, limit_reasons: ['output_chars_limit'] } })
  if (used > budget) {
    throw Error(`MANUSCRIPT_TRANSCRIPT_OUTPUT: ${all.length}集的计数部分共${used}字符，超出${budget}字符输出上限；`
      + `请每次不超过${Math.max(1, Math.floor(all.length * budget / used))}集。`)
  }
  const omitted = zeroCounts()
  const episodes = all.map(episode => withFindings(episode, <T>(findings: T[], category: Category) => {
    const kept: T[] = []
    for (const finding of findings) {
      signal.throwIfAborted()
      const cost = characters(finding) + (kept.length ? 1 : 0)
      if (used + cost <= budget) { kept.push(finding); used += cost }
      else omitted[category]++
    }
    return kept
  }))
  return { ...result, episodes, output: { complete: false, omitted, limit_reasons: ['output_chars_limit'] } }
}
