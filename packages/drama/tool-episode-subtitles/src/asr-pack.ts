/**
 * Pure planning and splitting of packed speech tracks.
 *
 * Shots that miss the transcript cache are packed greedily, in request order, into tracks of at most
 * `packSeconds`, each shot followed by `gapSamples` of digital silence. Recognized words go back to the shot whose
 * sample range contains the word's midpoint; a word in a gap or across a boundary gets a `boundary` flag. Segments
 * without word times keep their segment timing as one word. Nothing is split by estimate.
 */
import { createHash } from 'node:crypto'
import type { MuseAsrSegment } from '@deepseek-ai/dsh-muse-account'
import type { TimedWord, TranscriptFlag } from './types.ts'

/** One shot inside a pack, measured in samples at the staging rate. */
export interface PackMember {
  readonly audio_sha256: string
  readonly samples: number
  readonly offset_samples: number
}

/** A planned pack of shots. */
export interface PackPlan {
  /** Content identity: digest of the members, the gap and the rate. */
  readonly sha256: string
  readonly gap_samples: number
  readonly rate: number
  readonly members: readonly PackMember[]
  /** Total samples including the silence after every member. */
  readonly samples: number
}

/**
 * Identify a pack by its content.
 * @param members - Audio digests and sample counts, in pack order.
 * @param gapSamples - Silence after each member.
 * @param rate - Sample rate.
 * @returns Lowercase SHA-256.
 */
export function packSha256(members: readonly { readonly audio_sha256: string; readonly samples: number }[],
  gapSamples: number, rate: number): string {
  return createHash('sha256').update(JSON.stringify([members.map(member => [member.audio_sha256, member.samples]),
    gapSamples, rate])).digest('hex')
}

/**
 * Plan packs greedily in the given order.
 * @param shots - Distinct audio digests with their sample counts, in episode and shot order.
 * @param maxSamples - Largest pack, silence included; a longer single shot gets its own pack.
 * @param gapSamples - Silence after each member.
 * @param rate - Sample rate.
 * @returns Packs in order.
 */
export function planPacks(shots: readonly { readonly audio_sha256: string; readonly samples: number }[],
  maxSamples: number, gapSamples: number, rate: number): PackPlan[] {
  const groups: { audio_sha256: string; samples: number }[][] = []
  let current: { audio_sha256: string; samples: number }[] = [], used = 0
  for (const shot of shots) {
    const size = shot.samples + gapSamples
    if (current.length > 0 && used + size > maxSamples) { groups.push(current); current = []; used = 0 }
    current.push({ audio_sha256: shot.audio_sha256, samples: shot.samples })
    used += size
  }
  if (current.length > 0) groups.push(current)
  return groups.map((group) => {
    let offset = 0
    const members = group.map((member) => {
      const placed = { ...member, offset_samples: offset }
      offset += member.samples + gapSamples
      return placed
    })
    return { sha256: packSha256(group, gapSamples, rate), gap_samples: gapSamples, rate, members, samples: offset }
  })
}

const CONTENT = /[\p{L}\p{N}]/u

/**
 * Attach the punctuation and spaces of a segment's text to the words that precede them.
 * @param text - Segment text as recognized.
 * @param words - The segment's words, in order.
 * @returns One text per word, with following punctuation when the words match the segment text.
 */
export function attachPunctuation(text: string, words: readonly { readonly text: string }[]): string[] {
  return wordsWithPunctuation(text, words).map(word => word.text)
}

function wordsWithPunctuation<T extends { readonly text: string }>(text: string, words: readonly T[]): { word: T; text: string }[] {
  const original = () => words.map(word => ({ word, text: word.text }))
  const out = original()
  let cursor = 0
  for (const [index, entry] of out.entries()) {
    const token = entry.text.trim()
    if (!token) continue
    const at = text.indexOf(token, cursor)
    if (at < 0) return original()
    const between = text.slice(cursor, at)
    if (CONTENT.test(between)) return original()
    const previous = out[index - 1]
    if (previous !== undefined) previous.text += between
    entry.text = token
    cursor = at + token.length
  }
  const rest = text.slice(cursor)
  if (CONTENT.test(rest)) return original()
  const last = out.at(-1)
  if (last !== undefined) last.text += rest
  return out
}

/** Words and flags that one pack's recognition assigns to one member. */
export interface MemberWords {
  readonly words: TimedWord[]
  readonly flags: TranscriptFlag[]
}

/**
 * Split a pack's recognized segments back to its members in member-local seconds.
 * @param segments - Recognition of the whole pack, in pack seconds.
 * @param pack - The pack the recognition belongs to.
 * @returns Words and boundary flags per member audio digest.
 */
export function splitPack(segments: readonly MuseAsrSegment[], pack: Pick<PackPlan, 'members' | 'rate'>): Map<string, MemberWords> {
  const out = new Map<string, MemberWords>()
  const spans = pack.members.map((member) => {
    const target: MemberWords = out.get(member.audio_sha256) ?? { words: [], flags: [] }
    out.set(member.audio_sha256, target)
    return { target, start: member.offset_samples / pack.rate, end: (member.offset_samples + member.samples) / pack.rate }
  })
  const [firstSpan] = spans
  if (firstSpan === undefined) return out
  const owner = (mid: number) => {
    const inside = spans.find(span => mid >= span.start && mid < span.end)
    if (inside !== undefined) return { span: inside, inGap: false }
    const nearest = spans.reduce((best, span) => {
      const distance = mid < span.start ? span.start - mid : mid - span.end
      return distance < best.distance ? { span, distance } : best
    }, { span: firstSpan, distance: Number.POSITIVE_INFINITY })
    return { span: nearest.span, inGap: true }
  }
  for (const [seg, segment] of segments.entries()) {
    const timed = segment.words !== undefined && segment.words.length > 0
      ? wordsWithPunctuation(segment.text, segment.words).map(({ word, text }) => ({ start: word.start, end: word.end, text }))
      : [{ start: segment.start, end: segment.end, text: segment.text }]
    for (const word of timed) {
      if (!word.text.trim()) continue
      const { span, inGap } = owner((word.start + word.end) / 2)
      const length = span.end - span.start
      const start = Math.min(Math.max(word.start - span.start, 0), length)
      const end = Math.min(Math.max(word.end - span.start, start), length)
      span.target.words.push({ start: round(start), end: round(end), text: word.text, seg,
        ...(segment.speaker_id === undefined ? {} : { speaker_id: segment.speaker_id }) })
      if (inGap || word.start < span.start || word.end > span.end) {
        span.target.flags.push({ kind: 'boundary', start: round(start), end: round(end) })
      }
    }
  }
  return out
}

function round(seconds: number): number {
  return Math.round(seconds * 1_000_000) / 1_000_000
}
