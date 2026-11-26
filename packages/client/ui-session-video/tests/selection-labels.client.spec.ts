/** Composer labels keep the recorded episode and authored range distinct from detected cuts. */
import { expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { videoSelectionLabel } from '../src/client/selection-labels.ts'
import { authoredShots } from '../src/client/timeline.ts'
import { en } from '../src/client/locales.ts'
import { shot, source, whole } from './selection-fixture.client.ts'

it('includes a known episode and authored shot only for its exact observed interval', () => {
  const item = { ...source(), production: { scriptId: 10, episodeNumber: 2, packageIndex: 3,
    shotRanges: [{ shotNumber: 7, startSeconds: 2, endSeconds: 5 }] } }
  const authored = authoredShots(item)[0]
  if (authored === undefined) throw Error('Expected an observed fixture shot')
  const target = { ...shot(item), shotId: authored.id, startSeconds: 2, endSeconds: 5 }
  expect(videoSelectionLabel(item, target, makeTranslate(en))).toBe('Episode 2 · Shot 7 · 2.00–5.00 s · Video first')
  expect(videoSelectionLabel(item, { ...target, endSeconds: 6 }, makeTranslate(en)))
    .toBe('Episode 2 · 2.00–6.00 s · Video first')
  expect(videoSelectionLabel(item, whole(item), makeTranslate(en))).toBe('Episode 2 · Video package 3 · Video first')
})

it('keeps unassigned videos readable without guessing metadata from their filenames', () => {
  const item = { ...source(), label: 'episode-9-shot-7-new.mp4' }
  expect(videoSelectionLabel(item, whole(item), makeTranslate(en))).toBe(item.label)
  expect(videoSelectionLabel(item, shot(item), makeTranslate(en))).toBe(`4.00–8.00 s · ${item.label}`)
})
