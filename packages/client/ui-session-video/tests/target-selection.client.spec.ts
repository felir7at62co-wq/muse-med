/** Exact media selections survive browsing and refuse obsolete source versions. */
import { expect, it } from 'vitest'
import { parseVideoWorkspaceAddress, prepareVideoPrompt, serializeVideoTargets, targetKey, videoWorkspaceAddress } from '../src/client/target-selection.ts'
import { createVideoStore } from '../src/client/store.ts'
import { sessionId, shot, source, whole } from './selection-fixture.client.ts'

it('serializes source identity and original cut coordinates without model-facing playback routes', () => {
  const selected = shot(), item = source()
  const result = prepareVideoPrompt('review', [selected, selected], [item], {
    requests: { review: 'Review only; do not regenerate.', edit: 'Edit selected media.', regenerate: 'Regenerate selected media.' },
    selection: 'Selected sources:',
  }, sessionId)
  if (!result.ok) throw Error('Current source selection was refused')
  expect(result.text).toMatch(/^Review only; do not regenerate\./u)
  expect(result.text).toContain('"path": "/project/first.mp4"')
  expect(result.text).toContain('"source_version": "v1"')
  expect(result.text).toContain('"start_seconds": 4')
  expect(result.text).toContain('"end_seconds": 8')
  expect(result.text).not.toContain('/api/session-video')
  expect(result.text.match(/"source_id"/gu)).toHaveLength(1)
  expect(parseVideoWorkspaceAddress(videoWorkspaceAddress(sessionId, selected))).toEqual({ sessionId, target: selected })
})

it('retains distinct source versions and refuses the stale part of a multi-source request', () => {
  const first = source(), second = source('second'), selected = shot(first)
  const stale = { ...selected, sourceVersion: 'earlier' }
  expect(targetKey(stale)).not.toBe(targetKey(selected))
  expect(serializeVideoTargets([], [first], sessionId)).toEqual({ ok: false, reason: 'empty', targetKeys: [] })
  expect(serializeVideoTargets([stale, whole(second)], [first, second], sessionId)).toEqual({ ok: false,
    reason: 'stale', targetKeys: [targetKey(stale)] })
  expect(serializeVideoTargets([selected], [], sessionId)).toEqual({ ok: false, reason: 'stale', targetKeys: [targetKey(selected)] })
  expect(serializeVideoTargets([selected], [{ ...first, playbackUrl: null }], sessionId).ok).toBe(false)
})

it('round-trips source links and refuses incomplete, duplicated and invalid media coordinates', () => {
  const address = videoWorkspaceAddress(sessionId, whole())
  expect(parseVideoWorkspaceAddress(videoWorkspaceAddress(sessionId))).toEqual({ sessionId })
  expect(parseVideoWorkspaceAddress(address)).toEqual({ sessionId, target: whole() })
  for (const invalid of ['not a URL', 'https://session-video/session/s', 'dsh-resource://session-video/session/',
    'dsh-resource://session-video/session/%E0', `${address}&source=another`, `${address}&start=0&end=4`,
    `${address}&shot=cut&start=-1&end=4`, `${address}&shot=cut&start=4&end=4`, `${address}&shot=cut&start=0&end=Infinity`,
    `${address}&unexpected=field`, `${address}&shot=cut&start=&end=4`]) {
    expect(parseVideoWorkspaceAddress(invalid), invalid).toBeNull()
  }
})

it('retains episode and playback choices per workspace without keeping a second composer selection', () => {
  const instance = createVideoStore().create(), other = createVideoStore().create()
  const first = source()
  instance.actions.selectEpisode('unassigned'); instance.actions.selectShot({ sourceId: first.id, shotId: shot(first).shotId, time: 4 })
  instance.actions.setZoom(2); instance.actions.dismissNavigation('tab/3')
  instance.actions.seekTo({ sourceId: first.id, time: 5 })
  expect(instance.getSnapshot()).toMatchObject({ selectedEpisode: 'unassigned', selected: first.id, selectedShot: shot(first).shotId, zoom: 2,
    seek: { sourceId: first.id, time: 5, revision: 2 }, handledNavigation: 'tab/3' })
  expect(instance.getSnapshot()).not.toHaveProperty('targets')
  expect(other.getSnapshot()).toMatchObject({ selectedEpisode: 'all', zoom: 1, seek: null })
})
