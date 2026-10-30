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
})
