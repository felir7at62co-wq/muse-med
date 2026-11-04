import { describe, expect, it } from 'vitest'
import { fitSubtitleCues } from '../src/subtitle-fit.ts'
import type { SpeechCoverageReport, SpeechCoverageWord } from '../src/speech-coverage.ts'
import type { SubtitleCue } from '../src/types.ts'

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
  it('does not invent boundaries when words overlap, are missing, or a width probe fails', async () => {
    const input = evidence()
    const overlapping = { ...input, words: input.words.map((word, i) => i === 1 ? { ...word, start_seconds: 0.4 } : word) }
    const incomplete = { ...input, matches: input.matches.slice(0, -1) }
    for (const [coverage, probe] of [[overlapping, fits], [incomplete, fits], [input, async () => null]] as const) {
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

  it('preserves intentional spaces at real word boundaries', async () => {
    const spaced = { ...cue, text: '今天 我们 一起 去 做饭' }
    const result = await fitSubtitleCues([spaced], evidence(), fits)
    expect(result.cues.map(item => item.text)).toEqual(['今天', '我们', '一起 去', '做饭'])
    expect(result.warnings).toEqual([])
  })

  it('keeps the original cue when a candidate width cannot be measured', async () => {
    const result = await fitSubtitleCues([cue], evidence(), async text => text === cue.text ? false : null)
    expect(result.cues).toEqual([cue])
    expect(result.warnings).toContain('第 1 条字幕无法依据完整词界测量切分；保留原文字和时码供核对。')
  })
})
