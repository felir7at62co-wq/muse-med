/** Opt-in local-daemon receipt reconciliation and sourced recall through the real tool runtime. */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { Config, LocalHindsight } from '../src/hindsight.ts'
import * as Hindsight from '../src/hindsight.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

const receiptFile = process.env.MUSE_HINDSIGHT_LOCAL_E2E_REQUESTS
const cancellations: AbortController[] = []
afterEach(() => { for (const controller of cancellations.splice(0)) controller.abort() })

const absolutePath = z.string().refine(isAbsolute)
const receiptSchema = z.array(z.object({
  label: z.string().regex(/^[a-z0-9-]+$/), connectionFile: absolutePath, cwd: absolutePath.optional(),
  scope: z.enum(['user', 'project']), key: z.string(), content: z.string(), source: z.string(),
  operation_id: z.uuid(), query: z.string(),
})).min(1)
const outputSchema = z.object({
  state: z.string(), initialized: z.boolean().optional(), operation_id: z.uuid().optional(),
  reused: z.boolean().optional(), omitted_unsourced: z.number().int().nonnegative().optional(),
  memories: z.array(z.object({ id: z.string(), text: z.string(), key: z.string().optional(), source: z.string().optional() })).optional(),
})

async function receipts() {
  const file = absolutePath.parse(receiptFile)
  return { evidence: dirname(file), jobs: receiptSchema.parse(JSON.parse(await readFile(file, 'utf8'))) }
}

it.runIf(receiptFile !== undefined)('reconciles original authorized extractions and semantically recalls their sources', async () => {
  const { evidence, jobs } = await receipts()
  const controller = new AbortController()
  cancellations.push(controller)
  const observations: object[] = []
  for (const job of jobs) {
    const client = new LocalHindsight(Config({ connectionFile: job.connectionFile, requestTimeoutMs: 120000, recallTimeoutMs: 15000 }))
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)])
    // An absent original receipt requires investigation, never a replacement write from this test.
    for (;;) {
      signal.throwIfAborted()
      const operation = outputSchema.parse(JSON.parse(await client.request({ action: 'operation', scope: job.scope,
        operation_id: job.operation_id }, job.cwd, signal)))
      observations.push({ label: job.label, phase: 'operation', ...operation })
      await writeFile(join(evidence, 'local-e2e-reconciled.json'), JSON.stringify(observations, null, 2) + '\n')
      if (operation.state === 'completed') break
      if (operation.state === 'failed' || operation.state === 'cancelled' || operation.state === 'not_found') {
        throw new Error(`Original local retain ${job.operation_id} is ${operation.state}; reconcile without submitting another write`)
      }
      await delay(5000, undefined, { signal })
    }
    const retained = outputSchema.parse(JSON.parse(await client.request({ action: 'retain', scope: job.scope, key: job.key,
      content: job.content, source: job.source, operation_id: job.operation_id }, job.cwd, controller.signal)))
    observations.push({ label: job.label, phase: 'retain', ...retained })
    expect(retained).toMatchObject({ state: 'completed', operation_id: job.operation_id, reused: true })
    const recall = outputSchema.parse(JSON.parse(await client.request({ action: 'recall', scope: job.scope, query: job.query }, job.cwd, controller.signal)))
    observations.push({ label: job.label, phase: 'recall', ...recall })
    expect(recall.state).toBe('ready')
    expect(recall.memories?.some(memory => memory.source === job.source && memory.key === job.key)).toBe(true)
    expect(recall.memories?.every(memory => memory.source?.trim())).toBe(true)
    const status = outputSchema.parse(JSON.parse(await client.request({ action: 'status', scope: job.scope }, job.cwd, controller.signal)))
    observations.push({ label: job.label, phase: 'status', ...status })
    expect(status.initialized).toBe(true)
    await writeFile(join(evidence, 'local-e2e-reconciled.json'), JSON.stringify(observations, null, 2) + '\n')
  }
}, 600000)

it.runIf(receiptFile !== undefined)('logs actual local recalls and exposes sourced JSON to the next model request', async () => {
  const { evidence, jobs } = await receipts()
  for (const job of jobs.filter(job => job.scope === 'user')) {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Llm)
      await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
      await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(Hindsight, Config({ connectionFile: job.connectionFile, recallTimeoutMs: 15000 }))
      const adapter = new MockAdapter([
        toolCallResponse('local-memory-query', 'hindsight_memory', { action: 'recall', scope: 'user', query: job.query }),
        textResponse('已取得本机历史记忆及来源，以当前用户要求为准。'),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      const cwd = jobs.find(other => other.connectionFile === job.connectionFile && other.scope === 'project')?.cwd ?? evidence
      const agent = await ctx.agentLoop.create(SessionId('hindsight-local-' + job.label), { provider: 'mock', model: 'mock' }, { cwd })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: job.query }] }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
      const events = agent.session.snapshotEvents()
      const calls = events.filter(event => event.type === 'tool/call')
      const results = events.filter(event => event.type === 'tool/result')
      expect(calls).toHaveLength(1)
      expect(results).toHaveLength(1)
      const result = results[0]!
      expect(result.data.message.isError).toBeFalsy()
      const text = result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const recalled = outputSchema.parse(JSON.parse(text))
      expect(recalled.memories?.some(memory => memory.source === job.source && memory.key === job.key)).toBe(true)
      expect(recalled.memories?.every(memory => memory.source?.trim())).toBe(true)
      expect(JSON.stringify(adapter.requests[1]!.messages)).toContain(job.source)
      await writeFile(join(evidence, 'registered-tool-' + job.label + '.json'), JSON.stringify({
        session: agent.session.header, events, requestCount: adapter.requests.length,
        modelVisibleMemory: recalled, nextRequestMessages: adapter.requests[1]!.messages,
      }, null, 2) + '\n', { mode: 0o600 })
    } finally { await ctx.fiber.dispose() }
  }
}, 120000)
