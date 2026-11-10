/** Native Session resume with an isolated fake model; no Bot or provider is loaded. */
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { expect, it, vi } from 'vitest'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { createGenerationWatchNotice, deliverGenerationWatchNotice, registerGenerationWatchDelivery } from '../src/generation-watch-delivery.ts'

const selection = { provider: 'mock', model: 'original-model' }
async function nativeHost(root: string, durableInboxClaims = false) {
  const { ctx } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'executor', name: 'cordis:executor' },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'loop', name: 'cordis:loop', config: { agents: [], durableInboxClaims } }, { id: 'controller', name: 'cordis:controller' },
  ], builtins: {
    prompt: SystemPrompt, tools: Tools, executor: NativeExecutor, llm: Llm, sessions: SessionStore, projections: SessionProjections,
    agents: AgentRegistry, loop: AgentLoop, persistence: JsonlSessionPersistence,
    controller: { inject: ['llm', 'sessions', 'sessionProjections', 'agents'], apply: (scope: Context) => {
      createSessionTestController(scope, { cwd: root, defaultModelSelection: () => ({ provider: 'mock', model: 'other-model' }) })
    } },
  } })
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const projection = await registerGenerationWatchDelivery(ctx)
  return { ctx, projection }
}

it('resumes the exact Session and model once from the native controller without loading Bot', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-watch-resume-')))
  const hosts: Context[] = [], fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('No network') })
  try {
    const id = SessionId('original')
    const { ctx: first } = await nativeHost(root)
    hosts.push(first)
    const original = await first.agentLoop.create(id, selection, { cwd: root })
    original.model.select(selection)
    expect(await first.sessions.flush(original.session)).toBe(true)
    await first.fiber.dispose()
    hosts.pop()
    const { ctx: restored, projection } = await nativeHost(root)
    hosts.push(restored)
    restored.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Existing result reviewed.')]))
    expect(restored.get('museTeam')).toBeUndefined()
    const notice = createGenerationWatchNotice('Resume the existing task, without sending a new request.')
    expect(await deliverGenerationWatchNotice(restored, id, notice)).toBe('pending')
    expect(restored.agents.get(id)).toBeUndefined()
    const verifyFixture = async () => true // This exercises native resume only; production needs Host evidence.
    expect(await deliverGenerationWatchNotice(restored, id, notice, undefined, undefined, undefined, verifyFixture, projection)).toBe('pending')
    const found = await restored.sessionController.resolveAgent(id)
    if ('error' in found) throw found.error
    await vi.waitFor(() => {
      const events = found.agent.session.snapshotEvents()
      expect(events.some(event => event.type === 'user/message' && event.data.id === notice.id), JSON.stringify(events)).toBe(true)
    }, { timeout: 2000 })
    await found.agent.whenIdle()
    expect(found.agent.session.id).toBe(id)
    expect(found.agent.session.header.cwd).toBe(root)
    expect(found.agent.model.current()).toMatchObject(selection)
    expect(found.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === notice.id)).toHaveLength(1)
    expect(await deliverGenerationWatchNotice(restored, id, notice, undefined, undefined, undefined, verifyFixture, projection)).toBe('settled')
    expect(found.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === notice.id)).toHaveLength(1)
    expect(restored.get('museTeam')).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    for (const host of hosts.reverse()) await host.fiber.dispose()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('keeps the original model when the notice waits behind active maintenance', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-watch-model-race-')))
  const { ctx, projection } = await nativeHost(root)
  const release = Promise.withResolvers<undefined>()
  try {
    const adapter = new MockAdapter([textResponse('Existing result reviewed.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const id = SessionId('model-race-original')
    const agent = await ctx.agentLoop.create(id, selection, { cwd: root })
    agent.model.select(selection)
    const maintenance = agent.runMaintenance(async () => { await release.promise })
    const notice = createGenerationWatchNotice('Resume the original task.')
    const lease = agent.model.guard?.(selection, new AbortController().signal)
    if (lease === undefined) throw new Error('native model owner guard unavailable')
    const verifier = () => { lease.assertCurrent(); return Promise.resolve(true) }
    expect(await deliverGenerationWatchNotice(ctx, id, notice, undefined, undefined, undefined, verifier, projection)).toBe('pending')
    expect(() => { agent.model.select({ provider: 'mock', model: 'changed-while-queued' }) }).toThrow('guarded model')
    release.resolve(undefined)
    await maintenance
    await agent.whenIdle()
    expect(adapter.requests[0]?.model).toBe(selection.model)
    lease.release()
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('rejects a queued notice at model-request admission after the session model changes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-watch-request-guard-')))
  const { ctx, projection } = await nativeHost(root)
  const release = Promise.withResolvers<undefined>()
  try {
    const adapter = new MockAdapter([textResponse('This response must not run.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const id = SessionId('model-race-guarded')
    const agent = await ctx.agentLoop.create(id, selection, { cwd: root })
    agent.model.select(selection)
    const maintenance = agent.runMaintenance(async () => { await release.promise })
    const notice = createGenerationWatchNotice('Resume the original task.')
    const verifier = async () => true // This test isolates the model guard; it is not Host authority.
    const stopGuard = ctx.on('agent/request', async ({ agent: incoming }, next) => {
      const config = await next()
      if (incoming.session.id === id && (config.provider !== selection.provider || config.model !== selection.model)) {
        throw new Error('GENERATION_WATCH_BINDING_CHANGED: original model changed before continuation')
      }
      return config
    })
    try {
      expect(await deliverGenerationWatchNotice(ctx, id, notice, undefined, undefined, undefined, verifier, projection)).toBe('pending')
      agent.model.select({ provider: 'mock', model: 'changed-while-queued' })
      release.resolve(undefined)
      await maintenance
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(0)
      expect(agent.model.current()).toMatchObject({ provider: 'mock', model: 'changed-while-queued' })
      const events = agent.session.snapshotEvents()
      expect(events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === notice.id))).toBe(true)
      expect(events.some(event => event.type === 'user/message' && event.data.id === notice.id)).toBe(false)
      expect(events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toBe(true)
      const resumeIfRestored = async () => agent.model.current().provider === selection.provider
        && agent.model.current().model === selection.model
      for (let i = 0; i < 3; i++) {
        expect(await deliverGenerationWatchNotice(ctx, id, notice, undefined, undefined, undefined, verifier, projection, resumeIfRestored)).toBe('pending')
      }
      expect(agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === notice.id))).toHaveLength(1)
      expect(adapter.requests).toHaveLength(0)
      agent.model.select(selection)
      const outcomes = await Promise.all(Array.from({ length: 3 }, () =>
        deliverGenerationWatchNotice(ctx, id, notice, undefined, undefined, undefined, verifier, projection, resumeIfRestored)))
      expect(outcomes).toEqual(['pending', 'pending', 'pending'])
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.model).toBe(selection.model)
      expect(await deliverGenerationWatchNotice(ctx, id, notice, undefined, undefined, undefined, verifier, projection)).toBe('settled')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === notice.id)).toHaveLength(1)
    } finally { stopGuard() }
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('recovers a guarded notice after durable Session restart without duplicate enqueue', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-watch-guard-restart-')))
  const hosts: Context[] = []
  const release = Promise.withResolvers<undefined>()
  try {
    const id = SessionId('model-guard-restart')
    const first = await nativeHost(root)
    hosts.push(first.ctx)
    const original = await first.ctx.agentLoop.create(id, selection, { cwd: root })
    original.model.select(selection)
    const adapter = new MockAdapter([textResponse('No call before the binding is restored.')])
    first.ctx.llm.registerAdapter(['mock'], adapter)
    first.ctx.on('agent/request', async ({ agent: incoming }, next) => {
      const config = await next()
      if (incoming.session.id === id && config.model !== selection.model) {
        throw new Error('GENERATION_WATCH_BINDING_CHANGED: original model changed before continuation')
      }
      return config
    })
    const maintenance = original.runMaintenance(async () => { await release.promise })
    const notice = createGenerationWatchNotice('Continue the original task once.')
    const verifier = async () => true
    expect(await deliverGenerationWatchNotice(first.ctx, id, notice, undefined, undefined, undefined, verifier, first.projection)).toBe('pending')
    original.model.select({ provider: 'mock', model: 'changed' })
    release.resolve(undefined)
    await maintenance
    await original.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(await first.ctx.sessions.flush(original.session)).toBe(true)
    await first.ctx.fiber.dispose()
    hosts.pop()

    const restored = await nativeHost(root)
    hosts.push(restored.ctx)
    const nextAdapter = new MockAdapter([textResponse('Continued once.')])
    restored.ctx.llm.registerAdapter(['mock'], nextAdapter)
    const found = await restored.ctx.sessionController.resolveAgent(id)
    if ('error' in found) throw found.error
    const agent = found.agent
    const allowed = async () => agent.model.current().provider === selection.provider && agent.model.current().model === selection.model
    expect(await deliverGenerationWatchNotice(restored.ctx, id, notice, undefined, undefined, undefined, verifier, restored.projection, allowed)).toBe('pending')
    expect(nextAdapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === notice.id))).toHaveLength(1)
    agent.model.select(selection)
    expect(await deliverGenerationWatchNotice(restored.ctx, id, notice, undefined, undefined, undefined, verifier, restored.projection, allowed)).toBe('pending')
    await agent.whenIdle()
    expect(nextAdapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === notice.id)).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    for (const host of hosts.reverse()) await host.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)


