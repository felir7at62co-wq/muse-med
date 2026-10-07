import { createServer } from 'node:http'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

afterEach(() => vi.unstubAllEnvs())

function sse(events: readonly object[]): string {
  return events.map(event => `event: ${'type' in event ? event.type : 'message'}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

it('keeps the task with first-step context for a gateway reading the last user message', async () => {
  const task = 'Use lookup_code with code blue.'
  const background = 'Current runtime context: the workspace is ready.'
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    const messages = requests.at(-1)?.messages as { role: string; content: string | { type: string; text?: string }[] }[]
    const lastUser = messages.findLast(message => message.role === 'user')
    const lastText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : lastUser?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    const first = requests.length === 1 && lastText.includes(task)
    const events = first ? [
      { type: 'message_start', message: { id: 'msg_tool', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup_code', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"code":"blue"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ] : [
      { type: 'message_start', message: { id: 'msg_answer', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: requests.length === 1 ? '有什么可以帮助你？' : 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sse(events))
  })().catch(() => { response.writeHead(500); response.end() }) })
  const ctx = new Context()
  let cleanup: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    cleanup ??= (async () => {
      try {
        await ctx.fiber.dispose()
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => { resolve() })
          server.closeAllConnections()
        })
      }
    })()
    return cleanup
  }
  onTestFinished(dispose)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener')
    vi.stubEnv('PI_CLAUDE_LOOP_TEST_KEY', 'synthetic-test-key')
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmPiAi, { providers: { 'claude-gateway-test': {
      apiKeyEnv: 'PI_CLAUDE_LOOP_TEST_KEY',
      api: 'anthropic-messages',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: 'claude-test' }],
    } } })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.on('agent/pre-step', async ({ turn, step }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || turn !== 1 || step !== 1) return decision
      return { ...decision, messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: background }], source: { kind: 'runtime-context' },
      })] }
    })
    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'lookup_code',
      description: 'Look up a short code.',
      parameters: { code: { type: 'string' } },
      async execute(args) {
        executions++
        return [{ type: 'text', text: `Resolved ${String(args.code)}` }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('anthropic-first-turn'), {
      provider: 'claude-gateway-test', model: 'claude-test',
    })
    const idle = new Promise<void>((resolve) => {
      const off = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { off(); resolve() }
      })
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    await idle

    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ model: 'claude-test', tools: [{ name: 'lookup_code' }] })
    const firstUsers = (requests[0]?.messages as { role: string; content: unknown }[]).filter(message => message.role === 'user')
    expect(firstUsers).toHaveLength(1)
    expect(JSON.stringify(firstUsers[0]?.content)).toContain(task)
    expect(JSON.stringify(firstUsers[0]?.content)).toContain(background)
    expect(executions).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'completed' } },
    })
  } finally {
    await dispose()
  }
})
