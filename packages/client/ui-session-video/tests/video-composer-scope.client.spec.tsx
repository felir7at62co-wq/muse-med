// @vitest-environment jsdom
/** The composer mirrors the verified preview range without touching the draft. */
import { act } from '@testing-library/react'
import { expect, it } from 'vitest'
import { authoredShots } from '../src/client/timeline.ts'
import { analysis, fixture, inventory, source } from './video-fixture.tsx'

function openComposer({ runtime, reference, input }: Awaited<ReturnType<typeof fixture>>) {
  return runtime.renderSlot('conversation.input.dock', {
    session: reference.binding.session.getSnapshot(), input: input.getSnapshot(),
  }, { session: reference })
}

it('shows the authored shot and version retained by the video store and hides inaccessible scope', async () => {
  const production = { scriptId: 14, episodeNumber: 1, packageIndex: 2,
    shotRanges: [{ shotNumber: 7, startSeconds: 1, endSeconds: 3 }] }
  const original = { ...source(), production }
  const revision = { ...source('revised'), eventSeq: 9, production }
  const h = await fixture([original, revision])
  const view = openComposer(h)
  const draft = h.input.getSnapshot()
  const cut = authoredShots(revision)[0]
  if (cut === undefined) throw Error('Expected authored shot in fixture')
  const selected = { sourceId: revision.id, shotId: cut.id, time: 1 }
  expect(view.container.querySelector('[data-muse-composer-scope]')).toBeNull()
  act(() => { h.instance.actions.select(revision.id) })
  expect(view.container.querySelector('[data-muse-composer-scope]')).toBeNull()
  act(() => { h.instance.actions.selectShot(selected) })
  expect(view.view.getByText('Episode 1 · Shot 7 · 00:01–00:03 · V2')).toBeDefined()
  act(() => { h.instance.actions.selectEpisode(2) })
  expect(view.container.querySelector('[data-muse-composer-scope]')).toBeNull()
  act(() => { h.instance.actions.selectEpisode(1) })
  expect(view.view.getByText('Episode 1 · Shot 7 · 00:01–00:03 · V2')).toBeDefined()
  for (const sources of [[original], [original, { ...revision, playbackUrl: null }]]) {
    act(() => { h.resource.set({ status: 'live', value: inventory(sources), failure: undefined }) })
    expect(view.container.querySelector('[data-muse-composer-scope]')).toBeNull()
  }
  act(() => { h.resource.set({ status: 'loading', value: undefined, failure: undefined }) })
  expect(view.container.querySelector('[data-muse-composer-scope]')).toBeNull()
  expect(h.input.getSnapshot()).toBe(draft)
})

it('waits for detection on the current source version before naming a detected range', async () => {
  const item = source()
  const h = await fixture([item])
  const detected = analysis(item)
  const cut = detected.shots[0]
  if (cut === undefined) throw Error('Expected detected segment in fixture')
  const view = openComposer(h)
  act(() => { h.instance.actions.selectShot({ sourceId: item.id, shotId: cut.id, time: 0 }) })
  expect(view.container.querySelector('[data-muse-composer-scope]')).toBeNull()
  act(() => { h.instance.actions.selectEpisode('unassigned'); h.instance.actions.analysis(detected) })
  expect(view.view.getByText('Video segment 1 · 00:00–00:04')).toBeDefined()
  act(() => { h.resource.set({ status: 'live', value: inventory([{ ...item, version: 'replaced' }]), failure: undefined }) })
  expect(view.container.querySelector('[data-muse-composer-scope]')).toBeNull()
})
