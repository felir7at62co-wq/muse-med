// @vitest-environment jsdom
/** Compact inline entries retain source identity and open the same conversation's video workspace. */
import { act, fireEvent, render } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ConversationLocationIndex } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { InlineVideoCard } from '../src/client/InlineVideoCard.tsx'
import { en } from '../src/client/locales.ts'
import { fixture, source } from './video-fixture.tsx'

function turn(start = true, end = true): TurnLocation {
  const index = new ConversationLocationIndex()
  index.rebuild([
    start ? { type: 'event', event: { seq: SessionSeq(1), time: 0, type: 'turn/start', data: { turn: 1 } } }
      : { type: 'event', event: { seq: SessionSeq(1), time: 0, type: 'step/start', data: { turn: 1, step: 1 } } },
    ...end ? [{ type: 'event' as const, event: { seq: SessionSeq(10), time: 0, type: 'turn/end' as const, data: { turn: 1, reason: { kind: 'completed' as const } } } }] : [],
  ])
  const result = index.snapshot().turns.get(1)
  if (!result) throw Error('Fixture did not assemble a Turn')
  return result
}

it('keeps a delivered entry usable when its muted thumbnail fails and follows an updated authorized URL', async () => {
  const item = { ...source(), presentedIndex: 0 }
  const { runtime, reference, openWorkspace } = await fixture([item])
  const card = runtime.renderSlot('test.video.delivered', { sourceUrl: '/delivered/original.mp4', label: 'Delivered original',
    path: item.path ?? '', seq: 4, index: 0 }, { session: reference })
  const video = card.container.querySelector('video')
  if (video === null) throw Error('The delivered entry has no metadata thumbnail')
  expect(video.muted).toBe(true)
  expect(video.preload).toBe('metadata')
  expect(video.controls).toBe(false)
  expect(video.autoplay).toBe(false)
  fireEvent.error(video)
  expect(video.hidden).toBe(true)
  fireEvent.click(card.view.getByRole('button', { name: 'Switch video: Delivered original' }))
  expect(openWorkspace).toHaveBeenCalledOnce()
  expect(video.getAttribute('src')).toBe('/delivered/original.mp4')
  card.update({ sourceUrl: '/delivered/updated.mp4', label: 'Delivered original', path: item.path ?? '', seq: 4, index: 0 })
  expect(card.container.querySelector('video')).toBe(video)
  expect(video.hidden).toBe(false)
  expect(video.getAttribute('src')).toBe('/delivered/updated.mp4')
})

it('shows only generated sources in the current Turn and omits a path already owned by a delivered card', async () => {
  const original = source(), duplicate = source('duplicate')
  const sources: SessionVideoSource[] = [original,
    { ...source('attachment'), origin: 'attachment' },
    { ...source('delivered'), presentedIndex: 1 },
    { ...source('older'), eventSeq: 0 }, { ...source('later'), eventSeq: 12 },
    { ...source('unavailable'), playbackUrl: null }, duplicate,
    { ...source('duplicate-delivered'), path: duplicate.path, presentedIndex: 2 },
  ]
  const { runtime, reference, resource } = await fixture(sources)
  const cards = runtime.renderSlot('conversation.chat.turnTail', { turn: turn(), seq: 10, openFile: () => {} }, { session: reference })
  expect(cards.container.querySelectorAll('video')).toHaveLength(1)
  expect(cards.view.getByRole('button', { name: makeTranslate(en)('source', { name: original.label }) })).toBeTruthy()
  cards.update({ turn: turn(false), seq: 10, openFile: () => {} })
  expect(cards.container.querySelectorAll('video')).toHaveLength(0)
  cards.update({ turn: turn(true, false), seq: 20, openFile: () => {} })
  expect(cards.container.querySelectorAll('video')).toHaveLength(2)
  act(() => { resource.set({ status: 'loading', value: undefined, failure: undefined }) })
  expect(cards.container.querySelectorAll('video')).toHaveLength(0)
})

it('opens the video workspace from the native Session header without adding another coordinator', async () => {
  const { panel, openWorkspace } = await fixture()
  fireEvent.click(panel.view.getByRole('button', { name: 'Conversation videos' }))
  expect(openWorkspace).toHaveBeenCalledOnce()
  expect(panel.container.querySelector('[data-muse-video-launcher]')).toBeNull()
})

/** Reproduce the header crossing where the legacy collection canvas appeared. */
function scrollFrame() {
  let top = 240, nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-muse-inline-video')) return new DOMRect(200, top, 400, 240)
    if (this.hasAttribute('data-chat-scroll')) return new DOMRect(100, 140, 600, 500)
    if (this.hasAttribute('data-muse-video-anchor')) return new DOMRect(350, 60, 100, 40)
    return new DOMRect(100, 0, 600, 700)
  })
  return { set: (value: number) => { top = value }, paint: () => {
    act(() => { const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(0) })
  } }
}

it.each([true, false])('keeps the entry visible without a collection canvas and opens its workspace (recorded=%s)', async (recorded) => {
  const { instance, openWorkspace } = await fixture()
  const moving = scrollFrame(), item = { ...source(), production: { scriptId: 1, episodeNumber: 33 } }, url = '/delivered/selected.mp4'
  instance.actions.selectEpisode(31)
  const view = render(<div data-conversation-content data-chat-frame>
    <button data-muse-video-anchor />
    <div data-chat-scroll><InlineVideoCard source={recorded ? item : undefined} sourceUrl={url}
      label="Inline original" actions={instance.actions} openWorkspace={openWorkspace} t={makeTranslate(en)} /></div>
  </div>)
  onTestFinished(() => { view.unmount() })
  moving.paint()
  const scroll = view.container.querySelector('[data-chat-scroll]')
  if (!scroll) throw Error('Inline owner did not mount its Chat scroll container')
  const card = view.container.querySelector<HTMLElement>('[data-muse-inline-video]')
  for (const top of [54, -76, 240]) {
    moving.set(top); fireEvent.scroll(scroll); moving.paint()
    expect(card?.style.visibility).toBe('')
    expect(card?.inert).not.toBe(true)
    expect(view.container.querySelector('[data-video-absorption]')).toBeNull()
    expect(view.container.querySelector('canvas')).toBeNull()
  }
  fireEvent.click(view.getByRole('button', { name: 'Switch video: Inline original' }))
  expect(openWorkspace).toHaveBeenCalledOnce()
  expect(instance.getSnapshot().selected).toBe(recorded ? item.id : null)
  expect(instance.getSnapshot().selectedEpisode).toBe(recorded ? 33 : 31)
  view.unmount()
})
