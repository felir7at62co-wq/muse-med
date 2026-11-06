import { describe, expect, it } from 'vitest'
import { fitSubtitleCues } from '../src/subtitle-fit.ts'
import type { SpeechCoverageReport, SpeechCoverageWord } from '../src/speech-coverage.ts'
import type { SubtitleCue } from '../src/types.ts'
import { ep26Cue, ep26Evidence } from './subtitle-fit-ep26-fixture.ts'

const cue: SubtitleCue = { index: 1, startSeconds: 0, endSeconds: 4, text: '今天我们一起去做饭' }
function evidence(): SpeechCoverageReport {
  const words = ['今天', '我们', '一起', '去', '做饭'].map((text, i): SpeechCoverageWord => ({
    id: `w${String(i)}`, shot: 1, clip_index: 0, word_index: i, text,
    source_start_seconds: i * 0.7, source_end_seconds: i * 0.7 + 0.5,
    start_seconds: i * 0.7, end_seconds: i * 0.7 + 0.5,
  }))
  return { schema_version: 1, assessment: 'asr_candidate_comparison', listening_verified: false,
    subtitle_path: '', subtitle_sha256: '', evidence_sha256: '', evidence_complete: true, sources: [], words,
    matches: words.map(word => ({ word_id: word.id, cue_index: 1, text: word.text, precision: 'word' })),
    findings: [], warnings: [] }
}
const fits = async (text: string): Promise<boolean> => Array.from(text).length <= 4

