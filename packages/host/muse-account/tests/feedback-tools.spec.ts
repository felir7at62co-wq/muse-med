import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { mountMuseFeedbackTools } from '../src/feedback-tools.ts'
import { MuseFeedbackError } from '../src/feedback.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
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
