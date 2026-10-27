import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type {} from '../packages/perception/tool-video-inspect/src/review-state.ts'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error Scenario plugins are runtime JavaScript without declaration artifacts.
import * as fixtureModule from '../snapshots/sdk/text-turn/feedback-producer.mjs'

type ReviewEvent = { type: 'video/review'; data: SessionEventMap['video/review'] }
type Notification = { method: 'session.event'; payload: { event: ReviewEvent } }
interface StubAgent {
  id: string
  session: {
    header: { cwd: string }
    deriveMessages(): { id: string; role: string }[]
    append(type: 'video/review', data: SessionEventMap['video/review']): void
  }
}
type TurnListener = (input: { agent: StubAgent; signal: AbortSignal }) => Promise<void>

async function drive(cwd: string) {
  const events: ReviewEvent[] = []
  const notifications: Notification[] = []
  const listeners: TurnListener[] = []
  const messages = [{ id: 'assistant-answer', role: 'assistant' }]
  const agent: StubAgent = { id: 'feedback-parent', session: {
    header: { cwd }, deriveMessages: () => messages,
    append(type, data) {
      const event = { type, data: structuredClone(data) }
      events.push(event)
      notifications.push({ method: 'session.event', payload: { event: structuredClone(event) } })
    },
  } }
  const commands = { execute: vi.fn(async () => ({ result: { kind: 'success' } })) }
  const sessionFeedback = { record: vi.fn(async () => ({ ok: true })) }
  const messageFeedback = {
    put: vi.fn(async () => ({ ok: true, value: { version: 'feedback-version' } })),
    delete: vi.fn(async () => ({ ok: true })),
  }
  const context = { commands, sessionFeedback, messageFeedback,
    on(name: string, listener: TurnListener) {
      assert.equal(name, 'agent/turn-stopping')
      listeners.push(listener)
    },
  }
  const fixture: unknown = fixtureModule
  assert(typeof fixture === 'object' && fixture !== null && 'apply' in fixture && typeof fixture.apply === 'function')
  const apply = fixture.apply as (ctx: typeof context) => void
  apply(context)
  assert.equal(listeners.length, 1)
  await listeners[0]!({ agent, signal: new AbortController().signal })
  expect(commands.execute).toHaveBeenCalledOnce()
  expect(sessionFeedback.record).toHaveBeenCalledOnce()
  expect(messageFeedback.put).toHaveBeenCalledTimes(2)
  expect(messageFeedback.delete).toHaveBeenCalledOnce()
  assert.deepEqual(agent.session.deriveMessages(), messages)
  return { events, notifications }
}

function assertOutput(output: Awaited<ReturnType<typeof drive>>, cwd: string): void {
  const frames = [
    { id: 'sdk-frame-1', time: 1, reasons: ['fixture'], exposed: false,
      observation: { visible: 'The woman stands at the closed door.', change: 'The door is closed.', uncertainty: '' } },
    { id: 'sdk-frame-2', time: 2, reasons: ['fixture'], exposed: false,
      observation: { visible: 'The woman holds the open door.', change: 'The door is open.', uncertainty: '' } },
  ]
  const path = `${cwd}/sdk-video.mp4`
  assert.deepEqual(output.events, [
    { type: 'video/review', data: { kind: 'start', review: {
      id: 'sdk-review-1', episode: 'SDK', path, source_version: 'fixture-source-version',
      duration: 3, scanned_until: 3, scan_complete: true, frames,
    } } },
    { type: 'video/review', data: { kind: 'update', path, id: 'sdk-review-1', frames: [], frame_count: 2,
      scanned_until: 3, scan_complete: true, event_groups: [{
        event_id: 'door-opening', frame_ids: ['sdk-frame-1', 'sdk-frame-2'], actor: 'woman',
        action: 'opens the door', object: 'door', before: 'closed', after: 'open', uncertainty: '',
        start_seconds: 1, end_seconds: 2,
        observation_digest: 'd129d7207ff35f0e7dd67d36232854a25ff8fa3b157256d87820218efb0a799e',
      }], transcript_reference: { path: `${cwd}/sdk-transcript.json`, version: 'fixture-transcript-version',
        sha256: 'a6f13b0540bf60a5ec60048367f160c79e81995412ea7edf500fabea4e159bff' },
    } },
  ])
  assert.deepEqual(output.notifications, output.events.map(event => ({ method: 'session.event', payload: { event } })))
}

const platforms = [
  { name: 'Windows drive', cwd: String.raw`C:\qa samples\snapshot`, paths: win32 },
  { name: 'Windows UNC', cwd: String.raw`\\server\share\snapshot`, paths: win32 },
  { name: 'POSIX', cwd: '/tmp/qa samples/snapshot', paths: posix },
]

describe('advanced SDK feedback fixture paths', () => {
  it.each(platforms)('emits complete portable payloads for $name without changing file identity', async ({ cwd, paths }) => {
    const output = await drive(cwd)
    assertOutput(output, cwd)
    const start = output.events[0]?.data
    const update = output.events[1]?.data
    assert(start?.kind === 'start' && update?.kind === 'update' && update.transcript_reference)
    assert.equal(paths.resolve(start.review.path), paths.resolve(cwd, 'sdk-video.mp4'))
    assert.equal(paths.resolve(update.path), paths.resolve(cwd, 'sdk-video.mp4'))
    assert.equal(paths.resolve(update.transcript_reference.path), paths.resolve(cwd, 'sdk-transcript.json'))
  })

  it.each(['basename', 'outside-root', 'version', 'hash', 'notification'])(
    'still rejects a changed %s in the actual fixture output', async (difference) => {
      const cwd = platforms[0]!.cwd
      const output = await drive(cwd)
      assertOutput(output, cwd)
      const update = output.events[1]?.data
      assert(update?.kind === 'update' && update.transcript_reference)
      if (difference === 'basename') update.path = `${cwd}/wrong-video.mp4`
      if (difference === 'outside-root') update.transcript_reference.path = String.raw`C:\unrelated\sdk-transcript.json`
      if (difference === 'version') update.transcript_reference.version = 'wrong-transcript-version'
      if (difference === 'hash') update.transcript_reference.sha256 = '0'.repeat(64)
      if (difference === 'notification') {
        const notification = output.notifications[1]?.payload.event.data
        assert(notification?.kind === 'update')
        notification.frame_count = 1
      }
      expect(() => { assertOutput(output, cwd) }).toThrow()
    },
  )
})
