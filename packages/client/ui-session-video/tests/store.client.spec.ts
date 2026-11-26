/** Workspace browsing retains observed analyses and retries failed observations. */
import { expect, it } from 'vitest'
import { createVideoStore } from '../src/client/store.ts'
import { source, analysis } from './video-fixture.tsx'

it('keeps completed source observations when retrying only the failed analyses', () => {
  const state = createVideoStore().create(), first = source(), second = source('second')
  state.actions.analysis(analysis(first))
  state.actions.analysis({ ...analysis(second), state: 'failed', issue: 'Unavailable media' })
  state.actions.retryFailed()
  expect(Object.keys(state.getSnapshot().analyses)).toEqual([first.id])
  const observedShot = analysis(first).shots[0]
  if (!observedShot) throw Error('The fixture has no observed shot')
  state.actions.selectShot({ sourceId: first.id, shotId: observedShot.id, time: 1 })
  state.actions.select(second.id)
  expect(state.getSnapshot()).toMatchObject({ selected: second.id, selectedShot: null })
})
