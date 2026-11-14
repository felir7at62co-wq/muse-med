// @vitest-environment jsdom
/** Inline source identity, delivered-file ownership and reversible collection stay in one Session. */
import { act, fireEvent, render } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ConversationLocationIndex } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video'
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

it('keeps delivered playback in place across media errors and retries the same owner-authorized URL', async () => {
  const item = { ...source(), presentedIndex: 0 }
  const { runtime, reference } = await fixture([item])
  const card = runtime.renderSlot('test.video.delivered', { sourceUrl: '/delivered/original.mp4', label: 'Delivered original',
    path: item.path ?? '', seq: 4, index: 0 }, { session: reference })
  const video = card.view.getByLabelText('Delivered original') as HTMLVideoElement
  fireEvent.error(video)
  expect(card.view.getByRole('alert').textContent).toContain(en.unavailable)
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load')
  fireEvent.click(card.view.getByRole('button', { name: en.retry }))
  expect(load).toHaveBeenCalledOnce()
  expect(video.getAttribute('src')).toBe('/delivered/original.mp4')
  card.update({ sourceUrl: '/delivered/updated.mp4', label: 'Delivered original', path: item.path ?? '', seq: 4, index: 0 })
  expect(card.view.getByLabelText('Delivered original')).toBe(video)
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
  const { runtime, reference } = await fixture(sources)
  const cards = runtime.renderSlot('conversation.chat.turnTail', { turn: turn(), seq: 10, openFile: () => {} }, { session: reference })
  expect(cards.container.querySelectorAll('video')).toHaveLength(1)
  expect(cards.view.getByLabelText(original.label)).toBeTruthy()
  cards.update({ turn: turn(false), seq: 10, openFile: () => {} })
  expect(cards.container.querySelectorAll('video')).toHaveLength(0)
  cards.update({ turn: turn(true, false), seq: 20, openFile: () => {} })
  expect(cards.container.querySelectorAll('video')).toHaveLength(2)
})

/** Control only browser-owned geometry and frames; collection still runs the real hook. */
function motion() {
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
  const context: Pick<CanvasRenderingContext2D, 'setTransform' | 'save' | 'restore' | 'beginPath' | 'moveTo' | 'bezierCurveTo'
    | 'lineTo' | 'closePath' | 'fill' | 'rect' | 'roundRect' | 'clip' | 'fillStyle' | 'globalAlpha'> = {
    setTransform: () => {}, save: () => {}, restore: () => {}, beginPath: () => {}, moveTo: () => {}, bezierCurveTo: () => {},
    lineTo: () => {}, closePath: () => {}, fill: () => {}, rect: () => {}, roundRect: () => {}, clip: () => {}, fillStyle: '', globalAlpha: 1,
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  return { set: (value: number) => { top = value }, paint: () => {
    act(() => { const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(0) })
  } }
}

it.each([true, false])('collects and restores the original card and opens only a recorded source (recorded=%s)', async (recorded) => {
  const { instance } = await fixture()
  const moving = motion(), item = source(), url = '/delivered/selected.mp4'
  const view = render(<div data-conversation-content data-chat-frame>
    <button data-muse-video-anchor />
    <div data-chat-scroll><InlineVideoCard source={recorded ? item : undefined} sourceUrl={url}
      label="Inline original" actions={instance.actions} t={makeTranslate(en)} /></div>
  </div>)
  onTestFinished(() => { view.unmount() })
  moving.paint()
  const scroll = view.container.querySelector('[data-chat-scroll]')
  if (!scroll) throw Error('Inline owner did not mount its Chat scroll container')
  moving.set(-76); fireEvent.scroll(scroll); moving.paint()
  expect(instance.getSnapshot().collected[recorded ? item.id : url]).toBe(true)
  const card = view.container.querySelector<HTMLElement>('[data-muse-inline-video]')
  expect(card?.style.visibility).toBe('hidden')
  moving.set(240); fireEvent.scroll(scroll); moving.paint()
  expect(instance.getSnapshot().collected[recorded ? item.id : url]).toBe(false)
  expect(card?.style.visibility).toBe('')
  moving.set(54); fireEvent.scroll(scroll); moving.paint()
  const hit = view.container.querySelector<HTMLButtonElement>('[data-video-absorption] button')
  if (!hit) throw Error('Moving card did not mount its open control')
  expect(hit.hidden).toBe(false)
  fireEvent.click(hit)
  expect(instance.getSnapshot().open).toBe(recorded)
  view.unmount()
})
