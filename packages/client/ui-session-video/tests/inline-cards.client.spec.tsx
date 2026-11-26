// @vitest-environment jsdom
/** Compact inline entries retain source identity and open the same conversation's video workspace. */
import { act, fireEvent, render } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ConversationLocationIndex } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnLocation, UserMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ChatSnapshotBuilder } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { InlineVideoCard } from '../src/client/InlineVideoCard.tsx'
import { en } from '../src/client/locales.ts'
import { authoredShots } from '../src/client/timeline.ts'
import { serializeVideoTargets } from '../src/client/target-selection.ts'
import { fixture, inventory, source } from './video-fixture.tsx'
import { sessionId as otherSessionId } from './selection-fixture.client.ts'

type FileAttachmentId = Extract<UserMessageNode['content'][number], { type: 'file' }>['attachment']['attachmentId']

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

function historyWithInput(input: UserMessageNode) {
  const location = turn()
  return new ChatSnapshotBuilder().replace({ timeline: { turnOrder: [1], turns: new Map([[1, location]]) }, nodes: [{
    key: 'user:delivery-review', id: 'delivery-review', target: 'chat', kind: 'user', anchorSeq: input.seq, visibility: 'visible',
    location: { kind: 'turn', turn: location }, data: input,
  }] })
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

it('compares a newly delivered edition at its exact observed shot', async () => {
  const production = { scriptId: 9, episodeNumber: 8, packageIndex: 1, shotNumbers: [3],
    shotRanges: [{ shotNumber: 3, startSeconds: 12, endSeconds: 15 }] }
  const original = { ...source(), eventSeq: 2, production }
  const next = { ...source('new-clip'), version: 'verified-v2', presentedIndex: 0, production }
  const { runtime, reference, openWorkspace } = await fixture([original, next])
  const card = runtime.renderSlot('test.video.delivered', { sourceUrl: '/delivered/new.mp4', label: 'Returned video',
    path: next.path ?? '', seq: 4, index: 0 }, { session: reference })
  expect(card.view.getByText('New version received')).toBeTruthy()
  expect(card.view.getByText('Episode 8 · Shot 3 · V2')).toBeTruthy()
  const video = card.container.querySelector('video')
  if (video === null) throw Error('The revised card has no media thumbnail')
  fireEvent.loadedMetadata(video)
  expect(video.currentTime).toBe(0)
  Object.defineProperty(video, 'duration', { configurable: true, value: 25 })
  fireEvent.loadedMetadata(video)
  expect(video.currentTime).toBe(13.5)
  expect(video.getAttribute('src')).toBe(next.playbackUrl)
  fireEvent.click(card.view.getByRole('button', { name: 'Compare with original' }))
  const [destination, target, intent] = openWorkspace.mock.calls[0] ?? []
  expect(destination).toBe('sidebar')
  expect(intent).toBe('compare')
  expect(target).toMatchObject({ kind: 'shot', sourceId: next.id, sourceVersion: next.version, startSeconds: 12, endSeconds: 15 })
})

it('keeps a duplicate path an ordinary delivery even when the episode metadata matches', async () => {
  const production = { scriptId: 9, episodeNumber: 8, packageIndex: 1, shotNumbers: [3],
    shotRanges: [{ shotNumber: 3, startSeconds: 12, endSeconds: 15 }] }
  const original = { ...source(), eventSeq: 2, production }
  const repeated = { ...source('repeated'), path: original.path, presentedIndex: 0, production }
  const { runtime, reference } = await fixture([original, repeated])
  const card = runtime.renderSlot('test.video.delivered', { sourceUrl: '/delivered/same.mp4', label: 'Repeated video',
    path: repeated.path ?? '', seq: 4, index: 0 }, { session: reference })
  expect(card.view.queryByText('New version received')).toBeNull()
  expect(card.view.getByRole('button', { name: 'Switch video: Repeated video' })).toBeTruthy()
})

it('keeps the first recording and repeated provider URL ordinary and names each returned shot', async () => {
  const production = { scriptId: 9, episodeNumber: 8, packageIndex: 1, shotNumbers: [2, 3], shotRanges: [
    { shotNumber: 2, startSeconds: 0, endSeconds: 4 }, { shotNumber: 3, startSeconds: 4, endSeconds: 8 },
  ] }
  const original = { ...source(), eventSeq: 2, presentedIndex: 0, remoteUrl: 'https://example.test/original.mp4', production }
  const repeat = { ...source('repeat'), presentedIndex: 1, remoteUrl: original.remoteUrl, production }
  const revised = { ...source('revised'), presentedIndex: 2, eventSeq: 5, production }
  const { runtime, reference, resource, openWorkspace } = await fixture([original, repeat, revised])
  const delivery = { sourceUrl: '/delivered/clip.mp4', label: 'Video delivery', path: '' }
  const card = runtime.renderSlot('test.video.delivered', { ...delivery, seq: 2, index: 0 }, { session: reference })
  expect(card.view.queryByText('New version received')).toBeNull()
  card.update({ ...delivery, seq: 4, index: 1 })
  expect(card.view.queryByText('New version received')).toBeNull()
  card.update({ ...delivery, seq: 5, index: 2 })
  expect(card.view.getByRole('button', { name: 'Episode 8 · Shot 2 · V3 · Compare with original' })).toBeTruthy()
  fireEvent.click(card.view.getByRole('button', { name: 'Episode 8 · Shot 3 · V3 · Compare with original' }))
  expect(openWorkspace).toHaveBeenCalledOnce()
  expect(openWorkspace.mock.calls[0]?.[1]).toMatchObject({ startSeconds: 4, endSeconds: 8 })
  const unavailable = { ...revised, playbackUrl: null }
  act(() => { resource.set({ status: 'live', value: inventory([original, repeat, unavailable]), failure: undefined }) })
  expect(card.view.queryByText('New version received')).toBeNull()
  act(() => { resource.set({ status: 'live', value: inventory([revised]), failure: undefined }) })
  expect(card.view.queryByText('New version received')).toBeNull()
  act(() => { resource.set({ status: 'loading', value: undefined, failure: undefined }) })
  expect(card.view.getByRole('button', { name: 'Switch video: Video delivery' })).toBeTruthy()
})

it('highlights a multi-shot delivery at the exact shot requested earlier in that Turn', async () => {
  const production = { scriptId: 9, episodeNumber: 8, packageIndex: 1, shotNumbers: [1, 2, 3], shotRanges: [
    { shotNumber: 1, startSeconds: 0, endSeconds: 5 },
    { shotNumber: 2, startSeconds: 5, endSeconds: 12 },
    { shotNumber: 3, startSeconds: 12, endSeconds: 15 },
  ] }
  const original = { ...source(), eventSeq: 2, production }
  const next = { ...source('new-clip'), version: 'verified-v2', presentedIndex: 0, production }
  const requested = authoredShots(original).find(shot => shot.index === 3)
  if (requested === undefined) throw Error('Expected the original video to include the requested shot')
  const requestedTarget = { kind: 'shot' as const, sourceId: original.id, sourceVersion: 'v1', shotId: requested.id,
    startSeconds: requested.localStart, endSeconds: requested.localEnd }
  const whole = { kind: 'source' as const, sourceId: original.id, sourceVersion: 'v1' }
  const text = serializeVideoTargets([whole, requestedTarget], [original], inventory([]).sessionId)
  const foreign = serializeVideoTargets([requestedTarget], [original], otherSessionId)
  if (!text.ok || !foreign.ok) throw Error('Expected valid selection evidence for the original shot')
  const input: UserMessageNode = { kind: 'user', seq: 3, time: 0,
    source: { kind: 'user' }, content: [
      { type: 'file', attachment: { attachmentId: brandString<FileAttachmentId>('sha256:cd'), name: 'notes.pdf', bytes: 16 } },
      { type: 'text', text: `Make the subject brighter.\n\n${foreign.text}\n\n${text.text}` },
    ] }
  const { runtime, reference, openWorkspace, chat } = await fixture([original, next])
  chat.set(historyWithInput(input))
  const card = runtime.renderSlot('test.video.delivered', { sourceUrl: '/delivered/new.mp4', label: 'Returned three shots',
    path: next.path ?? '', seq: 4, index: 0 }, { session: reference })
  expect(card.view.getByText('Episode 8 · Shot 3 · V2')).toBeTruthy()
  expect(card.view.queryByText('Episode 8 · Shot 1 · V2')).toBeNull()
  fireEvent.click(card.view.getByRole('button', { name: 'Compare with original' }))
  const [destination, target, intent] = openWorkspace.mock.calls[0] ?? []
  expect(destination).toBe('sidebar')
  expect(intent).toBe('compare')
  expect(target).toMatchObject({ sourceId: next.id, sourceVersion: next.version, startSeconds: 12, endSeconds: 15 })
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
  const { runtime, reference, resource, chat } = await fixture(sources)
  chat.set(historyWithInput({ kind: 'user', seq: 3, time: 0, source: { kind: 'user' }, content: [{ type: 'text', text: 'Create a clip.' }] }))
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
