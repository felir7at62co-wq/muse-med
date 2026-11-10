import { Context } from '@deepseek-ai/cordis'
import Sessions, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
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
  session.append('tool/result', { turn: 1, step: 1, meta: result.meta,
    message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) }, { surfaceOp: 'append' })
  expect(sourceQaStateOf(read, session).ocr).toEqual({ 'A-ocr.json': { path: 'A.mp4', source_version: 'A', sha256: 'a'.repeat(64) } })
  const restored = Session.create(session.id, session.snapshotEvents(), session.header)
  expect(sourceQaStateOf(read, restored).ocr).toEqual(sourceQaStateOf(read, session).ocr)
})
