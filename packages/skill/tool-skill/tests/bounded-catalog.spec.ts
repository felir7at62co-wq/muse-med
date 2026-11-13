/** Conditional metadata discovery uses the same admitted owner as the recorded catalog. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry, { type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { ToolRunContext, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import * as ToolSkill from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

class ObservingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(config: ToolSkill.Config = { catalogSourceLimits: { 'muse-market': 2 }, catalogPageSize: 2 }) {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SkillRegistry).await()
  const fiber = ctx.plugin(ToolSkill, config); await fiber.await()
  const adapter = new ObservingAdapter()
  ctx.llm.registerAdapter(['bounded-fixture'], adapter)
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('bounded-directory-owner'), { provider: 'bounded-fixture', model: 'bounded-fixture' })
  const add = (name: string, source = 'muse-market', modelInvocable = true) => ctx.skills.register({
    name, source, description: `${name} summary`, content: `${name} private instructions`,
    invocation: { modelInvocable, userInvocable: true },
  })
  return { ctx, fiber, agent, adapter, add, create: (...args: Parameters<typeof loop.create>) => loop.create(...args) }
}

async function run(agent: Agent, text = 'Review this scene'): Promise<void> {
  agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
  await agent.whenIdle()
}

function catalog(agent: Agent) {
  const source = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    .map(event => event.data.source).filter(source => source.kind === 'skill-catalog').at(-1)
  if (source === undefined) throw new Error('Expected a real logged catalog')
  return source
}

async function invoke(ctx: Context, agent: Agent, args: object, name = 'skill_catalog') {
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'bounded-fixture', model: 'bounded-fixture' } })
  try {
    return await executeToolFixture(ctx, { agent, signal, toolSet, name, callId: ToolCallId('bounded-owner-call'), arguments: args })
  } finally { toolSet.dispose() }
}

describe('conditional bounded catalog ownership', () => {
  it('rejects an oversized default page before registering directory tools', async () => {
    const f = await fixture(), registered = f.ctx.tools.get('skill_catalog', f.agent)
    expect(() => { ToolSkill.apply(f.ctx, { catalogPageSize: 101 }) }).toThrow('catalogPageSize must not exceed 100')
    expect(f.ctx.tools.get('skill_catalog', f.agent)).toBe(registered)
    await expect(fixture({ catalogPageSize: 101 })).rejects.toThrow('expected number <= 100')
  })

  it('requires an admitted owner and presents only valid directory metadata', async () => {
    const f = await fixture(); f.add('first'); f.add('second'); f.add('third')
    await run(f.agent)
    const definition = f.ctx.tools.get('skill_catalog', f.agent)
    if (definition === undefined) throw new Error('Expected registered directory')
    const callId = ToolCallId('unadmitted-directory')
    const context: ToolRunContext = { callId, rootCallId: callId, name: 'skill_catalog', arguments: {},
      signal: new AbortController().signal, token: Symbol('unadmitted-directory') as ToolExecutionToken,
      deferContext: () => {}, concludeTurn: () => {} }
    await expect(definition.execute({}, context)).rejects.toThrow('requires an admitted Agent step')
    expect(definition.presentCall?.({})).toEqual({ card: 'generic', title: 'Find skills', kind: 'read', rawInput: '' })
    const failed = await invoke(f.ctx, f.agent, { limit: 0 })
    expect(definition.presentResult?.({}, failed)).toEqual({ card: 'generic', title: 'Skill directory unavailable' })
    const complete = await invoke(f.ctx, f.agent, { limit: 100 })
    expect(definition.presentResult?.({}, complete)).toMatchObject({ card: 'generic', title: 'Skill directory',
      content: [{ type: 'text', text: '3 of 3 matching skills' }] })
    const invalid: (typeof complete.meta)[] = [undefined, null, [], 1, {}, { kind: 'other' },
      { kind: 'skill-catalog', count: 'three', totalMatched: 3 }, { kind: 'skill-catalog', count: 3, totalMatched: 'three' }]
    for (const meta of invalid) {
      const view = { ...complete }
      if (meta === undefined) delete view.meta
      else view.meta = meta
      expect(definition.presentResult?.({}, view)).toBeUndefined()
    }
  })

  it('keeps the untrimmed request tool set and catalog complete when a source meets its limit', async () => {
    const f = await fixture()
    f.add('first'); f.add('second'); f.add('custom', 'custom')
    await run(f.agent)
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['skill'])
    expect(catalog(f.agent).bounded).toBeUndefined()
    expect(catalog(f.agent).incomplete).toBeUndefined()
    expect(catalog(f.agent).entries.map(entry => entry.name)).toEqual(['custom', 'first', 'second'])
    expect((await invoke(f.ctx, f.agent, {})).isError).toBe(true)
  })

  it('records selected summaries while metadata pages and exact loading keep all eligible names', async () => {
    const f = await fixture()
    f.add('first'); f.add('second'); f.add('third'); f.add('custom', 'custom'); f.add('user-only', 'muse-market', false)
    await run(f.agent)
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.adapter.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['skill', 'skill_catalog'])
    const source = catalog(f.agent)
    expect(source.bounded).toBe(true); expect(source.incomplete).toBeUndefined()
    expect(source.entries.map(entry => entry.name)).toEqual(['custom', 'first', 'second'])
    expect(f.agent.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('not the complete permitted directory')))).toBe(true)
    const first = await invoke(f.ctx, f.agent, {})
    expect(first.isError).toBe(false)
    if (first.isError || first.value === null || typeof first.value !== 'object' || Array.isArray(first.value)) throw new Error('Expected a metadata page')
    expect(first.value.entries).toEqual([
      { name: 'custom', description: 'custom summary', source: 'custom' },
      { name: 'first', description: 'first summary', source: 'muse-market' },
    ])
    expect(first.meta).toEqual({ kind: 'skill-catalog', count: 2, totalMatched: 4, hasMore: true })
    const second = await invoke(f.ctx, f.agent, { cursor: first.value.nextCursor })
    expect(second.isError).toBe(false)
    if (second.isError || second.value === null || typeof second.value !== 'object' || Array.isArray(second.value)) throw new Error('Expected the next metadata page')
    expect(second.value.entries).toEqual([
      { name: 'second', description: 'second summary', source: 'muse-market' },
      { name: 'third', description: 'third summary', source: 'muse-market' },
    ])
    expect(second.value.nextCursor).toBeUndefined()
    const loaded = await invoke(f.ctx, f.agent, { name: 'third' }, 'skill')
    expect(loaded.isError).toBe(false)
    expect(loaded.value).toMatchObject({ name: 'third', content: 'third private instructions' })
    const denied = await invoke(f.ctx, f.agent, { name: 'user-only' }, 'skill')
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('not available for model invocation')
    const definition = f.ctx.tools.get('skill_catalog', f.agent)
    expect(definition?.presentCall?.({ query: 'third' })).toEqual({ card: 'generic', title: 'Find skills', kind: 'read', rawInput: 'third' })
    expect(definition?.presentResult?.({}, first)).toMatchObject({ card: 'generic', title: 'Skill directory',
      content: [{ type: 'text', text: '2 of 4 matching skills; more results are available' }] })
  })

  it('validates real tool JSON bounds, including normalized text expansion and cursor fields', async () => {
    const f = await fixture(); f.add('first'); f.add('second'); f.add('third')
    for (const args of [
      { limit: 0 }, { limit: 101 }, { query: 'x'.repeat(1025) },
      { query: '㍍'.repeat(300) },
      { cursor: { version: 1, sessionId: f.agent.id, digest: 'x', query: '', offset: 0 } },
      { cursor: { version: 1, sessionId: f.agent.id, digest: 'a'.repeat(64), query: '', offset: -1 } },
      { cursor: { version: 1, sessionId: f.agent.id, digest: 'a'.repeat(64), query: ' A ', offset: 0 } },
    ]) {
      const result = await invoke(f.ctx, f.agent, args)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('SKILL_CATALOG_INVALID_REQUEST')
      expect(result).toMatchObject({ error: { info: { code: 'SKILL_CATALOG_INVALID_REQUEST' } } })
    }
    const fractional = await invoke(f.ctx, f.agent, { limit: 1.5 })
    expect(fractional.isError).toBe(true)
    expect(JSON.stringify(fractional.content)).toContain('must be an integer')
  })

  it('refuses foreign and stale cursors and never loads a body for metadata discovery', async () => {
    const f = await fixture(); f.add('first'); f.add('second'); f.add('third')
    const first = await invoke(f.ctx, f.agent, { limit: 1 })
    if (first.isError || first.value === null || typeof first.value !== 'object' || Array.isArray(first.value)) throw new Error('Expected a metadata page')
    const cursor = first.value.nextCursor
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('Expected a transparent cursor')
    const foreign = await invoke(f.ctx, f.agent, { cursor: { ...cursor, sessionId: 'another-session' } })
    expect(foreign.isError).toBe(true); expect(JSON.stringify(foreign.content)).toContain('SKILL_CATALOG_FOREIGN_CURSOR')
    f.add('added', 'custom')
    const stale = await invoke(f.ctx, f.agent, { cursor })
    expect(stale.isError).toBe(true); expect(JSON.stringify(stale.content)).toContain('SKILL_CATALOG_STALE_CURSOR')
    expect(JSON.stringify(first.value)).not.toContain('private instructions')
  })

  it('refuses the first Agent cursor in a second real Agent and queries only that Agent scope', async () => {
    const f = await fixture(); f.add('first'); f.add('second'); f.add('third')
    const other = await f.create(SessionId('bounded-directory-other'), { provider: 'bounded-fixture', model: 'bounded-fixture' })
    await other.ctx.plugin({ inject: ['skills'], apply(ctx) {
      ctx.skills.register({ name: 'only-other', description: 'Other Agent summary', content: 'Other Agent instructions', source: 'muse-market' })
    } }).await()
    const first = await invoke(f.ctx, f.agent, { limit: 1 })
    if (first.isError || first.value === null || typeof first.value !== 'object' || Array.isArray(first.value)) throw new Error('Expected a metadata page')
    const denied = await invoke(f.ctx, other, { cursor: first.value.nextCursor })
    expect(denied).toMatchObject({ isError: true, error: { info: { code: 'SKILL_CATALOG_FOREIGN_CURSOR' } } })
    const own = await invoke(f.ctx, other, { limit: 100 })
    expect(own.value).toMatchObject({ totalMatched: 4, entries: [
      { name: 'first' }, { name: 'only-other' }, { name: 'second' }, { name: 'third' },
    ] })
    const original = await invoke(f.ctx, f.agent, { limit: 100 })
    expect(original.value).toMatchObject({ totalMatched: 3, entries: [{ name: 'first' }, { name: 'second' }, { name: 'third' }] })
    expect(JSON.stringify(original.value)).not.toContain('only-other')
  })

  it('fails before the first model request on partial discovery and retains the previous bounded catalog later', async () => {
    const f = await fixture(); f.add('first'); f.add('second'); f.add('third')
    let complete = false, control!: SkillProviderControl
    f.ctx.skills.registerProvider((registered) => {
      control = registered
      return { name: 'partial-fixture', list: () => Promise.resolve({ candidates: [], complete }), get: () => Promise.resolve(undefined) }
    })
    await run(f.agent)
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
    complete = true; control.invalidate()
    await run(f.agent)
    expect(f.adapter.requests).toHaveLength(1)
    const prior = catalog(f.agent)
    complete = false; control.invalidate()
    await run(f.agent)
    expect(f.adapter.requests).toHaveLength(2)
    expect(catalog(f.agent)).toEqual(prior)
    expect(f.adapter.requests[1]?.tools?.map(tool => tool.name).sort()).toEqual(['skill', 'skill_catalog'])
    const result = await invoke(f.ctx, f.agent, {})
    expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain('SKILL_CATALOG_INCOMPLETE')
  })

  it('refuses a changed truncation decision between step admission and catalog publication', async () => {
    const f = await fixture(); f.add('first'); const removeSecond = f.add('second'), removeThird = f.add('third')
    f.ctx.on('agent/pre-step', async (_input, next) => { removeSecond(); removeThird(); return next() }, { prepend: true })
    await run(f.agent)
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true)
  })

  it('isolates two simultaneous preparations for the same Agent by their own cancellation signals', async () => {
    const f = await fixture(); f.add('first'); f.add('second'); f.add('third')
    const signal = new AbortController().signal, externalSignal = new AbortController().signal
    const modelSelection = { provider: 'bounded-fixture', model: 'bounded-fixture' }
    const loop = await f.ctx.tools.resolve({ agent: f.agent, signal, modelSelection })
    try {
      const external = await f.ctx.tools.resolve({ agent: f.agent, signal: externalSignal, modelSelection })
      try {
        const decision = await agentEvents(f.ctx, f.agent).waterfall('agent/pre-step',
          { messages: [], signal, modelSelection, turn: 1, step: 1 },
          () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
        expect(decision.kind).toBe('enter')
        if (decision.kind === 'enter') expect(decision.messages.find(message => message.source.kind === 'skill-catalog')?.source)
          .toMatchObject({ bounded: true })
      } finally { external.dispose() }
    } finally { loop.dispose() }
  })

  it('keeps exact scoped owners isolated and removes metadata access with the owning plugin', async () => {
    const f = await fixture(); f.add('first'); f.add('second'); f.add('third')
    const scoped = f.agent.ctx.plugin(ToolSkill, { scopedCatalogOwner: true }); await scoped.await()
    await run(f.agent)
    expect(f.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['skill'])
    expect(catalog(f.agent).bounded).toBeUndefined()
    await scoped.dispose()
    await run(f.agent)
    expect(f.adapter.requests[1]?.tools?.map(tool => tool.name).sort()).toEqual(['skill', 'skill_catalog'])
    expect(catalog(f.agent).bounded).toBe(true)
    await f.fiber.dispose()
    const result = await invoke(f.ctx, f.agent, {})
    expect(result.isError).toBe(true)
    expect(f.ctx.agents.get(f.agent.id)).toBe(f.agent)
    expect((await f.ctx.skills.list()).map(skill => skill.name)).toEqual(['first', 'second', 'third'])
  })
})
