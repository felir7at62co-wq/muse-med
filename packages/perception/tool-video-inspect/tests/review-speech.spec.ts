import { describe, expect, it } from 'vitest'
import { reviewSpeech } from '../src/review-speech.ts'

const source = (value: object) => ({ path: 'episode-asr.json', version: 'asr-v1', text: JSON.stringify(value) })

describe('saved ASR evidence for screenplay dialogue', () => {
  it('preserves every raw segment and treats adjacent same-acoustic rows only as candidates', () => {
    const rows = [
      { start: 0, end: 0.6, text: '第二，物业费、水电费账单，', speaker_id: '1', words: [{ text: '第二' }] },
      { start: 0.8, end: 1.5, text: '通通直接寄给她。', speaker_id: '1' },
      { start: 1.6, end: 2, text: '啊？', speaker_id: '2' },
      { start: 2.1, end: 3, text: '通通直接寄给她。', speaker_id: '1' },
      { start: 3.1, end: 4, text: '一个原段可能含两个人。', speaker_id: '4' },
    ]
    const result = reviewSpeech(source(rows), 4)
    expect(result.segments.map(segment => segment.raw)).toEqual(rows)
    expect(result.segments).toHaveLength(5)
    expect(result.continuous_speech_candidates).toEqual([{ segment_ids: ['S00001', 'S00002'], speaker_id: '1',
      speaker_identity_unverified: true, text_parts: [rows[0]!.text, rows[1]!.text], gap_seconds: [0.20000000000000007] }])
    expect(result.segments.every(segment => segment.speaker_identity_unverified)).toBe(true)
    expect(result.association).toBe('caller_supplied_not_verified')
    expect(result.notice).toContain('同号可能混人、同人可能换号')
    expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result).not.toHaveProperty('merged_text')
  })

  it('retains gaps and overlaps without equating acoustic continuity with a single dramatic beat', () => {
    const result = reviewSpeech(source({ segments: [
      { start: 0, end: 2, text: '等一下。', speaker_id: 1 },
      { start: 1, end: 3, text: '重叠部分。', speaker_id: 1 },
      { start: 10, end: 11, text: '很久以后。', speaker_id: 1 },
      { start: 12, end: 13, text: '未识别声组。' },
      { start: 13, end: 14, text: '仍未识别声组。' },
      { start: 14, end: 15, text: '空白声组。', speaker_id: '' },
      { start: 15, end: 16, text: '仍为空白声组。', speaker_id: '' },
    ] }), 16)
    expect(result.continuous_speech_candidates).toHaveLength(1)
    expect(result.continuous_speech_candidates[0]?.gap_seconds).toEqual([-1, 7])
    expect(result.segments).toHaveLength(7)
  })

  it('converts only the explicitly native millisecond format and retains its original data', () => {
    const raw = { start_time: 1000, end_time: 2100, text: '先坐下。', additions: { speaker: '3' } }
    const result = reviewSpeech(source({ result: { utterances: [raw] } }), 3)
    expect(result.source.time_unit).toBe('milliseconds')
    expect(result.segments[0]).toMatchObject({ start_seconds: 1, end_seconds: 2.1, speaker_id: '3', raw })
  })

  it.each([
    [{ start: 1, end: 0, text: '倒序。' }],
    [{ start: 0, end: 5, text: '超长。' }],
    [{ start: 1, end: 2, text: '后段。' }, { start: 0, end: 1, text: '前段。' }],
  ].map(rows => ({ rows })))('rejects invalid or reordered time evidence without returning partial speech ($rows)', ({ rows }) => {
    expect(() => reviewSpeech(source(rows), 3)).toThrow('VIDEO_TRANSCRIPT_TIME')
  })

  it('does not guess units or accept unstructured text as timestamped ASR', () => {
    expect(() => reviewSpeech(source([{ start_time: 1000, end_time: 2000, text: '单位不明。' }]), 3)).toThrow('VIDEO_TRANSCRIPT_FORMAT')
    expect(() => reviewSpeech({ path: 'asr.txt', version: 'v', text: '甲：你好' }, 3)).toThrow()
    expect(reviewSpeech(source([]), 3).segments).toEqual([])
  })
})
