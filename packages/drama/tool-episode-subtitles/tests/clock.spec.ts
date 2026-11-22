/** Shot-local cues map through the played window; the shared Jingliu span vectors pin the mapping. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { placeShotCues, sourceSpan } from '../src/clock.ts'

interface SpanVector {
  name: string
  shot: { clip_in_sec: number | null; clip_dur_sec: number | null; duration_sec: number | null; speed: number | null }
  start: number
  end: number
  expect: [number, number] | null
}
const fixture = new URL('../../skills/tests/fixtures/subtitle_rules_vectors.json', import.meta.url)
const vectors = JSON.parse(readFileSync(fixture, 'utf8')) as { spans: SpanVector[] }

it.each(vectors.spans)('maps $name like Jingliu', ({ shot, start, end, expect: expected }) => {
  const span = sourceSpan({ clipInUs: (shot.clip_in_sec ?? 0) * 1e6, durationUs: (shot.clip_dur_sec ?? shot.duration_sec ?? 5) * 1e6,
    speed: shot.speed ?? 1 }, start, end)
  if (expected === null) expect(span).toBeUndefined()
  else {
    expect(span?.[0]).toBeCloseTo(expected[0], 9)
    expect(span?.[1]).toBeCloseTo(expected[1], 9)
  }
})

it('clips a cue past the trim, drops one after it, and rounds to milliseconds', () => {
  const window = { clipInUs: 0, durationUs: 2_000_000, speed: 1 }
  expect(placeShotCues([{ start: 0.1234, end: 1.5, text: '一' }, { start: 1.6, end: 2.4, text: '二' }, { start: 2.1, end: 2.5, text: '三' }],
    window, 10)).toEqual({
    placed: [{ startSeconds: 10.123, endSeconds: 11.5, text: '一', cue: 0 }, { startSeconds: 11.6, endSeconds: 12, text: '二', cue: 1 }],
    cut: [{ cue: 1, text: '二', start: 1.6, end: 2.4, dropped: false }, { cue: 2, text: '三', start: 2.1, end: 2.5, dropped: true }],
  })
})