describe('source-bound subtitle width fitting', () => {
  it('splits only on whole recognition words, at the next actual start time', async () => {
    const result = await fitSubtitleCues([cue], evidence(), fits)
    expect(result.warnings).toEqual([])
    expect(result.cues.map(item => [item.text, item.startSeconds, item.endSeconds])).toEqual([
      ['今天我们', 0, 1.4], ['一起去', 1.4, 2.8], ['做饭', 2.8, 4],
    ])
    expect(result.cues.map(item => item.text).join('')).toBe(cue.text)
    expect(cue.text).toBe('今天我们一起去做饭')
  })
  it('leaves an already fitting cue unchanged', async () => {
    expect((await fitSubtitleCues([cue], evidence(), async () => true)).cues).toEqual([cue])
  })

  it('splits the archived EP26 cue with a millisecond SRT end without moving its measured word boundaries', async () => {
    const coverage = ep26Evidence(), before = structuredClone(coverage)
    const result = await fitSubtitleCues([ep26Cue], coverage, async text => Array.from(text).length <= 9)
    expect(result.warnings).toEqual([])
    expect(result.cues.map(item => [item.text, item.startSeconds, item.endSeconds])).toEqual([
      ['可我现在每天按时起', 64.408, 65.728333], ['每天都干活', 65.728333, 66.368],
    ])
    expect(result.cues.map(item => item.text).join('')).toBe(ep26Cue.text)
    expect(coverage).toEqual(before)
    expect(coverage.words.at(-1)?.end_seconds).toBe(66.368333)
  })

  it.each(['start', 'end', 'both'] as const)('accepts only the SRT rounding at the %s outer boundary', async (edge) => {
    const shifted = { ...cue, startSeconds: 60, endSeconds: 63.3 }
    const coverage = evidence()
    const words = coverage.words.map((word, index) => ({ ...word,
      start_seconds: index === 0 && edge !== 'end' ? 59.999667 : 60 + word.start_seconds,
      end_seconds: index === coverage.words.length - 1 && edge !== 'start' ? 63.300333 : 60 + word.end_seconds,
    }))
    const result = await fitSubtitleCues([shifted], { ...coverage, words }, fits)
    expect(result.warnings).toEqual([])
    expect(result.cues.map(item => [item.startSeconds, item.endSeconds])).toEqual([
      [60, 61.4], [61.4, 62.8], [62.8, 63.3],
    ])
  })

  it.each([
    ['start beyond half a millisecond', 59.999499, 63.3],
    ['end beyond half a millisecond', 60, 63.300501],
    ['start one millisecond early', 59.999, 63.3],
    ['end one millisecond late', 60, 63.301],
    ['end one frame late', 60, 63.3 + 1 / 24],
  ] as const)('preserves the cue with %s', async (_name, start, end) => {
    const shifted = { ...cue, startSeconds: 60, endSeconds: 63.3 }
    const coverage = evidence()
    const words = coverage.words.map((word, index) => ({ ...word,
      start_seconds: index === 0 ? start : 60 + word.start_seconds,
      end_seconds: index === coverage.words.length - 1 ? end : 60 + word.end_seconds,
    }))
    const result = await fitSubtitleCues([shifted], { ...coverage, words }, fits)
    expect(result.cues).toEqual([shifted])
    expect(result.warnings).toHaveLength(1)
  })

  it('does not extend rounding tolerance to precise non-SRT cue times or overlapping words', async () => {
    const coverage = ep26Evidence()
    for (const [candidate, words] of [
      [{ ...ep26Cue, endSeconds: 66.3681 }, coverage.words],
      [ep26Cue, coverage.words.map((word, index) => index === 1
        ? { ...word, start_seconds: coverage.words[0]!.end_seconds - 0.000333 } : word)],
    ] as const) {
      const result = await fitSubtitleCues([candidate], { ...coverage, words }, fits)
      expect(result.cues).toEqual([{ ...candidate, index: 1 }])
      expect(result.warnings).toHaveLength(1)
    }
    const incomplete = { ...coverage, matches: coverage.matches.slice(0, -1) }
    expect((await fitSubtitleCues([ep26Cue], incomplete, fits)).warnings).toHaveLength(1)
  })

  it.each([
    ['nonpositive measured duration', 64.4079, 1.199567],
    ['zero duration after SRT serialization', 64.4081, 1.199767],
  ] as const)('preserves the original cue instead of producing %s', async (_name, next, sourceStart) => {
    const coverage = ep26Evidence()
    const words = coverage.words.map((word, index) => index === 0
      ? { ...word, start_seconds: 64.4077, end_seconds: 64.4078,
        source_start_seconds: 1.199367, source_end_seconds: 1.199467 }
      : index === 1 ? { ...word, start_seconds: next, source_start_seconds: sourceStart } : word)
    const result = await fitSubtitleCues([ep26Cue], { ...coverage, words }, async text => text.length <= 1)
    expect(result.cues).toEqual([{ ...ep26Cue, index: 1 }])
    expect(result.warnings).toHaveLength(1)
  })

  it.each([false, true])('preserves intentional spaces with the probe ignoring spaces=%s', async (ignoreSpaces) => {
    const spaced = { ...cue, text: '今天 我们 一起 去 做饭' }
    const result = await fitSubtitleCues([spaced], evidence(), async text => fits(ignoreSpaces ? text.replaceAll(' ', '') : text))
    expect(result.warnings).toEqual([])
    expect(result.cues.map(item => item.text)).toEqual(ignoreSpaces
      ? ['今天 我们', '一起 去', '做饭'] : ['今天', '我们', '一起 去', '做饭'])
  })

  it('does not invent boundaries when words overlap, are missing, or a width probe fails', async () => {
    const input = evidence()
    const overlapping = { ...input, words: input.words.map((word, i) => i === 1 ? { ...word, start_seconds: 0.4 } : word) }
    const incomplete = { ...input, matches: input.matches.slice(0, -1) }
    const unmatched = { ...input, words: input.words.slice(1) }
    for (const [coverage, probe] of [
      [overlapping, fits], [incomplete, fits], [unmatched, fits], [input, async () => null],
    ] as const) {
      const result = await fitSubtitleCues([cue], coverage, probe)
      expect(result.cues).toEqual([cue])
      expect(result.warnings).toHaveLength(1)
    }
  })
  it('does not split a word even if it alone exceeds the available width', async () => {
    const result = await fitSubtitleCues([cue], evidence(), async text => Array.from(text).length <= 1)
    expect(result.cues).toEqual([cue])
    expect(result.warnings).toHaveLength(1)
  })

  it.each([
    ['punctuation', { ...cue, text: '今天，我们一起去做饭' }],
    ['compatibility whitespace', { ...cue, text: '今天　我们一起去做饭' }],
    ['compatibility Han character', { ...cue, text: '\uF900天我们一起去做饭' }],
  ])('keeps %s when the cue is not plain normalized Han text', async (_name, candidate) => {
    const result = await fitSubtitleCues([candidate], evidence(), fits)
    expect(result.cues).toEqual([candidate])
    expect(result.warnings).toHaveLength(1)
  })

  it.each([
    ['unrecognized word id', (report: SpeechCoverageReport) => ({ ...report,
      matches: [{ ...report.matches[0]!, word_id: 'missing' }, ...report.matches.slice(1)] })],
    ['duplicate word id', (report: SpeechCoverageReport) => ({ ...report,
      matches: [report.matches[0]!, report.matches[0]!, ...report.matches.slice(1)] })],
    ['word shared with another cue', (report: SpeechCoverageReport) => ({ ...report,
      matches: [...report.matches, { ...report.matches[0]!, cue_index: 2 }] })],
    ['mismatched match text', (report: SpeechCoverageReport) => ({ ...report,
      matches: [{ ...report.matches[0]!, text: '别的' }, ...report.matches.slice(1)] })],
    ['non-Han word', (report: SpeechCoverageReport) => ({ ...report,
      words: [{ ...report.words[0]!, text: 'today' }, ...report.words.slice(1)],
      matches: [{ ...report.matches[0]!, text: 'today' }, ...report.matches.slice(1)] })],
    ['only one matched word', (report: SpeechCoverageReport) => ({ ...report, matches: report.matches.slice(0, 1) })],
    ['zero-duration word', (report: SpeechCoverageReport) => ({ ...report,
      words: [{ ...report.words[0]!, end_seconds: report.words[0]!.start_seconds }, ...report.words.slice(1)] })],
    ['word outside cue time', (report: SpeechCoverageReport) => ({ ...report,
      words: [...report.words.slice(0, -1), { ...report.words.at(-1)!, end_seconds: 4.5 }] })],
  ] as const)('keeps the cue when evidence has %s', async (_name, change) => {
    const result = await fitSubtitleCues([cue], change(evidence()), fits)
    expect(result.cues).toEqual([cue])
    expect(result.warnings).toHaveLength(1)
  })

  it('keeps the original cue when a candidate width cannot be measured', async () => {
    const result = await fitSubtitleCues([cue], evidence(), async text => text === cue.text ? false : null)
    expect(result.cues).toEqual([cue])
    expect(result.warnings).toContain('第 1 条字幕无法依据完整词界测量切分；保留原文字和时码供核对。')
  })
})
