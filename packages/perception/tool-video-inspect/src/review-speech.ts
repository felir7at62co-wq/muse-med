/** Saved ASR evidence and adjacent acoustic-group candidates; no character identity or script merge is inferred. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const secondsSegment = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(),
  text: z.string(), speaker_id: z.union([z.string(), z.number()]).optional() }).loose()
const millisecondsSegment = z.object({ start_time: z.number().nonnegative(), end_time: z.number().nonnegative(),
  text: z.string(), additions: z.object({ speaker: z.union([z.string(), z.number()]).optional() }).loose().optional() }).loose()
const secondsTranscript = z.union([z.array(secondsSegment), z.object({ segments: z.array(secondsSegment) })])
const nativeTranscript = z.object({ result: z.object({ utterances: z.array(millisecondsSegment) }) })

function acousticGroup(value: string | number | undefined): { speaker_id?: string } {
  return value === undefined || !String(value).trim() ? {} : { speaker_id: String(value) }
}

interface SpeechSegment {
  segment_id: string
  start_seconds: number
  end_seconds: number
  text: string
  speaker_id?: string
  speaker_identity_unverified: true
  raw: z.infer<typeof secondsSegment> | z.infer<typeof millisecondsSegment>
}

/** Saved ASR identity for optional safe reuse in the same video source revision. */
export interface ReviewTranscriptReference {
  path: string
  version: string
  sha256: string
}

/** A stale or unavailable optional ASR source never substitutes another file or blocks visual comparison. */
export interface ReviewSpeechUnavailable {
  reference: ReviewTranscriptReference
  current_version?: string
  reason: string
  notice: string
}

/** Optional ASR read result and the source reference that can be retained after successful result validation. */
export interface ReviewSpeechLink {
  speech?: ReviewSpeech
  speech_unavailable?: ReviewSpeechUnavailable
  transcript_reference?: ReviewTranscriptReference
}

/** Complete saved ASR material; candidates preserve original text, raw rows and inter-segment gaps. */
export interface ReviewSpeech {
  source: { path: string; version: string; sha256: string; time_unit: 'seconds' | 'milliseconds' }
  association: 'caller_supplied_not_verified'
  segments: SpeechSegment[]
  continuous_speech_candidates: {
    segment_ids: string[]
    speaker_id: string
    speaker_identity_unverified: true
    text_parts: string[]
    gap_seconds: number[]
  }[]
  notice: string
}

/**
 * Parse a saved audio_transcribe result without treating ASR boundaries as screenplay paragraphs.
 * @param source - Complete UTF-8 JSON and actual saved-file revision.
 * @param duration - Verified video duration in seconds.
 * @returns Original ASR rows and adjacent same-acoustic-group candidates; no text is rewritten or merged.
 */
export function reviewSpeech(source: { path: string; version: string; text: string }, duration: number): ReviewSpeech {
  const value: unknown = JSON.parse(source.text)
  const seconds = secondsTranscript.safeParse(value)
  const native = seconds.success ? undefined : nativeTranscript.safeParse(value)
  const segments: SpeechSegment[] = seconds.success
    ? (Array.isArray(seconds.data) ? seconds.data : seconds.data.segments).map((row, index) => ({
      segment_id: `S${String(index + 1).padStart(5, '0')}`, start_seconds: row.start, end_seconds: row.end, text: row.text,
      speaker_identity_unverified: true, ...acousticGroup(row.speaker_id), raw: row,
    }))
    : native?.success ? native.data.result.utterances.map((row, index) => ({
      segment_id: `S${String(index + 1).padStart(5, '0')}`, start_seconds: row.start_time / 1000, end_seconds: row.end_time / 1000,
      text: row.text, speaker_identity_unverified: true,
      ...acousticGroup(row.additions?.speaker), raw: row,
    })) : (() => { throw Error('VIDEO_TRANSCRIPT_FORMAT: 需要audio_transcribe保存的秒制segments数组或原生result.utterances毫秒制JSON。') })()
  let previousStart = -1
  for (const segment of segments) {
    if (segment.end_seconds < segment.start_seconds || segment.end_seconds > duration || segment.start_seconds < previousStart) {
      throw Error('VIDEO_TRANSCRIPT_TIME: ASR须按原顺序排列且时间落在当前视频内；请提供本集完整转写。')
    }
    previousStart = segment.start_seconds
  }
  const candidates: ReviewSpeech['continuous_speech_candidates'] = []
  let previous: SpeechSegment | undefined, candidate: ReviewSpeech['continuous_speech_candidates'][number] | undefined
  for (const segment of segments) {
    if (previous?.speaker_id !== undefined && segment.speaker_id === previous.speaker_id) {
      if (candidate === undefined) {
        candidate = { segment_ids: [previous.segment_id], speaker_id: previous.speaker_id, speaker_identity_unverified: true,
          text_parts: [previous.text], gap_seconds: [] }
        candidates.push(candidate)
      }
      candidate.segment_ids.push(segment.segment_id)
      candidate.text_parts.push(segment.text)
      candidate.gap_seconds.push(segment.start_seconds - previous.end_seconds)
    } else {
      candidate = undefined
    }
    previous = segment
  }
  return {
    source: { path: source.path, version: source.version, sha256: createHash('sha256').update(source.text).digest('hex'),
      time_unit: seconds.success ? 'seconds' : 'milliseconds' },
    association: 'caller_supplied_not_verified', segments, continuous_speech_candidates: candidates,
    notice: '声学编号不是角色姓名；同号相邻段仅是连续发言候选，保留原句、时间与间隔。结合插话、画面事件、实际转场和声音来源决定是否合成一段；'
      + 'ASR分段不是剧本分行要求，不改变原话；同号可能混人、同人可能换号，一个原段也可能含多人，不能按编号决定合并、拆分或删重复。'
      + '文件与视频是否同源仍需核实；时间范围相符不等于同源。',
  }
}