it('preserves other claimed next-step inputs when a watch binding rejects the step', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-watch-guard-other-input-')))
  const { ctx, projection } = await nativeHost(root, true)
  const release = Promise.withResolvers<undefined>()
  try {
    const id = SessionId('model-guard-other-input')
    const agent = await ctx.agentLoop.create(id, selection, { cwd: root })
    agent.model.select(selection)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Unexpected model call')]))
    const maintenance = agent.runMaintenance(async () => { await release.promise })
    const notice = createGenerationWatchNotice('Continue the original task.')
    const userInput = createUserMessage({ content: [{ type: 'text', text: 'Keep this user instruction.' }], source: { kind: 'user' } })
    agent.inbox.append('next-step', userInput)
    ctx.on('agent/pre-step', async ({ messages, modelSelection }, next) => {
      if (messages.some(message => message.id === notice.id) && modelSelection.model !== selection.model) {
        throw new Error('GENERATION_WATCH_BINDING_CHANGED: original model changed before continuation')
      }
      return next()
    })
    expect(await deliverGenerationWatchNotice(ctx, id, notice, undefined, undefined, undefined, async () => true, projection, async () => true)).toBe('pending')
    agent.model.select({ provider: 'mock', model: 'changed' })
    release.resolve(undefined)
    await maintenance
    await agent.whenIdle()
    expect(agent.inbox.nextStep.some(message => message.id === userInput.id)
      || agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === userInput.id)).toBe(true)
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('retains the claimed batch in order across restart after a watch admission rejects', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-watch-batch-restart-')))
  const hosts: Context[] = []
  const release = Promise.withResolvers<undefined>()
  try {
    const first = await nativeHost(root, true)
    hosts.push(first.ctx)
    const id = SessionId('model-guard-batch-restart')
    const agent = await first.ctx.agentLoop.create(id, selection, { cwd: root })
    agent.model.select(selection)
    first.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Unexpected model call')]))
    const maintenance = agent.runMaintenance(async () => { await release.promise })
    const notice = createGenerationWatchNotice('Continue the original task.')
    const firstInput = createUserMessage({ content: [{ type: 'text', text: 'First input.' }], source: { kind: 'user' } })
    const secondInput = createUserMessage({ content: [{ type: 'text', text: 'Second input.' }], source: { kind: 'user' } })
    agent.inbox.append('next-step', firstInput)
    agent.inbox.append('next-step', secondInput)
    first.ctx.on('agent/pre-step', async ({ messages, modelSelection }, next) => {
      if (messages.some(message => message.id === notice.id) && modelSelection.model !== selection.model) {
        throw new Error('GENERATION_WATCH_BINDING_CHANGED: original model changed before continuation')
      }
      return next()
    })
    expect(await deliverGenerationWatchNotice(first.ctx, id, notice, undefined, undefined, undefined, async () => true, first.projection, async () => true)).toBe('pending')
    agent.model.select({ provider: 'mock', model: 'changed' })
    release.resolve(undefined)
    await maintenance
    await agent.whenIdle()
    expect(await first.ctx.sessions.flush(agent.session)).toBe(true)
    await first.ctx.fiber.dispose()
    hosts.pop()
    const restored = await nativeHost(root, true)
    hosts.push(restored.ctx)
    const found = await restored.ctx.sessionController.resolveAgent(id)
    if ('error' in found) throw found.error
    expect(found.agent.inbox.nextStep.map(message => message.id)).toEqual([firstInput.id, secondInput.id])
    expect(found.agent.inbox.nextTurn.map(message => message.id)).toEqual([notice.id])
  } finally {
    release.resolve(undefined)
    for (const host of hosts.reverse()) await host.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('preserves a claimed batch when disposal interrupts later step preparation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-watch-claim-crash-')))
  const hosts: Context[] = []
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  try {
    const first = await nativeHost(root, true)
    hosts.push(first.ctx)
    const id = SessionId('model-guard-claim-interrupted')
    const agent = await first.ctx.agentLoop.create(id, selection, { cwd: root })
    agent.model.select(selection)
    const adapter = new MockAdapter([textResponse('Unexpected model call')])
    first.ctx.llm.registerAdapter(['mock'], adapter)
    const hold = agent.runMaintenance(async () => { await release.promise })
    const notice = createGenerationWatchNotice('Continue the original task.')
    const userInput = createUserMessage({ content: [{ type: 'text', text: 'Preserve this instruction.' }], source: { kind: 'user' } })
    agent.inbox.append('next-step', userInput)
    const prepared = Promise.withResolvers<undefined>()
    const leave = Promise.withResolvers<undefined>()
    first.ctx.on('agent/pre-step', async (_payload, next) => {
      entered.resolve(undefined)
      await leave.promise
      prepared.resolve(undefined)
      return next()
    })
    expect(await deliverGenerationWatchNotice(first.ctx, id, notice, undefined, undefined, undefined, async () => true, first.projection, async () => true)).toBe('pending')
    release.resolve(undefined)
    await hold
    await entered.promise
    agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    leave.resolve(undefined)
    await prepared.promise
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(await first.ctx.sessions.flush(agent.session)).toBe(true)
    await first.ctx.fiber.dispose()
    hosts.pop()
    const restored = await nativeHost(root, true)
    hosts.push(restored.ctx)
    const found = await restored.ctx.sessionController.resolveAgent(id)
    if ('error' in found) throw found.error
    expect(found.agent.inbox.nextStep.map(message => message.id)).toEqual([userInput.id])
    expect(found.agent.inbox.nextTurn.map(message => message.id)).toEqual([notice.id])
  } finally {
    release.resolve(undefined)
    for (const host of hosts.reverse()) await host.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)


it('restores a protected actual AgentLoop batch after interrupted preparation and JSONL reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-durable-claim-')))
  const hosts: Context[] = []
  const release = Promise.withResolvers<undefined>()
  try {
    const first = await nativeHost(root, true)
    hosts.push(first.ctx)
    const id = SessionId('actual-durable-batch')
    const agent = await first.ctx.agentLoop.create(id, selection, { cwd: root })
    agent.model.select(selection)
    first.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Unexpected model call')]))
    const maintenance = agent.runMaintenance(async () => { await release.promise })
    const a = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const b = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    const c = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    const d = createUserMessage({ content: [{ type: 'text', text: 'later step' }], source: { kind: 'user' } })
    const e = createUserMessage({ content: [{ type: 'text', text: 'later turn' }], source: { kind: 'user' } })
    agent.inbox.append('next-step', a)
    agent.inbox.append('next-step', b)
    const entered = Promise.withResolvers<undefined>(), leave = Promise.withResolvers<undefined>()
    first.ctx.on('agent/pre-step', async (_payload, next) => { entered.resolve(undefined); await leave.promise; return next() })
    agent.followup(c)
    release.resolve(undefined)
    await maintenance
    await entered.promise
    agent.inbox.append('next-step', d)
    agent.inbox.append('next-turn', e)
    agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    leave.resolve(undefined)
    await agent.whenIdle()
    expect(agent.inbox.nextStep.map(message => message.id)).toEqual([a.id, b.id, d.id])
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([c.id, e.id])
    expect(await first.ctx.sessions.flush(agent.session)).toBe(true)
    await first.ctx.fiber.dispose()
    hosts.pop()
    const second = await nativeHost(root, true)
    hosts.push(second.ctx)
    const restored = await second.ctx.sessionController.resolveAgent(id)
    if ('error' in restored) throw restored.error
    expect(restored.agent.inbox.nextStep.map(message => message.id)).toEqual([a.id, b.id, d.id])
    expect(restored.agent.inbox.nextTurn.map(message => message.id)).toEqual([c.id, e.id])
  } finally {
    release.resolve(undefined)
    for (const host of hosts.reverse()) await host.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('explicitly drops filtered items from a protected actual AgentLoop batch', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-durable-filter-')))
  const { ctx } = await nativeHost(root, true)
  const release = Promise.withResolvers<undefined>()
  try {
    const agent = await ctx.agentLoop.create(SessionId('actual-durable-filter'), selection, { cwd: root })
    agent.model.select(selection)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Done')]))
    const hold = agent.runMaintenance(async () => { await release.promise })
    const a = createUserMessage({ content: [{ type: 'text', text: 'keep' }], source: { kind: 'user' } })
    const b = createUserMessage({ content: [{ type: 'text', text: 'discard' }], source: { kind: 'user' } })
    const c = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    agent.inbox.append('next-step', a)
    agent.inbox.append('next-step', b)
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'enter' ? { ...decision, messages: decision.messages.filter(message => message.id !== b.id) } : decision
    })
    agent.followup(c)
    release.resolve(undefined)
    await hold
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'agent/inbox/claim-filtered' && event.data.discarded.includes(b.id))).toBe(true)
    expect(events.filter(event => event.type === 'user/message' && [a.id, b.id, c.id].includes(event.data.id)).map(event => event.data.id)).toEqual([a.id, c.id])
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(0)
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('restores only uncommitted inputs after a protected AgentLoop batch partly appends', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-durable-partial-')))
  const { ctx } = await nativeHost(root, true)
  const release = Promise.withResolvers<undefined>()
  try {
    const agent = await ctx.agentLoop.create(SessionId('actual-durable-partial'), selection, { cwd: root })
    agent.model.select(selection)
    const adapter = new MockAdapter([textResponse('Unexpected')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const hold = agent.runMaintenance(async () => { await release.promise })
    const a = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const b = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    const c = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    agent.inbox.append('next-step', a)
    agent.inbox.append('next-step', b)
    const append = agent.session.append.bind(agent.session)
    const interceptor = vi.spyOn(agent.session, 'append').mockImplementation((type, data, options) => {
      if (type === 'user/message' && data.id === b.id) throw new Error('Injected partial write failure')
      return append(type, data, options)
    })
    agent.followup(c)
    release.resolve(undefined)
    await hold
    await agent.whenIdle()
    interceptor.mockRestore()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === a.id)).toHaveLength(1)
    expect(agent.inbox.nextStep.map(message => message.id)).toEqual([b.id])
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([c.id])
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)


it('recovers a protected AgentLoop claim from a copied crash-point JSONL', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-durable-crash-')))
  const snapshot = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-durable-crash-copy-')))
  const hosts: Context[] = []
  const release = Promise.withResolvers<undefined>(), leave = Promise.withResolvers<undefined>()
  try {
    const first = await nativeHost(root, true)
    hosts.push(first.ctx)
    const id = SessionId('actual-durable-crash')
    const agent = await first.ctx.agentLoop.create(id, selection, { cwd: root })
    agent.model.select(selection)
    first.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Unexpected')]))
    const maintenance = agent.runMaintenance(async () => { await release.promise })
    const a = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    const b = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    agent.inbox.append('next-step', a)
    const entered = Promise.withResolvers<undefined>()
    first.ctx.on('agent/pre-step', async (_payload, next) => { entered.resolve(undefined); await leave.promise; return next() })
    agent.followup(b)
    release.resolve(undefined)
    await maintenance
    await entered.promise
    expect(await first.ctx.sessions.flush(agent.session)).toBe(true)
    await cp(join(root, 'sessions'), join(snapshot, 'sessions'), { recursive: true })
    const second = await nativeHost(snapshot, true)
    hosts.push(second.ctx)
    const resumed = await second.ctx.sessionController.resolveAgent(id)
    if ('error' in resumed) throw resumed.error
    expect(resumed.agent.inbox.nextStep.map(message => message.id)).toEqual([a.id])
    expect(resumed.agent.inbox.nextTurn.map(message => message.id)).toEqual([b.id])
  } finally {
    release.resolve(undefined)
    leave.resolve(undefined)
    for (const host of hosts.reverse()) await host.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    await rm(snapshot, { recursive: true, force: true })
  }
}, 20_000)

