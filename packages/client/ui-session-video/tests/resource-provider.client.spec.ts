/** Resource ownership keeps inventory refreshes cancellable and source generations retained. */
import { expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionVideoInventory } from '@deepseek-ai/dsh-session-video/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { createVideoResources } from '../src/client/resource-provider.ts'
import { videoWorkspaceAddress } from '../src/client/target-selection.ts'
import { inventory, sessionId } from './selection-fixture.client.ts'

function fixture() {
  const events = createSnapshotStore<SessionEventWindow>({ entries: [], hasMore: false, revision: 0,
    change: { kind: 'replace', entries: [] } })
  const release = vi.fn(), retain = vi.fn(() => ({ ready: Promise.resolve(events), release }))
  const list = vi.fn<() => Promise<RemoteResult<SessionVideoInventory>>>().mockResolvedValue({ ok: true, value: inventory() })
  const resources = createVideoResources(retain, list)
  const controller = new AbortController()
  const stream = resources.provider.open(videoWorkspaceAddress(sessionId), { signal: controller.signal })[Symbol.asyncIterator]()
  return { events, release, retain, list, resources, controller, stream }
}

it('refreshes after durable event changes and manual retry while ignoring transient assistant frames', async () => {
  const { events, release, list, resources, controller, stream } = fixture()
  expect((await stream.next()).value).toEqual({ ok: true, value: inventory() })
  events.set({ entries: [], hasMore: false, revision: 1, change: { kind: 'append', entries: [] } })
  events.set({ entries: [], hasMore: false, revision: 2, change: { kind: 'append', entries: [{ type: 'event', event: {
    type: 'turn/end', seq: SessionSeq(2), time: 0, data: { turn: 1, reason: { kind: 'completed' } },
  } }] } })
  expect((await stream.next()).value).toEqual({ ok: true, value: inventory() })
  expect(list).toHaveBeenCalledTimes(2)
  resources.refresh(sessionId)
  expect((await stream.next()).value).toEqual({ ok: true, value: inventory() })
  const pending = stream.next()
  controller.abort()
  expect(await pending).toMatchObject({ done: true })
  await resources.settle()
  expect(release).toHaveBeenCalledOnce()
})

it('drops a response that finishes after abort and releases the exact retained generation', async () => {
  const { list, release, controller, stream, resources } = fixture()
  const pending = Promise.withResolvers<RemoteResult<SessionVideoInventory>>()
  list.mockReturnValueOnce(pending.promise)
  const next = stream.next()
  await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
  controller.abort()
  pending.resolve({ ok: true, value: inventory() })
  expect(await next).toMatchObject({ done: true })
  await resources.settle()
  expect(release).toHaveBeenCalledOnce()
})

it('keeps a Remote failure observable and retries the same resource on request', async () => {
  const { list, stream, resources, controller } = fixture()
  const failure = new RemoteError('gateway/internal', 'Inventory unavailable', {})
  list.mockResolvedValueOnce({ ok: false, error: failure })
  expect((await stream.next()).value).toEqual({ ok: false, error: failure })
  resources.refresh(sessionId)
  expect((await stream.next()).value).toEqual({ ok: true, value: inventory() })
  controller.abort()
  await stream.return?.()
  await resources.settle()
})

it('retries a thrown inventory request while retaining the same conversation', async () => {
  const { list, stream, resources, controller, retain, release } = fixture()
  list.mockRejectedValueOnce(new Error('Temporary transport failure'))
  expect((await stream.next()).value).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'Temporary transport failure' } })
  resources.refresh(sessionId)
  expect((await stream.next()).value).toEqual({ ok: true, value: inventory() })
  expect(retain).toHaveBeenCalledOnce()
  controller.abort()
  await stream.return?.()
  await resources.settle()
  expect(release).toHaveBeenCalledOnce()
})

