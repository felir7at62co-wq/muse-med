import { Context } from '@deepseek-ai/cordis'
import Sessions, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it, onTestFinished } from 'vitest'
import { installSourceQaState, sourceQaStateOf } from '../src/source-qa-state.ts'

it.each(['content', 'value'] as const)('records only the true body after post-execute %s replacement', async (mode) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const read = await installSourceQaState(ctx)
  const session = ctx.sessions.create(SessionId(`source-qa-pipeline-${mode}`))
  const actual = { path: 'A.mp4', source_version: 'A', raw_json_path: 'A-ocr.json', raw_json_sha256: 'a'.repeat(64) }
  const fake = { path: 'B.mp4', source_version: 'B', raw_json_path: 'B-ocr.json', raw_json_sha256: 'b'.repeat(64) }
  ctx.tools.register(defineTool({ name: 'video_ocr', description: 'Offline synthetic OCR.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true, render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (_args, value) => value === JSON.stringify(actual) ? actual : fake }, execute: async () => JSON.stringify(actual),
  }))
  ctx.on('tools/post-execute', async () => mode === 'content'
    ? { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(fake) }] }
    : { kind: 'accept', value: JSON.stringify(fake) })
  const callId = ToolCallId('original')
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'video_ocr', arguments: '{}' })
  const result = await executeToolFixture(ctx, { signal: new AbortController().signal, callId, name: 'video_ocr', arguments: {} })
  expect(result.isError).toBe(false)
  session.append('tool/result', { turn: 1, step: 1, ...(result.meta === undefined ? {} : { meta: result.meta }),
    message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) }, { surfaceOp: 'append' })
  expect(sourceQaStateOf(read, session).ocr).toEqual({ 'A-ocr.json': { path: 'A.mp4', source_version: 'A', sha256: 'a'.repeat(64) } })
  const restored = Session.create(session.id, session.snapshotEvents(), session.header)
  expect(sourceQaStateOf(read, restored).ocr).toEqual(sourceQaStateOf(read, session).ocr)
})

it('keeps ignored event state stable and clears failed OCR without issuing its supplied evidence', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  const read = await installSourceQaState(ctx)
  const session = ctx.sessions.create(SessionId('source-qa-failed-result'))
  const before = read(session)
  const unrelated = ToolCallId('unrelated-call')
  session.append('tool/call', { turn: 1, step: 1, callId: unrelated, name: 'present', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: unrelated,
    content: [{ type: 'text', text: 'unrelated result' }], isError: false }) }, { surfaceOp: 'append' })
  expect(read(session)).toBe(before)
  expect(sourceQaStateOf(read, session)).toBe(before.issuance)
  const callId = ToolCallId('failed-ocr')
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'video_ocr', arguments: '{}' })
  const pending = read(session)
  expect(pending).not.toBe(before)
  expect(pending.issuance.native).toEqual({ [callId]: 'video_ocr' })
  session.append('tool/result', { turn: 1, step: 1, meta: { [TOOL_BODY_META_KEY]: {
    path: 'source.mp4', source_version: 'source-version', raw_json_path: 'untrusted-ocr.json', raw_json_sha256: 'a'.repeat(64),
  } }, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'OCR failed' }], isError: true }) }, { surfaceOp: 'append' })
  expect(read(session)).not.toBe(pending)
  expect(sourceQaStateOf(read, session)).toEqual(before.issuance)
  expect(before.issuance.native).toEqual({})
  expect(pending.issuance.native).toEqual({ [callId]: 'video_ocr' })
})
