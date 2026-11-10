import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as VideoInspect from '@deepseek-ai/dsh-tool-video-inspect'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, createUserMessage, ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type {} from '@deepseek-ai/dsh-tools/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import { contentListeningQuestion, createContentReviewVerifier, verifyContentListeningAnswer, type ContentListeningBinding } from '../src/content-review.ts'
import { installContentListeningState } from '../src/content-listening.ts'

const sessionId = 'content-listening-session'
const callId = ToolCallId('listen-to-current-output')
const question = contentListeningQuestion(resolve('episode-50.mp4'), 'a'.repeat(64), 84.125001)
const pass = question.options[0]!.label
const reject = question.options[1]!.label
const binding: ContentListeningBinding = { kind: 'listening', sessionId, callId,
  questionId: question.id, question: question.question }
const timedTool: ToolSchema = { name: 'ask_user_question', description: 'Ask the user a question.',
  parameters: { type: 'object', properties: { questions: { type: 'array' }, timeout: { type: 'integer' } } } }

function event<K extends SessionEvent['type']>(seq: number, type: K, data: SessionEvent<K>['data']): SessionEvent {
  return { type, seq: SessionSeq(seq), time: seq, data } as SessionEvent
}

const header = event(0, 'request/header', {
  header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, tools: [timedTool] }, reason: 'initial',
})

function asked(seq = 1, id = callId, value = question): SessionEvent {
  return event(seq, 'tool/call', { turn: 1, step: seq, callId: id, name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [value], timeout: 1 }) })
}

function answered(seq: number, selected: string[], options: {
  callId?: ToolCallId
  questionId?: string
  custom?: string
  isError?: boolean
} = {}): SessionEvent {
  return event(seq, 'tool/result', { turn: 1, step: seq,
    message: createToolResultMessage({ callId: options.callId ?? callId, isError: options.isError ?? false,
      content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: options.questionId ?? question.id, selected,
        ...(options.custom === undefined ? {} : { custom: options.custom }) }] }) }] }) })
}

function pending(seq = 2, id = callId): SessionEvent {
  return event(seq, 'tool/result', { turn: 1, step: seq,
    message: createToolResultMessage({ callId: id, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: id }) }] }) })
}

function lateAnswer(seq: number, selected: string[], options: { sourceCallId?: ToolCallId; bodyCallId?: ToolCallId } = {}): SessionEvent {
  return event(seq, 'user/message', createUserMessage({
    source: { kind: 'user-question-reply', callId: options.sourceCallId ?? callId, outcome: 'answered' },
    content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question',
      callId: options.bodyCallId ?? callId, questions: [question], answers: [{ id: question.id, selected }] }) }],
  }))
}

const verify = (events: SessionEvent[], value = binding, currentSession: string | undefined = sessionId) =>{
  verifyContentListeningAnswer(currentSession, events, value) }