it('reacquires after an initial conversation failure when the user retries', async () => {
  const { stream, resources, controller, retain, release } = fixture()
  retain.mockReturnValueOnce({ ready: Promise.reject(new Error('Conversation unavailable')), release })
  expect((await stream.next()).value).toMatchObject({ ok: false, error: { message: 'Conversation unavailable' } })
  expect(release).toHaveBeenCalledOnce()
  resources.refresh(sessionId)
  expect((await stream.next()).value).toEqual({ ok: true, value: inventory() })
  expect(retain).toHaveBeenCalledTimes(2)
  controller.abort()
  await stream.return?.()
  await resources.settle()
  expect(release).toHaveBeenCalledTimes(2)
})

it('refuses malformed addresses without acquiring a conversation', async () => {
  const { retain, resources } = fixture()
  const stream = resources.provider.open('dsh-resource://session-video/session/', { signal: new AbortController().signal })[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
  expect(retain).not.toHaveBeenCalled()
  expect((await stream.next()).done).toBe(true)
})

it('does not acquire an already canceled resource and ignores refreshes without readers', async () => {
  const { retain, resources } = fixture(), controller = new AbortController()
  controller.abort()
  const stream = resources.provider.open(videoWorkspaceAddress(sessionId), { signal: controller.signal })[Symbol.asyncIterator]()
  resources.refresh(sessionId)
  expect(await stream.next()).toMatchObject({ done: true })
  expect(retain).not.toHaveBeenCalled()
})

it('keeps other readers alive when one observer releases the same conversation', async () => {
  const { stream, events, resources, controller } = fixture(), other = new AbortController()
  const second = resources.provider.open(videoWorkspaceAddress(sessionId), { signal: other.signal })[Symbol.asyncIterator]()
  await stream.next(); await second.next()
  controller.abort(); await stream.return?.()
  events.set({ ...events.getSnapshot(), change: { kind: 'replace', entries: [] } })
  expect((await second.next()).value).toMatchObject({ ok: true })
  events.set({ ...events.getSnapshot(), change: { kind: 'settle-assistant', attemptId: LlmAttemptId('settled') } })
  expect((await second.next()).value).toMatchObject({ ok: true })
  other.abort(); await second.return?.(); await resources.settle()
})

it.each([new Error('Retain failed'), 'unexpected rejection'])('reports failed retention without inventing a held Session (%s)', async (failure) => {
  const { retain, stream, controller, resources } = fixture()
  retain.mockImplementationOnce(() => { throw failure })
  expect((await stream.next()).value).toMatchObject({ ok: false, error: { message: failure instanceof Error
    ? failure.message : 'Session video conversation could not be opened' } })
  controller.abort(); await stream.return?.(); await resources.settle()
})

it('releases retention when cancellation settles before Session readiness', async () => {
  const { retain, release, stream, controller, resources, events, list } = fixture()
  const ready = Promise.withResolvers<typeof events>()
  retain.mockReturnValueOnce({ ready: ready.promise, release })
  const next = stream.next()
  controller.abort(); ready.resolve(events)
  expect(await next).toMatchObject({ done: true })
  expect(list).not.toHaveBeenCalled()
  await resources.settle()
  expect(release).toHaveBeenCalledOnce()
})

it('drops a retention rejection after cancellation and reports non-Error transport failures', async () => {
  const first = fixture(), ready = Promise.withResolvers<typeof first.events>()
  first.retain.mockReturnValueOnce({ ready: ready.promise, release: first.release })
  const next = first.stream.next()
  first.controller.abort(); ready.reject(new Error('Late failure'))
  expect(await next).toMatchObject({ done: true })
  await first.resources.settle()
  const second = fixture()
  second.list.mockRejectedValueOnce('Unexpected transport failure')
  expect((await second.stream.next()).value).toMatchObject({ ok: false, error: { message: 'Session video inventory request failed' } })
  second.controller.abort(); await second.stream.return?.(); await second.resources.settle()
})
