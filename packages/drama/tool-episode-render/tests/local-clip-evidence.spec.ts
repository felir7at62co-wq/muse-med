/** Local-edit authority comes from the actual completed tool, in the current Session. */
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it } from 'vitest'
import { createLocalClipRepairVerifier } from '../src/local-clip-evidence.ts'

const binding = { project: resolve('project'), episode: '32',
  original: { path: resolve('project', 'original.mp4'), sha256: 'a'.repeat(64) },
  output: { path: resolve('project', 'repair.mp4'), sha256: 'b'.repeat(64) },
  startMs: 1000, endMs: 3000, durationSeconds: 2 }

it('accepts only the exact successful local edit from the native tool in this Session', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  try {
    const verify = await createLocalClipRepairVerifier(ctx)
    const session = ctx.sessions.create(SessionId('local-clip-evidence'))
    const signal = new AbortController().signal
    let sequence = 0
    const record = (name: string, isError = false, hasBody = true) => {
      sequence += 1
      const callId = ToolCallId('local-clip-' + String(sequence))
      session.append('tool/call', { turn: 1, step: sequence, callId, name, arguments: '{}' })
      session.append('tool/result', { turn: 1, step: sequence,
        message: createToolResultMessage({ callId, isError, content: [{ type: 'text', text: JSON.stringify(binding) }] }),
        meta: hasBody ? { [TOOL_BODY_META_KEY]: binding } : binding }, { surfaceOp: 'append' })
    }
    const verifyBinding = (value = binding) => { verify(session, value, signal) }

    record('another_tool')
    record('drama_repair_clip', true)
    record('drama_repair_clip', false, false)
    expect(verifyBinding).toThrow('SOURCE_LOCAL_CLIP')
    record('drama_repair_clip')
    expect(verifyBinding).not.toThrow()
    expect(() => { verifyBinding({ ...binding, startMs: 900 }) }).toThrow('SOURCE_LOCAL_CLIP')
    expect(() => { verifyBinding({ ...binding, durationSeconds: 3 }) }).toThrow('SOURCE_LOCAL_CLIP')
    expect(() => { verifyBinding({ ...binding, original: { ...binding.original, sha256: 'c'.repeat(64) } }) })
      .toThrow('SOURCE_LOCAL_CLIP')
    const child = ctx.sessions.fork(session, undefined, SessionId('local-clip-evidence-child'))
    expect(() => { verify(child, binding, signal) }).toThrow('SOURCE_LOCAL_CLIP')
  } finally { await ctx.fiber.dispose() }
})

it('also authenticates a completed nested clip tool in the initiating Session', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  try {
    const verify = await createLocalClipRepairVerifier(ctx)
    const session = ctx.sessions.create(SessionId('local-clip-nested'))
    const signal = new AbortController().signal
    const rootCallId = ToolCallId('nested-clip-program')
    const dispatch = { rootCallId, parentCallId: rootCallId, subCallId: ToolCallId('nested-clip-program:ptc:1'),
      name: 'drama_repair_clip', arguments: {} }
    const complete = { ...dispatch, isError: false, content: [], meta: { [TOOL_BODY_META_KEY]: binding } }
    const verifyBinding = () => { verify(session, binding, signal) }
    session.append('tool/ptc-dispatch', complete)
    expect(verifyBinding).toThrow('SOURCE_LOCAL_CLIP')
    session.append('tool/ptc-dispatch-start', dispatch)
    session.append('tool/ptc-dispatch', { ...complete, name: 'other_tool' })
    expect(verifyBinding).toThrow('SOURCE_LOCAL_CLIP')
    session.append('tool/ptc-dispatch-start', dispatch)
    session.append('tool/ptc-dispatch', { ...complete, isError: true })
    expect(verifyBinding).toThrow('SOURCE_LOCAL_CLIP')
    session.append('tool/ptc-dispatch-start', dispatch)
    session.append('tool/ptc-dispatch', complete)
    expect(verifyBinding).not.toThrow()
    const child = ctx.sessions.fork(session, undefined, SessionId('local-clip-nested-child'))
    expect(() => { verify(child, binding, signal) }).toThrow('SOURCE_LOCAL_CLIP')
  } finally { await ctx.fiber.dispose() }
})
