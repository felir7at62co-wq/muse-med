// @vitest-environment jsdom
/** Only verified recordings of the same shot share comparison and adoption. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import { afterEach, expect, it, vi } from 'vitest'
import { adoptVideoEdition, getAdoptedVideoEdition, videoEditions } from '../src/client/video-editions.ts'
import { sessionId, source } from './selection-fixture.client.ts'

const original = {
  ...source('original'),
  eventSeq: 10,
  production: { scriptId: 12, episodeId: 301, episodeNumber: 3, packageIndex: 1, storyboardId: 20,
    shotRanges: [{ shotNumber: 7, startSeconds: 1, endSeconds: 3 }] },
} satisfies SessionVideoSource
const revised = {
  ...source('revised'),
  version: 'current-bytes',
  eventSeq: 20,
  production: { ...original.production, shotRanges: [{ shotNumber: 7, startSeconds: 4, endSeconds: 5.5 }] },
} satisfies SessionVideoSource

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

it('orders the two playable recordings and returns the interval observed in each', () => {
  const sources = [revised, original, { ...source('other-package'), production: { ...original.production, packageIndex: 2 } }]
  const editions = videoEditions(sources, original, 7)
  expect(editions?.items).toEqual([
    { source: original, shotId: 'authored:original:v1:7:1:3', number: 1, startSeconds: 1, endSeconds: 3 },
    { source: revised, shotId: 'authored:revised:current-bytes:7:4:5.5', number: 2, startSeconds: 4, endSeconds: 5.5 },
  ])
  expect(editions?.current).toBe(editions?.items[0])
  expect(videoEditions(sources, revised, 7)?.key).toBe(videoEditions(sources, original, 7)?.key)
  expect(videoEditions(sources, original, undefined)).toBeNull()
  expect(videoEditions(sources, { ...original, version: 'old-bytes' }, 7)).toBeNull()
})

it('uses presentation order to distinguish recordings delivered in one event', () => {
  const first = { ...original, presentedIndex: 0 }
  const second = { ...revised, eventSeq: first.eventSeq, presentedIndex: 1 }
  const third = { ...second, ...source('same-position'), version: second.version, eventSeq: first.eventSeq, presentedIndex: 1 }
  expect(videoEditions([third, second, first], second, 7)?.items.map(item => item.source.id))
    .toEqual(['original', 'revised', 'same-position'])
})

it('requires a playable, versioned recording with a matching observed shot', () => {
  for (const candidate of [source('same-filename-only'), { ...revised, version: null }, { ...revised, playbackUrl: null },
    { ...revised, production: { ...revised.production, episodeId: 302 } },
    { ...revised, production: { ...revised.production, storyboardId: 21 } },
    { ...revised, production: { ...revised.production, shotRanges: [] } }]) {
    expect(videoEditions([original, candidate], original, 7)).toBeNull()
  }
  const ambiguous = { ...original, production: { ...original.production, episodeId: undefined } }
  const conflicting = { ...source('other-episode'), production: { ...original.production, episodeId: 302 } }
  expect(videoEditions([ambiguous, revised, conflicting], ambiguous, 7)).toBeNull()
  const unboundStoryboard = { ...original, production: { ...original.production, storyboardId: undefined } }
  const differentStoryboard = { ...conflicting, production: { ...original.production, storyboardId: 21 } }
  expect(videoEditions([unboundStoryboard, revised, differentStoryboard], unboundStoryboard, 7)).toBeNull()
})

it('remembers the chosen source only for its Session, shot and current bytes', () => {
  const set = videoEditions([original, revised], original, 7)
  if (set === null || set.items[1] === undefined) throw Error('Expected two versions of the shot')
  const selected = set.items[1]
  expect(adoptVideoEdition(sessionId, set, selected)).toBe(true)
  expect(getAdoptedVideoEdition(sessionId, set)).toEqual(selected)
  expect(getAdoptedVideoEdition(brandString<SessionId>('another-session'), set)).toBeNull()
  const changed = videoEditions([original, { ...revised, version: 'replacement-bytes' }], original, 7)
  if (changed === null) throw Error('Expected a replacement recording')
  expect(getAdoptedVideoEdition(sessionId, changed)).toBeNull()
  expect(adoptVideoEdition(sessionId, changed, selected)).toBe(false)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('Storage denied') })
  expect(adoptVideoEdition(sessionId, set, selected)).toBe(false)
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('Storage denied') })
  expect(getAdoptedVideoEdition(sessionId, set)).toBeNull()
})
