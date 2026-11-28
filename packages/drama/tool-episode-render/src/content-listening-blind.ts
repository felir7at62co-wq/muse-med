/** Compare a bounded blind transcription with the original dialogue after recognition. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const maxDurationUs = 120_000_000
const maxEntries = 128
const maxLineBytes = 1024
const maxCharacters = 2048
const maxReportBytes = 64 * 1024

const dialogueKey = (text: string): string => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')
const span = z.strictObject({ start_us: z.int().nonnegative(), end_us: z.int().positive() })
const observationSchema = z.strictObject({
  ranges: z.array(span.extend({ status: z.enum(['reviewed', 'uncertain']) })).max(maxEntries),
  utterances: z.array(span.extend({
    text: z.string().max(maxLineBytes).trim().refine(text => Buffer.byteLength(text, 'utf8') <= maxLineBytes
      && dialogueKey(text) !== ''),
  })).max(maxEntries),
})

/** The recognizer's reported intervals and verbatim observations. */
export type BlindDialogueObservation = Readonly<z.infer<typeof observationSchema>>
type TimedSpan = z.infer<typeof span>
type CoverageFinding = TimedSpan & { readonly kind: 'unreviewed' | 'uncertain' }
type EditKind = 'omitted' | 'replaced' | 'inserted'
type EditFinding = Partial<TimedSpan> & {
  readonly kind: EditKind
  readonly authored_offset: number
  readonly observed_offset: number
  authored_count: number
  observed_count: number
}

/** Advisory character differences and coverage gaps for later listening. */
export interface BlindDialogueReview {
  readonly observation: BlindDialogueObservation
  readonly status: 'issues_found' | 'needs_review'
  readonly findings: readonly (CoverageFinding | EditFinding)[]
  readonly listening_verified: false
  readonly grants_approval: false
}

function invalid(message: string): never {
  throw new HarnessError(message, 'CONTENT_LISTENING_BLIND_INVALID')
}

function validateOrder(spans: readonly TimedSpan[], durationUs: number): void {
  let cursor = 0
  for (const item of spans) {
    if (item.start_us < cursor || item.end_us <= item.start_us || item.end_us > durationUs) {
      invalid('盲听区间和实听对白须按时间顺序排列，不得重叠或超出成片。')
    }
    cursor = item.end_us
  }
}

function coverageGaps(durationUs: number, ranges: BlindDialogueObservation['ranges']): CoverageFinding[] {
  const gaps: CoverageFinding[] = []
  let cursor = 0
  for (const { start_us, end_us, status } of ranges) {
    if (start_us > cursor) gaps.push({ kind: 'unreviewed', start_us: cursor, end_us: start_us })
    if (status === 'uncertain') gaps.push({ kind: status, start_us, end_us })
    cursor = end_us
  }
  if (cursor < durationUs) gaps.push({ kind: 'unreviewed', start_us: cursor, end_us: durationUs })
  return gaps
}

/**
 * Validate the model response without consulting the expected dialogue.
 * @param durationUs - The duration measured from the submitted audio.
 * @param raw - The recognizer result after a request containing audio and blind instructions only.
 * @returns Ordered coverage claims and timed utterances. Empty coverage is retained as unknown.
 */
export function parseBlindDialogueObservation(durationUs: number, raw: unknown): BlindDialogueObservation {
  if (!Number.isSafeInteger(durationUs) || durationUs < 1 || durationUs > maxDurationUs) {
    invalid('盲听需要有效且不超过线路上限的实测音频时长。')
  }
  const parsed = observationSchema.safeParse(raw)
  if (!parsed.success) invalid('盲听结果须提供有效的区间和实际听到的对白。')
  const { ranges, utterances } = parsed.data
  validateOrder(ranges, durationUs)
  validateOrder(utterances, durationUs)
  const gaps = coverageGaps(durationUs, ranges)
  if (utterances.some(item => gaps.some(gap => gap.start_us < item.end_us && gap.end_us > item.start_us))) {
    invalid('实听对白须落在已核听的区间内；无法辨认的片段请独立标记。')
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > maxReportBytes) invalid('盲听结果超过大小上限。')
  return parsed.data
}

