/** Main reads a Session the way a person opens it: summary, turn outline, compact steps, and one image on demand. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Session } from '@deepseek-ai/dsh-session'
import { imageAt, outlineTurns, stepItems } from '../src/history-views.ts'
import { setup, textResponse } from './fixture.ts'

const frame = { type: 'image' as const, attachment: { attachmentId: AttachmentId('frame-1'), mediaType: 'image/png' as const, bytes: 10, width: 4, height: 3 } }
const offloaded = { ...frame, offloaded: true as const }

/** Append a two-turn worker log: a failed transcription turn and an open one. */
function writeHistory(session: Session): { firstTurnSeq: number; inputSeq: number; resultSeq: number; secondTurnSeq: number } {
  const call = (id: string, name: string, args: string) => session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(id), name, arguments: args })
  const result = (id: string, content: ContentBlock[], isError: boolean) => session.append('tool/result', {
    turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(id), content, isError }),
  }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 0, step: 0 })
  const first = session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const input = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '转写第 1 集\n保留旁白' }, frame] }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'session-activity', form: 'snapshot', sections: [] }, content: [{ type: 'text', text: 'Time sampled' }] }), { surfaceOp: 'append' })
  call('a', 'video_inspect', '{"file_path":"ep1.mp4"}')
  const inspected = result('a', [{ type: 'text', text: 'frames' }, offloaded, frame], false)
  call('b', 'write', 'x'.repeat(300))
  result('b', [{ type: 'text', text: 'permission denied' }], true)
  result('ghost', [{ type: 'text', text: 'late' }], false)
  session.append('assistant/message', {
    turn: 1, step: 2, stream: [],
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: '第 1 集写不进去' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 3, stream: [],
    message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'model down', code: 'AUTH' } } })
  const second = session.append('turn/start', { turn: 2 })
  session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('c'), name: 'constructor', arguments: '{}' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { firstTurnSeq: first.seq, inputSeq: input.seq, resultSeq: inspected.seq, secondTurnSeq: second.seq }
}

async function fixture(readChars?: number) {
  const root = await mkdtemp(join(tmpdir(), 'muse-history-'))
  const test = await setup(root, Array.from({ length: 10 }, () => textResponse('ack')), undefined, readChars === undefined ? {} : { readChars })
  onTestFinished(async () => { await test.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const main = await test.makeAgent('history-main', 'main-session')
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '看看第 1 集卡在哪' }] }))
  await main.whenIdle()
  const worker = await test.makeAgent('history-worker')
  const positions = writeHistory(worker.session)
  const invoke = (name: string, args: Record<string, unknown>) => executeToolFixture(test.ctx, {
    agent: main, name, arguments: args, callId: ToolCallId('history-call'), signal: new AbortController().signal,
  })
  return { ...test, main, worker, invoke, ...positions }
}

it('outlines each turn and pages compact steps without runtime context', async () => {
  const test = await fixture()
  const events = (await test.ctx.sessionQuery.readSession(test.worker.id)).events
  expect(outlineTurns(events)).toEqual([
    { turn: 1, startSeq: test.firstTurnSeq, input: '转写第 1 集 保留旁白', tools: { video_inspect: 1, write: 1 }, images: 2, errors: 1,
      end: 'error: model down', reply: '第 1 集写不进去' },
    { turn: 2, startSeq: test.secondTurnSeq, input: '', tools: { constructor: 1 }, images: 0, errors: 0, end: 'completed', reply: '' },
  ])
  const steps = stepItems(events, 0)
  expect(steps.map(step => step.type)).toEqual(['turn', 'input', 'call', 'result', 'call', 'result', 'result', 'reply', 'turn-end', 'turn', 'call', 'turn-end'])
  expect(steps[3]).toMatchObject({ type: 'result', tool: 'video_inspect', error: false, text: 'frames', images: 1 })
  expect(steps[4]).toMatchObject({ type: 'call', tool: 'write' })
  expect(steps[6]).toMatchObject({ type: 'result', tool: 'unknown' })
  expect(stepItems(events, test.secondTurnSeq).map(step => step.type)).toEqual(['turn', 'call', 'turn-end'])
  expect(imageAt(events, test.resultSeq, 0)).toEqual(frame)
  expect(imageAt(events, test.resultSeq, 1)).toBeUndefined()
  expect(imageAt(events, -1, 0)).toBeUndefined()
  expect(imageAt(events, test.firstTurnSeq, 0)).toBeUndefined()
  expect(imageAt(events, test.inputSeq, 0)).toEqual(frame)
})

it('serves every read view and one image through Main tools within the character budget', async () => {
  const test = await fixture(200)
  const text = (result: Awaited<ReturnType<typeof test.invoke>>) => result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const outline = JSON.parse(text(await test.invoke('coordinator_read', { session_id: test.worker.id, view: 'outline' }))) as { turns: { turn: number }[]; omittedEarlier: number }
  expect(outline.turns.map(turn => turn.turn)).toEqual([2])
  expect(outline.omittedEarlier).toBe(1)
  const page = JSON.parse(text(await test.invoke('coordinator_read', { session_id: test.worker.id, view: 'steps' }))) as { items: unknown[]; nextSeq: number | null; complete: boolean }
  expect(page.complete).toBe(false)
  expect(page.nextSeq).toBeTypeOf('number')
  const last = JSON.parse(text(await test.invoke('coordinator_read', { session_id: test.worker.id, view: 'steps', from_seq: test.secondTurnSeq }))) as { complete: boolean }
  expect(last.complete).toBe(true)
  expect(text(await test.invoke('coordinator_read', { session_id: test.worker.id, view: 'events', from_seq: test.secondTurnSeq }))).toContain('"turn/start"')
  expect(text(await test.invoke('coordinator_read', { session_id: test.worker.id }))).toContain('转写第 1 集')
  expect(text(await test.invoke('coordinator_read', { session_id: test.worker.id, view: 'summary' }))).toContain('转写第 1 集')
  expect(text(await test.invoke('coordinator_read', { session_id: test.worker.id, view: 'events' }))).toContain('"session"')
  expect((await test.invoke('coordinator_read', { session_id: test.worker.id, view: 'steps', from_seq: -1 })).isError).toBe(true)
  const image = await test.invoke('coordinator_view_image', { session_id: test.worker.id, seq: test.resultSeq })
  expect(image.isError).toBe(false)
  expect(image.content).toEqual([{ type: 'text', text: `Image 0 of event ${test.resultSeq} in Session ${test.worker.id}.` }, frame])
  const missing = await test.invoke('coordinator_view_image', { session_id: test.worker.id, seq: test.resultSeq, index: 3 })
  expect(missing.isError).toBe(true)
  expect(text(missing)).toContain('has no image 3')
})
