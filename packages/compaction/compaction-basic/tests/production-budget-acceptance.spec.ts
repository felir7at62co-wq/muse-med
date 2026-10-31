/** Real-loop and JSONL acceptance of Muse's published working-context policy. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createMessage, createSystemMessage, createToolResultMessage, createUserMessage, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../src/config.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const routes = [
  { provider: 'muse-cloud-deepseek-official', model: 'deepseek-v4.1-flash-261017', window: 1_000_000, output: 393_216 },
  { provider: 'muse-cloud-yunying', model: 'gpt-6.1-sol', window: 1_050_000, output: 128_000 },
  { provider: 'muse-cloud-yunying', model: 'gemini-3.1-pro', window: 1_048_576, output: 65_536 },
] as const
type Route = typeof routes[number]

/** Find the real preset's single compaction configuration without executing YAML tags. */
function compactionConfig(value: unknown): BasicCompactionConfig | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = compactionConfig(entry)
      if (found !== undefined) return found
    }
  } else if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    if (row.id === 'compaction-basic' && row.config !== null && typeof row.config === 'object') {
      const config = row.config as Record<string, unknown>
      if (typeof config.adaptiveBudget !== 'boolean' || typeof config.workingTokenLimit !== 'number'
        || typeof config.thresholdRatio !== 'number' || typeof config.headroomTokens !== 'number'
        || typeof config.retainTokens !== 'number' || typeof config.maxTokens !== 'number') throw new Error('preset policy is incomplete')
      return { adaptiveBudget: config.adaptiveBudget, workingTokenLimit: config.workingTokenLimit,
        thresholdRatio: config.thresholdRatio, headroomTokens: config.headroomTokens,
        retainTokens: config.retainTokens, maxTokens: config.maxTokens }
    }
    return compactionConfig(row.config)
  }
  return undefined
}

async function readPolicy(relative: string): Promise<BasicCompactionConfig> {
  const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: (source: string) => source,
  })])
  const data: unknown = load(await readFile(new URL(`../../../../${relative}`, import.meta.url), 'utf8'), { schema })
  const policy = compactionConfig(data)
  if (policy === undefined) throw new Error(`missing compaction policy: ${relative}`)
  return policy
}

const policy = await readPolicy('apps/desktop-host/config/defaults.cordis.patch.yml')

/** Only the LLM boundary is scripted; compaction, tools, events and storage stay real. */
class AcceptanceAdapter extends LlmAdapter {
  readonly ordinary: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []
  readonly summaryEntered = Promise.withResolvers<undefined>()
  summaryMode: 'success' | 'error' | 'wait' = 'success'
  toolNext = true
  onOrdinary: (() => void) | undefined

  constructor(readonly route: Route) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: this.route.window }, defaultMaxTokens: this.route.output })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'compaction') {
      this.summaries.push(options)
      this.summaryEntered.resolve(undefined)
      if (this.summaryMode === 'error') throw new LlmError('fixture summary unavailable', 'SERVER')
      if (this.summaryMode === 'wait') {
        const signal = options.signal
        if (signal === undefined) throw new Error('summary signal missing')
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('cancelled')); return }
          signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
        })
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CHECKPOINT_KEEP_RULE: preserve whole episodes; continue the pending review.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.ordinary.push(options)
    this.onOrdinary?.()
    if (this.toolNext) {
      this.toolNext = false
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('review-once'), name: 'review', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'REVIEW_COMPLETE' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A balanced closed history containing Chinese text and an older tool result. */
function makeHistory(route: Route, header: EpochHeader, characters: number, usage?: number): Session {
  const session = Session.create(SessionId('seed-only'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage('You are an AI agent powered by DeepSeek Harness.') }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `OLD_CHINESE_HISTORY: ${'剧'.repeat(characters)}` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('request/header', { header, reason: 'initial' })
  const callId = ToolCallId('history-read')
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({
    role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'history_read', arguments: '{}' }],
    source: { kind: 'model', provider: route.provider, model: route.model },
  }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'history_read', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: `OLD_TOOL_RESULT: ${'旧素材'.repeat(20_000)}` }], isError: false }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', { turn: 1, step: 2, stream: [],
    ...(usage === undefined ? {} : { usage: { inputTokens: usage - 1, outputTokens: 1 } }),
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'History review complete.' }],
      source: { kind: 'model', provider: route.provider, model: route.model } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/** Tune text length against the real token meter instead of assuming tokenizer density. */