function characters(lines: readonly string[]): string[] {
  if (lines.length > maxEntries) invalid('待核对白超过单次盲听比较上限。')
  const result: string[] = []
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) invalid('待核对白超过单行大小上限。')
    const normalized = dialogueKey(line)
    if (normalized === '') invalid('待核对白须有可比较的正文；静默区间不填空行。')
    result.push(...Array.from(normalized))
    if (result.length > maxCharacters) invalid('待核对白超过单次盲听比较上限。')
  }
  return result
}

/**
 * Check the local dialogue limits before requesting a blind transcription.
 * @param orderedAuthoredLines - Approved dialogue in playback order. An empty array declares no speech.
 */
export function validateBlindAuthoredDialogue(orderedAuthoredLines: readonly string[]): void {
  characters(orderedAuthoredLines)
}

function compareCharacters(expected: readonly string[], actual: readonly string[], times: readonly TimedSpan[]): EditFinding[] {
  const width = actual.length + 1
  const costs = new Uint16Array((expected.length + 1) * width)
  for (let i = expected.length; i >= 0; i -= 1) {
    for (let j = actual.length; j >= 0; j -= 1) {
      const index = i * width + j
      if (i === expected.length || j === actual.length) {
        costs[index] = (expected.length - i) + (actual.length - j)
      } else {
        const diagonal = (costs[index + width + 1] as number) + Number(expected[i] !== actual[j])
        costs[index] = Math.min(diagonal, 1 + (costs[index + width] as number), 1 + (costs[index + 1] as number))
      }
    }
  }

  const edits: EditFinding[] = []
  for (let i = 0, j = 0; i < expected.length || j < actual.length;) {
    if (i < expected.length && j < actual.length && expected[i] === actual[j]) {
      i += 1
      j += 1
      continue
    }
    const index = i * width + j
    const replace = i < expected.length && j < actual.length && costs[index] === (costs[index + width + 1] as number) + 1
    const omit = !replace && i < expected.length && costs[index] === (costs[index + width] as number) + 1
    const kind = replace ? 'replaced' : omit ? 'omitted' : 'inserted'
    const authoredCount = Number(replace || omit)
    const observedCount = Number(!omit)
    const time = omit ? undefined : times[j]
    const prev = edits.at(-1)
    if (prev?.kind === kind && prev.authored_offset + prev.authored_count === i
      && prev.observed_offset + prev.observed_count === j
      && prev.start_us === time?.start_us && prev.end_us === time?.end_us) {
      prev.authored_count += authoredCount
      prev.observed_count += observedCount
    } else {
      edits.push({ kind, authored_offset: i, observed_offset: j, authored_count: authoredCount,
        observed_count: observedCount, ...(time === undefined ? {} : { start_us: time.start_us, end_us: time.end_us }) })
    }
    i += authoredCount
    j += observedCount
  }
  return edits
}

/**
 * Compare what was transcribed with the authored lines after the blind request completes.
 * @param durationUs - Duration of the submitted audio in microseconds.
 * @param raw - The structured result from blind recognition.
 * @param orderedAuthoredLines - The approved dialogue in original playback order.
 * @returns Advisory coverage or character findings. Edit offsets count normalized Unicode characters;
 * timing on an edit is the containing observed utterance, and absent where audio never located the text.
 */
export function reconcileBlindDialogue(durationUs: number, raw: unknown, orderedAuthoredLines: readonly string[]): BlindDialogueReview {
  const observation = parseBlindDialogueObservation(durationUs, raw)
  const expected = characters(orderedAuthoredLines)
  const actual = characters(observation.utterances.map(utterance => utterance.text))
  const gaps = coverageGaps(durationUs, observation.ranges)
  // Without an authored clock, omissions and substitutions cannot be distinguished from incomplete capture.
  const timings = observation.utterances.flatMap(utterance => Array.from(dialogueKey(utterance.text), () => utterance))
  const edits = gaps.length === 0 && expected.join('') !== actual.join('') ? compareCharacters(expected, actual, timings) : []
  const review: BlindDialogueReview = { observation, findings: [...gaps, ...edits],
    status: edits.length > 0 ? 'issues_found' : 'needs_review', listening_verified: false, grants_approval: false }
  if (Buffer.byteLength(JSON.stringify(review), 'utf8') > maxReportBytes) invalid('盲听对照报告超过大小上限。')
  return review
}