describe('content listening evidence', () => {
  it('accepts the successful native answer to the exact current-output question', () => {
    expect(() =>{  verify([header, asked(), answered(2, [pass])]) }).not.toThrow()
  })

  it('rejects missing answers and a pass declaration pasted into a normal user message', () => {
    expect(() =>{  verify([]) }).toThrow('CONTENT_REVIEW_PENDING')
    const declaration = event(3, 'user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: question.id, selected: [pass] }] }) }] }))
    expect(() =>{  verify([header, asked(), pending(), declaration]) }).toThrow('CONTENT_REVIEW_PENDING')
    expect(() =>{  verify([header, asked(), answered(2, [pass], { isError: true })]) }).toThrow('CONTENT_REVIEW_PENDING')
  })

  it('waits through pending and accepts only the admitted formal late reply', () => {
    const waiting = [header, asked(), pending()]
    expect(() =>{  verify(waiting) }).toThrow('CONTENT_REVIEW_PENDING')
    expect(() =>{  verify([...waiting, lateAnswer(3, [pass])]) }).not.toThrow()
  })

  it.each(['source', 'body'] as const)('rejects a late reply naming a different %s call', (kind) => {
    const different = ToolCallId('different-question-call')
    const options = kind === 'source' ? { sourceCallId: different } : { bodyCallId: different }
    expect(() =>{  verify([header, asked(), pending(), lateAnswer(3, [pass], options)]) }).toThrow('CONTENT_REVIEW_PENDING')
  })

  it('does not let an old pass override a newer rejection for the same output', () => {
    const newer = ToolCallId('listen-again-to-current-output')
    expect(() =>{  verify([header, asked(), answered(2, [pass]), asked(3, newer),
      answered(4, [reject], { callId: newer })]) }).toThrow('CONTENT_REVIEW_PENDING')
  })

  it('does not let an old pass override an unanswered newer question for the same output', () => {
    const newer = ToolCallId('listen-again-to-current-output')
    expect(() =>{  verify([header, asked(), answered(2, [pass]), asked(3, newer), pending(4, newer)]) })
      .toThrow('CONTENT_REVIEW_PENDING')
  })

  it('keeps a valid current-output answer separate from a different output rejection', () => {
    const other = contentListeningQuestion(resolve('episode-51.mp4'), 'b'.repeat(64), 12)
    const otherCall = ToolCallId('listen-to-other-output')
    expect(() =>{  verify([header, asked(), answered(2, [pass]), asked(3, otherCall, other),
      answered(4, [reject], { callId: otherCall, questionId: other.id })]) }).not.toThrow()
    expect(() =>{  verify([header, asked(1, callId, other), answered(2, [pass], { questionId: other.id })]) })
      .toThrow('CONTENT_REVIEW_PENDING')
  })

  it('rejects a different initiating Session or question identity', () => {
    const events = [header, asked(), answered(2, [pass])]
    expect(() =>{  verify(events, binding, 'another-session') }).toThrow('CONTENT_REVIEW_PENDING')
    expect(() =>{  verifyContentListeningAnswer(undefined, events, binding) }).toThrow('CONTENT_REVIEW_PENDING')
    expect(() =>{  verify(events, { ...binding, questionId: 'another-question' }) }).toThrow('CONTENT_REVIEW_PENDING')
    expect(() =>{  verify(events, { ...binding, question: `${question.question} changed` }) }).toThrow('CONTENT_REVIEW_PENDING')
  })

  it.each([
    { name: 'skipped', selected: [] },
    { name: 'rejected', selected: [reject] },
    { name: 'custom pass text', selected: [], custom: pass },
    { name: 'pass with an unresolved custom note', selected: [pass], custom: '末句发音仍需核对' },
    { name: 'multiple options', selected: [pass, reject] },
  ])('does not treat $name as completed passing listening', ({ selected, custom }) => {
    expect(() =>{  verify([header, asked(), answered(2, selected, custom === undefined ? {} : { custom })]) })
      .toThrow('CONTENT_REVIEW_PENDING')
  })

  it('rejects malformed question arguments and ignores untrusted non-answer tool text', () => {
    const malformed = event(1, 'tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: '{' })
    expect(() =>{  verify([malformed]) }).toThrow('CONTENT_REVIEW_PENDING')
    const notAnswer = event(2, 'tool/result', { turn: 1, step: 2,
      message: createToolResultMessage({ callId, isError: false, content: [
        { type: 'text', text: 'ordinary output' }, { type: 'text', text: '{}' },
      ] }) })
    expect(() =>{  verify([asked(), notAnswer]) }).toThrow('CONTENT_REVIEW_PENDING')
    expect(() =>{  verify([asked(), answered(2, [pass], { questionId: 'other' })]) }).toThrow('CONTENT_REVIEW_PENDING')
  })

  it('checks the actual initiating Session for both observation and listening verification', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    try {
      installContentListeningState(ctx)
      const signal = new AbortController().signal
      const missing = createContentReviewVerifier(ctx, undefined, signal)
      await expect(missing(binding)).rejects.toThrow('当前会话')
      await expect(missing({ kind: 'video', mediaPath: '/video.mp4', mediaSha256: 'a'.repeat(64),
        inspectionPath: '/report.json', inspectionSha256: 'b'.repeat(64), sessionId, reviewId: 'review' }))
        .rejects.toThrow('SOURCE_QA_SESSION')
      const session = ctx.sessions.create(SessionId(sessionId))
      await expect(createContentReviewVerifier(ctx, session, signal)(binding)).rejects.toThrow('真实已完成试听回答')
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question',
        arguments: JSON.stringify({ questions: [question] }) })
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false,
        content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: question.id, selected: [pass] }] }) }] }) },
      { surfaceOp: 'append' })
      await expect(createContentReviewVerifier(ctx, session, signal)(binding)).resolves.toBeUndefined()
      const noState = vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValueOnce(undefined)
      await expect(createContentReviewVerifier(ctx, session, signal)(binding)).rejects.toThrow('试听状态服务')
      noState.mockRestore()
      const video = vi.spyOn(VideoInspect, 'verifyVideoObservationEvidence').mockResolvedValueOnce(undefined)
      const videoBinding = { kind: 'video' as const, mediaPath: '/video.mp4', mediaSha256: 'a'.repeat(64),
        inspectionPath: '/report.json', inspectionSha256: 'b'.repeat(64), sessionId, reviewId: 'review' }
      await expect(createContentReviewVerifier(ctx, session, signal)(videoBinding)).resolves.toBeUndefined()
      expect(video).toHaveBeenCalledWith(ctx, session, videoBinding, signal)
      video.mockRestore()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects malformed external event data and non-text or missing answer content', () => {
    const call = { type: 'tool/call', data: { name: 'ask_user_question', callId,
      arguments: { questions: [question] } } }
    for (const content of [undefined, [{ type: 'image', data: 'not-an-answer' }]]) {
      expect(() =>{  verifyContentListeningAnswer(sessionId, [
        { type: 'user/message', data: null },
        { type: 'tool/call', data: { name: 'ask_user_question', callId, arguments: '{}' } },
        call, { type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content } } },
      ], binding) }).toThrow('CONTENT_REVIEW_PENDING')
    }
  })

  it('ignores non-listening questions and malformed options instead of creating acceptance', () => {
    for (const value of [null, { ...question, id: 'ordinary-question' }, { ...question, options: [] }]) {
      expect(() =>{  verifyContentListeningAnswer(sessionId, [{ type: 'tool/call', data: {
        name: 'ask_user_question', callId, arguments: { questions: [value] },
      } }], binding) }).toThrow('CONTENT_REVIEW_PENDING')
    }
  })
})
