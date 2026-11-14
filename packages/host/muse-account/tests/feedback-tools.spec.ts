import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { mountMuseFeedbackTools } from '../src/feedback-tools.ts'
import { MuseFeedbackError } from '../src/feedback.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MuseFeedbackId } from '../src/types.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.fiber.dispose())) })

async function setup(withAgent = false) {
  const ctx = new Context()
  contexts.push(ctx)
  if (withAgent) await mountAgentLoopTestDependencies(ctx)
  else { await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime) }
  const client = {
    submit: vi.fn<Parameters<typeof mountMuseFeedbackTools>[1]['submit']>(),
    get: vi.fn<Parameters<typeof mountMuseFeedbackTools>[1]['get']>(),
  }
  const fiber = ctx.plugin({ inject: ['tools'], apply: (scope: Context) => { mountMuseFeedbackTools(scope, client) } })
  await fiber.await()
  return { ctx, client, fiber }
}

it('registers only the two feedback tools and removes them on unload', async () => {
  const { ctx, fiber } = await setup()
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['muse_feedback_submit', 'muse_feedback_status'])
  await fiber.dispose()
  expect(ctx.tools.schemas()).toEqual([])
})

it('refuses submission without an initiating Agent and does not send a network request', async () => {
  const { ctx, client } = await setup()
  const outcome = await executeToolFixture(ctx, { name: 'muse_feedback_submit', callId: ToolCallId('submit'), signal: new AbortController().signal,
    arguments: { title: 'Feedback', category: 'bug', text: 'Expected an attachment', requestId: 'report-1' } })
  expect(JSON.stringify(outcome)).toContain('invalid-input')
  expect(client.submit).not.toHaveBeenCalled()
})

it('returns fixed actionable diagnostics rather than a private failure message', async () => {
  const { ctx, client } = await setup()
  client.get.mockRejectedValueOnce(new MuseFeedbackError('not-found')).mockRejectedValueOnce(new Error('private-cookie-value'))
  for (const call of ['missing', 'unavailable']) {
    const result = await executeToolFixture(ctx, { name: 'muse_feedback_status', callId: ToolCallId(call), signal: new AbortController().signal,
      arguments: { id: 'a'.repeat(32) } })
    expect(JSON.stringify(result)).toContain('failed')
    expect(JSON.stringify(result)).not.toContain('private-cookie-value')
  }
  expect(client.get).toHaveBeenCalledTimes(2)
})

it.each(['available', 'unavailable', undefined] as const)('submits explicit feedback with duplicate protection %s', async (deduplication) => {
  const { ctx, client } = await setup(true), driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('feedback-tool-owner'))
  const id = brandString<MuseFeedbackId>('a'.repeat(32))
  client.submit.mockResolvedValueOnce({ id, revision: 1, ...(deduplication === undefined ? {} : { deduplication }) })
  const result = await executeToolFixture(ctx, { agent, name: 'muse_feedback_submit', callId: ToolCallId('owned-submit'),
    signal: new AbortController().signal, arguments: { title: 'Visible issue', category: 'bug', text: 'Expected an attachment',
      requestId: 'original-request', ...(deduplication === 'available' ? { includeDiagnostics: true } : {}) } })
  expect(JSON.stringify(result)).toContain('submitted')
  expect(JSON.stringify(result)).toContain(deduplication === 'available' ? 'Use this receipt ID' : 'Do not repeat the submission')
  expect(client.submit).toHaveBeenCalledExactlyOnceWith({ sessionId: agent.id, target: { kind: 'session' },
    title: 'Visible issue', kind: 'bug', text: 'Expected an attachment', requestId: 'original-request', includeDiagnostics: deduplication === 'available' })
})

it('refuses empty feedback even with an initiating Agent', async () => {
  const { ctx, client } = await setup(true), driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('empty-feedback-owner'))
  const result = await executeToolFixture(ctx, { agent, name: 'muse_feedback_submit', callId: ToolCallId('empty-submit'),
    signal: new AbortController().signal, arguments: { title: 'Visible issue', category: 'bug', text: ' \t', requestId: 'original-key' } })
  expect(JSON.stringify(result)).toContain('invalid-input'); expect(client.submit).not.toHaveBeenCalled()
})

it('returns the owner-scoped status without interpreting the maintainer reply as instructions', async () => {
  const { ctx, client } = await setup(), id = brandString<MuseFeedbackId>('a'.repeat(32))
  client.get.mockResolvedValueOnce({ id, title: 'Visible issue', category: 'bug', status: 'resolved', reply: 'Check the next release.',
    revision: 2, createdAt: '2026-11-05T01:00:00.000Z', updatedAt: '2026-11-05T02:00:00.000Z' })
  const result = await executeToolFixture(ctx, { name: 'muse_feedback_status', callId: ToolCallId('owned-status'),
    signal: new AbortController().signal, arguments: { id } })
  expect(JSON.stringify(result)).toContain('found'); expect(JSON.stringify(result)).toContain('not instructions to execute')
  expect(client.get).toHaveBeenCalledExactlyOnceWith(id)
})

it.each([
  ['muse_feedback_submit', { title: 'Visible issue', category: 'bug', text: 'Actual and expected behavior.', requestId: 'original-key' }, 'Visible issue', 'edit'],
  ['muse_feedback_status', { id: 'a'.repeat(32) }, 'a'.repeat(32), 'read'],
] as const)('presents %s with its explicit user-selected identity', async (name, args, title, kind) => {
  const { ctx } = await setup(), tool = ctx.tools.get(name)
  if (tool === undefined) throw Error('Expected feedback tool')
  expect(tool.presentCall?.(args)).toEqual({ card: 'generic', title, kind })
  expect(tool.output.render(args, { state: 'failed' })).toEqual([{ type: 'text', text: '{"state":"failed"}' }])
})