function pricedHistory(ctx: Context, route: Route, header: EpochHeader, tokens: number, usage?: number): readonly SessionEvent[] {
  let characters = Math.max(0, (tokens - 16_000) * 4)
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = makeHistory(route, header, characters)
    const measured = ctx.tokenMeter.measure(session).totalTokens
    if (measured === tokens) {
      return usage === undefined ? session.snapshotEvents() : makeHistory(route, header, characters, usage).snapshotEvents()
    }
    characters += (tokens - measured) * 4
  }
  throw new Error('could not construct exact token-meter history')
}

async function harness(route: Route, tokens: number, usage?: number) {
  const ctx = new Context()
  contexts.push(ctx)
  const root = await mkdtemp(join(tmpdir(), 'muse-compaction-475k-'))
  roots.push(root)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new AcceptanceAdapter(route)
  ctx.llm.registerAdapter([route.provider], adapter)
  let executions = 0
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'review', description: 'Return the local fixture review result.', parameters: {},
    async execute() { executions++; return [{ type: 'text', text: 'CURRENT_TOOL_RESULT' }] },
  })))
  const warmup = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('warmup'),
    agentOptions: { provider: route.provider, model: route.model, maxTokens: route.output } })
  await run(warmup.agent, 'Prepare the fixture request envelope.')
  const header = warmup.agent.session.requestHeader()
  if (header === undefined) throw new Error('warmup did not publish the real request header')
  await warmup.dispose()
  executions = 0
  adapter.ordinary.length = 0
  adapter.toolNext = true
  await ctx.plugin(BasicCompactionEngine, policy)
  let handle: AgentHandle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('acceptance'),
    seed: pricedHistory(ctx, route, header, tokens, usage),
    agentOptions: { provider: route.provider, model: route.model, maxTokens: route.output },
  })
  return { ctx, adapter, get agent() { return handle.agent }, get executions() { return executions },
    async resume() {
      await handle.dispose()
      handle = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('acceptance'),
        agentOptions: { provider: route.provider, model: route.model, maxTokens: route.output } })
    } }
}

