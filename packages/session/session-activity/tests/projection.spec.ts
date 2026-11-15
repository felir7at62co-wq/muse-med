/** The `sessionActivity` fold over events appended to a real Session. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { initialActivity, sessionActivityProjectionDefinition } from '../src/projection.ts'
import type { SessionActivityState } from '../src/projection.ts'

async function session(): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx.sessions.create(SessionId('watched'))
}

function fold(events: readonly SessionEvent[]): SessionActivityState {
  return events.reduce((state, event) => sessionActivityProjectionDefinition.apply(state, event), initialActivity())
}

const image = { type: 'image' as const, attachment: { attachmentId: AttachmentId('frame'), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } }

function call(log: Session, id: string, name: string, args = '{}'): SessionEvent {
  return log.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(id), name, arguments: args })
}

function result(log: Session, id: string, isError: boolean, content: Parameters<typeof createToolResultMessage>[0]['content']): SessionEvent {
  return log.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(id), content, isError }) }, { surfaceOp: 'append' })
}

describe('sessionActivity fold', () => {
  it('counts calls, failures, images, deliverables, jobs and tokens', async () => {
    const log = await session()
    const events = [
      log.append('turn/start', { turn: 1 }),
      log.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'look' }, image], source: { kind: 'user' } }), { surfaceOp: 'append' }),
      log.append('assistant/message', {
        turn: 1, step: 1, stream: [], usage: { inputTokens: 21_000, outputTokens: 600, totalTokens: 21_600 },
        message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' }),
      call(log, 'a', 'video_inspect', '{"path":"ep1.mp4"}'),
      result(log, 'a', false, [{ type: 'text', text: 'frames' }, image, { ...image, offloaded: true }]),
      call(log, 'b', 'coordinator_report'),
      result(log, 'b', true, [{ type: 'text', text: 'Error: invalid arguments:\n No current assignment' }]),
      log.append('deliverables/presented', { turn: 1, callId: ToolCallId('p'), files: [{ path: '/work/ep001.md' }] }),
      log.append('deliverables/presented', { turn: 1, callId: ToolCallId('q'), files: [] }),
      log.append('job/registered', { jobId: JobId('j1'), owner: SessionId('watched'), kind: 'bash', label: 'ffmpeg', startedAt: 1 }),
      log.append('job/registered', { jobId: JobId('j2'), owner: SessionId('watched'), kind: 'bash', label: 'asr', startedAt: 1 }),
      log.append('job/settled', { jobId: JobId('j1'), owner: SessionId('watched'), kind: 'bash', label: 'ffmpeg', startedAt: 1, finishedAt: 2, status: 'completed', cause: 'producer', producerReported: true }),
      log.append('job/settled', { jobId: JobId('j2'), owner: SessionId('watched'), kind: 'bash', label: 'asr', startedAt: 1, finishedAt: 2, status: 'failed', cause: 'producer', producerReported: true }),
    ]
    const [, , , inspect, , report, , presented] = events
    if (inspect === undefined || report === undefined || presented === undefined) throw new Error('Expected the appended events')
    const state = fold(events)
    expect(state).toMatchObject({
      openTurn: 1, turns: 0, images: 2, errors: 2, pendingCalls: {},
      files: { '/work/ep001.md': presented.seq },
      jobs: { running: 0, completed: 1, failed: 1 },
      inputTokens: 21_000, outputTokens: 600, contextTokens: 21_000,
      lastError: { text: 'job bash failed: asr' },
    })
    expect(state.tools).toEqual({
      video_inspect: { calls: 1, errors: 0, lastSeq: inspect.seq, lastArguments: '{"path":"ep1.mp4"}' },
      coordinator_report: { calls: 1, errors: 1, lastSeq: report.seq, lastArguments: '{}' },
    })
    expect(fold(events.slice(0, 7)).lastError?.text).toBe('coordinator_report: Error: invalid arguments: No current assignment')
  })

  it('closes turns, records failures and drops unanswered calls', async () => {
    const log = await session()
    const state = fold([
      log.append('turn/start', { turn: 1 }),
      call(log, 'orphan', 'bash'),
      log.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'Muse model request failed.', code: 'UNKNOWN' } } }),
      result(log, 'orphan', true, [{ type: 'text', text: 'late' }, image]),
    ])
    expect(state).toMatchObject({ openTurn: null, turns: 1, pendingCalls: {}, errors: 2, lastTurnEnd: { kind: 'error', text: 'Muse model request failed.' } })
    expect(state.tools.bash?.errors).toBe(0)
    expect(state.lastError?.text).toBe('tool: late')
  })

  it('keeps references for events it does not count and ignores prototype-named ids', async () => {
    const log = await session()
    const start = initialActivity()
    const unanswered = result(log, 'constructor', false, [{ type: 'text', text: 'x' }])
    expect(sessionActivityProjectionDefinition.apply(start, unanswered)).toBe(start)
    const text = log.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(sessionActivityProjectionDefinition.apply(start, text)).toBe(start)
    const step = log.append('step/start', { turn: 1, step: 1 })
    expect(sessionActivityProjectionDefinition.apply(start, step)).toBe(start)
    const silent = log.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    expect(sessionActivityProjectionDefinition.apply(start, silent)).toBe(start)
    const completed = fold([log.append('turn/start', { turn: 2 }), log.append('turn/end', { turn: 2, reason: { kind: 'completed' } })])
    expect(completed).toMatchObject({ errors: 0, lastTurnEnd: { kind: 'completed', text: '' } })
    const long = fold([call(log, 'toString', 'toString', 'x'.repeat(400))])
    expect(long.tools.toString?.lastArguments).toHaveLength(160)
  })

  it('validates its persisted state', () => {
    expect(sessionActivityProjectionDefinition.stateSchema.parse(initialActivity())).toEqual(initialActivity())
    expect(() => sessionActivityProjectionDefinition.stateSchema.parse({ ...initialActivity(), images: -1 })).toThrow()
  })
})