it('does not inherit a protected parent claim into a persisted fork', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-durable-fork-isolation-')))
  const hosts: Context[] = []
  const release = Promise.withResolvers<undefined>(), leave = Promise.withResolvers<undefined>()
  try {
    const first = await nativeHost(root, true)
    hosts.push(first.ctx)
    const parentId = SessionId('fork-claim-parent'), childId = SessionId('fork-claim-child')
    const parent = await first.ctx.agentLoop.create(parentId, selection, { cwd: root })
    parent.model.select(selection)
    first.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Unexpected')]))
    const maintenance = parent.runMaintenance(async () => { await release.promise })
    const notice = createUserMessage({ content: [{ type: 'text', text: 'Parent original notice' }],
      source: { kind: 'jubian-generation-watch', form: 'notice', summary: 'Original result' } })
    const entered = Promise.withResolvers<undefined>()
    first.ctx.on('agent/pre-step', async (_payload, next) => { entered.resolve(undefined); await leave.promise; return next() })
    parent.followup(notice)
    release.resolve(undefined)
    await maintenance
    await entered.promise
    const child = first.ctx.sessions.fork(parent.session, undefined, childId)
    expect(child.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'forked')).toBe(true)
    const writer = await first.ctx.sessionPersistence.create(child.header, { inheritedEventCount: child.inheritedEventCount })
    try { await writer.append(child.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    parent.cancel({ kind: 'disposed' }, { keepInbox: true })
    leave.resolve(undefined)
    await parent.whenIdle()
    expect(parent.inbox.nextTurn.map(message => message.id)).toEqual([notice.id])
    expect(await first.ctx.sessions.flush(parent.session)).toBe(true)
    await first.ctx.fiber.dispose()
    hosts.pop()
    const second = await nativeHost(root, true)
    hosts.push(second.ctx)
    const restoredParent = await second.ctx.sessionController.resolveAgent(parentId)
    if ('error' in restoredParent) throw restoredParent.error
    const restoredChild = await second.ctx.sessionController.resolveAgent(childId)
    if ('error' in restoredChild) throw restoredChild.error
    expect(restoredParent.agent.inbox.nextTurn.map(message => message.id)).toEqual([notice.id])
    expect(restoredChild.agent.inbox.nextTurn.some(message => message.id === notice.id)).toBe(false)
    expect(restoredChild.agent.inbox.nextStep.some(message => message.id === notice.id)).toBe(false)
    expect(restoredChild.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === notice.id)).toBe(false)
  } finally {
    release.resolve(undefined)
    leave.resolve(undefined)
    for (const host of hosts.reverse()) await host.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