/** This test owns the only input producer from followup through idle. */
async function run(agent: Agent, text = 'CURRENT_REQUEST: continue the review.'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function lastReason(agent: Agent) {
  return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
}

describe('published Muse 475K policy through real loop and JSONL', () => {
  it.each([
    { chars: 15_900, admitted: true },
    { chars: 28_000, admitted: false },
  ])('uses calibrated prices for retained-context fallback: admitted=$admitted', async ({ chars, admitted }) => {
    const h = await harness(routes[0], 20_000, 445_000)
    h.adapter.summaryMode = 'error'
    h.adapter.toolNext = false
    const observed: { legacy: number; working: number }[] = []
    h.adapter.onOrdinary = () => { observed.push({
      legacy: h.ctx.tokenMeter.measure(h.agent.session).totalTokens,
      working: h.ctx.tokenMeter.measureWorkingContext(h.agent.session).totalTokens,
    }) }
    const text = `LATEST_CALIBRATED_INPUT; ${'新'.repeat(chars)}`
    await run(h.agent, text)
    expect(h.adapter.ordinary).toHaveLength(admitted ? 1 : 0)
    if (admitted) {
      expect(observed[0]?.legacy).toBeGreaterThan(448_000)
      expect(observed[0]?.legacy).toBeLessThan(451_000)
      expect(observed[0]?.working).toBeGreaterThan(530_000)
      expect(observed[0]?.working).toBeLessThan(540_000)
      expect(h.agent.session.requestContext()?.workingContextTokens).toBe(observed[0]?.working)
      expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
    } else {
      expect(h.ctx.tokenMeter.measure(h.agent.session).totalTokens).toBeLessThan(475_000)
      expect(h.ctx.tokenMeter.measureWorkingContext(h.agent.session).totalTokens).toBeGreaterThan(590_400)
      expect(lastReason(h.agent)).toMatchObject({ kind: 'error', error: { code: 'COMPACTION_UNAVAILABLE' } })
    }
    expect(h.agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === text))).toBe(true)
  })

  it('uses the same policy for the ordinary session, Bot and product defaults', async () => {
    expect(policy).toEqual({ adaptiveBudget: true, workingTokenLimit: 475_000,
      thresholdRatio: 0.45, headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384 })
    expect(await readPolicy('apps/desktop-host/presets/standard/agent.cordis.yml')).toEqual(policy)
    expect(await readPolicy('apps/desktop-host/presets/bot-coordinator/agent.cordis.yml')).toEqual(policy)
  })

  for (const route of routes) {
    const spec = resolveCompactSpec(resolveTargetPolicy(resolveConfig(policy), route), route.window, route.output)
    it(`${route.model} remains uncompressed just below ${spec.thresholdTokens}`, async () => {
      const h = await harness(route, spec.thresholdTokens - 2_000)
      expect(h.ctx.tokenMeter.measure(h.agent.session).totalTokens).toBe(spec.thresholdTokens - 2_000)
      await run(h.agent)
      expect(h.adapter.summaries).toHaveLength(0)
      expect(h.adapter.ordinary).toHaveLength(2)
      expect(h.executions).toBe(1)
      expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
    })

    for (const tokens of [spec.thresholdTokens + 2_000, 475_100]) {
      it(`${route.model} compacts ${tokens} and resumes the persisted replacement`, async () => {
        const h = await harness(route, tokens)
        const before = h.ctx.tokenMeter.measure(h.agent.session).totalTokens
        expect(before).toBe(tokens)
        await run(h.agent)
        expect(h.adapter.summaries).toHaveLength(1)
        expect(h.adapter.summaries[0]?.maxTokens).toBe(16_384)
        expect(h.adapter.ordinary).toHaveLength(2)
        expect(h.executions).toBe(1)
        const first = JSON.stringify(h.adapter.ordinary[0]?.messages)
        expect(first).toContain('CHECKPOINT_KEEP_RULE')
        expect(first).toContain('CURRENT_REQUEST')
        expect(first).not.toContain('OLD_CHINESE_HISTORY')
        expect(JSON.stringify(h.adapter.ordinary[1]?.messages)).toContain('CURRENT_TOOL_RESULT')
        const events = h.agent.session.snapshotEvents()
        expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
        expect(events.findLast(event => event.type === 'compaction/end')?.data.error).toBeUndefined()
        const after = h.ctx.tokenMeter.measure(h.agent.session).totalTokens
        expect(after).toBeLessThan(70_000)
        expect(h.agent.session.requestContext()?.contextWindow).toBe(route.window)
        expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
        expect(await h.ctx.sessions.flush(h.agent.session)).toBe(true)
        const reader = await h.ctx.sessionPersistence.open(h.agent.session.id, 'read')
        const stored = await reader.read()
        const reopened = Session.fromRestore(reader.id, stored.events, reader.header,
          reader.inheritedEventCount, stored.eventState)
        await reader.close()
        expect(JSON.stringify(stored.events)).toContain('OLD_CHINESE_HISTORY')
        expect(JSON.stringify(reopened.deriveMessages())).not.toContain('OLD_CHINESE_HISTORY')
        expect(JSON.stringify(reopened.deriveMessages())).toContain('CHECKPOINT_KEEP_RULE')
        expect(reopened.surface.nodes).toEqual(h.agent.session.surface.nodes)
        await h.resume()
        await run(h.agent, 'CONTINUE_AFTER_REOPEN')
        expect(h.adapter.summaries).toHaveLength(1)
        expect(h.executions).toBe(1)
        expect(JSON.stringify(h.adapter.ordinary.at(-1)?.messages)).not.toContain('OLD_CHINESE_HISTORY')
        expect(JSON.stringify(h.adapter.ordinary.at(-1)?.messages)).toContain('CURRENT_TOOL_RESULT')
        expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
        process.stdout.write(`${JSON.stringify({ model: route.model, threshold: spec.thresholdTokens, before, after,
          summaryCalls: h.adapter.summaries.length, toolExecutions: h.executions, reopened: true })}\n`)
      })
    }
  }

  it('uses a canonical 475100 usage anchor and removes its old history after compaction', async () => {
    const h = await harness(routes[2], 220_000, 475_100)
    expect(h.ctx.tokenMeter.measure(h.agent.session).baseline.kind).toBe('usage')
    expect(h.ctx.tokenMeter.measure(h.agent.session).baseline.tokens).toBe(475_100)
    expect(h.ctx.tokenMeter.measure(h.agent.session).totalTokens).toBe(475_114)
    await run(h.agent)
    expect(h.adapter.summaries).toHaveLength(1)
    expect(h.adapter.ordinary).toHaveLength(2)
    expect(h.ctx.tokenMeter.measure(h.agent.session).totalTokens).toBeLessThan(70_000)
    expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
  })

  it('compacts a short history whose canonical input usage exceeds its heuristic estimate', async () => {
    const h = await harness(routes[0], 20_000, 500_000)
    expect(h.ctx.tokenMeter.measure(h.agent.session).baseline.kind).toBe('usage')
    expect(h.ctx.tokenMeter.measure(h.agent.session).totalTokens).toBe(500_014)
    await run(h.agent)
    expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
    expect(h.adapter.summaries).toHaveLength(1)
    expect(h.adapter.ordinary).toHaveLength(2)
  })

  it('admits a recovered request between the soft threshold and hard budget while retaining new input and tool pairs', async () => {
    const h = await harness(routes[0], 20_000)
    const prefix = 'CURRENT_PROTECTED_INPUT: '
    const input = prefix + '新'.repeat((455_000 - 8) * 4 - prefix.length)
    const requestPrices: number[] = []
    h.adapter.onOrdinary = () => { requestPrices.push(h.ctx.tokenMeter.measureWorkingContext(h.agent.session).totalTokens) }
    await run(h.agent, input)
    expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
    expect(h.adapter.summaries.length).toBeGreaterThanOrEqual(1)
    expect(h.adapter.ordinary).toHaveLength(2)
    expect(requestPrices[0]).toBeGreaterThan(450_000)
    expect(requestPrices[0]).toBeLessThan(475_000)
    expect(h.adapter.ordinary[0]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text === input))).toBe(true)
    expect(JSON.stringify(h.adapter.ordinary[0]?.messages)).not.toContain('OLD_CHINESE_HISTORY')
    const resumed = h.adapter.ordinary[1]
    expect(JSON.stringify(resumed?.messages)).toContain('CURRENT_TOOL_RESULT')
    expect(JSON.stringify(resumed?.messages)).toContain('review-once')
    expect(h.executions).toBe(1)
    process.stdout.write(`${JSON.stringify({ model: routes[0].model, protectedInputTokens: 455_000,
      recoveredRequestTokens: requestPrices[0], finalKind: lastReason(h.agent)?.kind, toolExecutions: h.executions })}\n`)
  })

  it('retains a protected input above the working target while inside the safe model budget', async () => {
    const h = await harness(routes[0], 20_000)
    const prefix = 'OVERSIZED_PROTECTED_INPUT: '
    const input = prefix + '新'.repeat((476_000 - 8) * 4 - prefix.length)
    await run(h.agent, input)
    expect(h.adapter.ordinary).toHaveLength(2)
    expect(h.executions).toBe(1)
    expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
    expect(h.adapter.ordinary[0]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text === input))).toBe(true)
    expect(h.agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === input))).toBe(true)
  })

  it('does not mark a failed near-limit summary as a successful replacement', async () => {
    const h = await harness(routes[2], 475_100)
    h.adapter.summaryMode = 'error'
    await run(h.agent)
    expect(h.adapter.ordinary).toHaveLength(2)
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(0)
    expect(h.agent.session.snapshotEvents().findLast(event => event.type === 'compaction/end')?.data.error).toBeDefined()
    expect(lastReason(h.agent)).toEqual({ kind: 'completed' })
    expect(JSON.stringify(h.agent.session.deriveMessages())).toContain('OLD_CHINESE_HISTORY')
  })

  it('cancels a pending near-limit summary without dispatching ordinary work', async () => {
    const h = await harness(routes[2], 475_100)
    h.adapter.summaryMode = 'wait'
    const pending = run(h.agent)
    await h.adapter.summaryEntered.promise
    h.agent.cancel({ kind: 'user' })
    await pending
    expect(h.adapter.ordinary).toHaveLength(0)
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(0)
    expect(lastReason(h.agent)?.kind).toBe('aborted')
    expect(JSON.stringify(h.agent.session.deriveMessages())).toContain('OLD_CHINESE_HISTORY')
  })
})
