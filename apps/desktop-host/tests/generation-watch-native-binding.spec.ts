/** Native automatic continuation through real Session, Workspace, model and directory owners. */
import { mkdtemp, realpath, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { captureGenerationSessionBinding, type GenerationSessionBinding } from '@deepseek-ai/dsh-tool-jubian/generation-binding'
import { createSessionTestController } from '../../../packages/api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { registerGenerationWatchDelivery, createGenerationWatchNotice } from '../../../packages/jubian/tool-jubian/src/generation-watch-delivery.ts'
import { createNativeGenerationDelivery } from '../../../packages/jubian/tool-jubian/src/generation-watch-native-delivery.ts'
import type { NativeGenerationDelivery } from '../../../packages/jubian/tool-jubian/src/generation-watch-native-delivery.ts'
import type { GenerationWatchRun } from '../../../packages/jubian/tool-jubian/src/generation-watch-store.ts'
import * as WorkspaceOwned from '../src/workspace-owned-storage.ts'

// Owner-composition tests have isolated homes; process handoff is exercised by its own child-process tests.
vi.mock('../src/workspace-handoff.ts', () => ({ assertWorkspaceMigrationHandoff: vi.fn(async () => undefined) }))

async function nativeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-bound-watch-'))), ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'))
  onTestFinished(() => { expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore() })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [], durableInboxClaims: true })
  await createSessionTestController(ctx, { cwd: root, defaultModelSelection: () => ({ provider: 'mock', model: 'different-default' }) })
  const projection = await registerGenerationWatchDelivery(ctx)
  let deliver: NativeGenerationDelivery | undefined
  const factory = ctx.plugin({ inject: ['tools', 'agents', 'sessions', 'sessionController', 'sessionPersistence', 'agentLoop'], apply: (scope: Context) => { deliver = createNativeGenerationDelivery(scope, projection) } })
  await factory
  if (deliver === undefined) throw new Error('native delivery factory unavailable')
  const agent = await ctx.agentLoop.create(SessionId('original'), { provider: 'mock', model: 'original-model' }, { cwd: root })
  await ctx.sessions.flush(agent.session)
  const legacy = join(root, 'legacy'); await mkdir(legacy)
  await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root: legacy })
  await ctx.plugin(WorkspaceOwned, { root: join(root, 'owned'), sourceBackend: 'json' })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { workspace: 'muse-workspace-owned' } })
  await ctx.plugin(WorkspaceRegistry)
  const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(agent.id))
  if (workspace === undefined) throw new Error('workspace was not bootstrapped')
  const key = 'b'.repeat(64), runId = 'a'.repeat(64), previewPath = join(root, 'original-preview.json')
  const args = { method: 'submit_video', idempotency_key: key, preview_path: previewPath }
  let binding: GenerationSessionBinding | undefined
  const issued = new WeakMap<object, GenerationSessionBinding>()
  ctx.tools.register(defineTool({
    name: 'jubian_storyboard', description: 'Offline submission body with native binding.',
    parameters: { method: { type: 'string', required: true }, idempotency_key: { type: 'string', required: true },
      preview_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, preserveBodyMeta: true, render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (input) => {
        const captured = issued.get(input)
        return captured === undefined ? undefined : { generationWatchId: runId, submission: args,
          binding: { ...captured, model: { provider: captured.model.provider, model: captured.model.model } } }
      } },
    execute: async (_args, exec) => {
      if (exec.agent === undefined) throw new Error('native Agent missing')
      const captured = await captureGenerationSessionBinding(ctx, exec.agent, exec.signal)
      if (captured === undefined) throw new Error('native binding missing')
      try { captured.lease.assertCurrent(); binding = captured.binding; issued.set(_args, binding); return 'Original submission recorded.' }
      finally { captured.lease.release() }
    },
  }))
  const adapter = new MockAdapter([toolCallResponse('original-submit', 'jubian_storyboard', args),
    textResponse('Waiting for the existing video.'), textResponse('Continued the original conversation.')])
  const adapterRegistration = ctx.llm.registerAdapter(['mock'], adapter)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Submit this prepared video.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  if (binding === undefined) throw new Error('tool body did not capture binding: '+JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'turn/end')))
  expect(await ctx.sessions.flush(agent.session)).toBe(true)
  const run: GenerationWatchRun = { id: runId, sessionId: agent.id, binding, createdAt: 0, deadlineAt: 1000,
    packs: [{ key, previewPath }] }
  return { root, ctx, agent, workspace, adapter, projection, deliver, run, factory, adapterRegistration }
}

it('automatically continues once in the original Session/model/Workspace using authenticated body metadata', async () => {
  const h = await nativeFixture(), notice = createGenerationWatchNotice('The original video is complete; continue the original task.')
  expect(await h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)).toBe('pending')
  await h.agent.whenIdle()
  expect(h.adapter.requests).toHaveLength(3)
  expect(h.adapter.requests.at(-1)).toMatchObject({ provider: 'mock', model: 'original-model', sessionId: h.agent.id })
  expect(h.agent.session.header.cwd).toBe(h.root)
  expect(h.ctx.workspaceRegistry.get(h.workspace.id)?.sessionIds).toContain(h.agent.id)
  expect(h.projection.stateOf(h.agent.session).notices[notice.id]).toBe('settled')
  expect(await h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)).toBe('settled')
  expect(h.adapter.requests).toHaveLength(3)
  expect(h.ctx.get('museTeam')).toBeUndefined()
}, 20000)

it('preserves a later user model choice and does not continue with that changed model', async () => {
  const h = await nativeFixture(), notice = createGenerationWatchNotice('Existing result.')
  h.agent.model.select({ provider: 'mock', model: 'user-selected-later' })
  await expect(h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)).rejects.toThrow('does not match')
  expect(h.adapter.requests).toHaveLength(2)
  expect(h.agent.model.current()?.model).toBe('user-selected-later')
}, 20000)

it('does not infer original membership from a replacement Workspace at the same path', async () => {
  const h = await nativeFixture(), notice = createGenerationWatchNotice('Existing result.')
  await h.ctx.workspaceRegistry.delete(h.workspace.id)
  const replacement = await h.ctx.workspaceRegistry.create(h.root)
  await replacement.attachSession(h.agent.id)
  expect(replacement.id).not.toBe(h.workspace.id)
  await expect(h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)).rejects.toThrow()
  expect(h.adapter.requests).toHaveLength(2)
  expect(h.ctx.workspaceRegistry.get(replacement.id)?.sessionIds).toContain(h.agent.id)
}, 20000)

it('holds the original model while completion waits behind existing maintenance', async () => {
  const h = await nativeFixture(), notice = createGenerationWatchNotice('Existing video complete.')
  const gate = Promise.withResolvers<undefined>()
  const maintenance = h.agent.runMaintenance(async () => { await gate.promise })
  try {
    expect(await h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)).toBe('pending')
    expect(() => { h.agent.model.select({ provider: 'mock', model: 'changed-while-queued' }) }).toThrow('guarded model')
    expect(h.adapter.requests).toHaveLength(2)
  } finally { gate.resolve(undefined); await maintenance }
  await h.agent.whenIdle()
  expect(h.adapter.requests.at(-1)?.model).toBe('original-model')
  expect(h.projection.stateOf(h.agent.session).notices[notice.id]).toBe('settled')
}, 20000)

it('revokes queued automatic continuation when the user archives its Session', async () => {
  const h = await nativeFixture(), notice = createGenerationWatchNotice('Existing video complete.')
  const gate = Promise.withResolvers<undefined>()
  const maintenance = h.agent.runMaintenance(async () => { await gate.promise })
  try {
    await h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)
    await h.ctx.workspaceRegistry.archiveSession(h.agent.id, { stopActivity: false })
  } finally { gate.resolve(undefined); await maintenance }
  await h.agent.whenIdle()
  expect(h.adapter.requests).toHaveLength(2)
  expect(h.ctx.workspaceRegistry.archivedSessionIds).toContain(h.agent.id)
  expect(h.agent.model.current()?.model).toBe('original-model')
}, 20000)

it('reopens actual JSONL and the owned Workspace after Host shutdown and continues once', async () => {
  const h = await nativeFixture(), notice = createGenerationWatchNotice('Existing video complete after restart.')
  await h.ctx.fiber.dispose()
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
    await ctx.plugin(LocalFileSystem, { cwd: h.root }); await ctx.plugin(WorkingDirectory)
    await ctx.plugin(JsonlPersistence, { root: join(h.root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [], durableInboxClaims: true })
    await createSessionTestController(ctx, { cwd: h.root, defaultModelSelection: () => ({ provider: 'mock', model: 'different-default' }) })
    await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root: join(h.root, 'legacy') })
    await ctx.plugin(WorkspaceOwned, { root: join(h.root, 'owned'), sourceBackend: 'json' })
    await ctx.plugin(StorageDomain, { backend: 'json', routes: { workspace: 'muse-workspace-owned' } })
    await ctx.plugin(WorkspaceRegistry)
    const projection = await registerGenerationWatchDelivery(ctx), deliver = createNativeGenerationDelivery(ctx, projection)
    const adapter = new MockAdapter([textResponse('Continued from the original durable context.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    expect(await deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)).toBe('pending')
    const resolved = await ctx.sessionController.resolveAgent(h.agent.id)
    if ('error' in resolved) throw resolved.error
    await resolved.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'original-model', sessionId: h.agent.id })
    expect(ctx.workspaceRegistry.get(h.workspace.id)?.sessionIds).toContain(h.agent.id)
    expect(ctx.workingDirectory.get(resolved.agent.session)).toBe(h.root)
    expect(await deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)).toBe('settled')
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.get('museTeam')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
}, 20000)


it('parks only its queued input before unloading and re-verifies it after reload', async () => {
  const h = await nativeFixture(), notice = createGenerationWatchNotice('Existing video complete.')
  const gate = Promise.withResolvers<undefined>()
  const maintenance = h.agent.runMaintenance(async () => { await gate.promise })
  await h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)
  const separate = createUserMessage({ content: [{ type: 'text', text: 'A separate user request.' }], source: { kind: 'user' } })
  h.agent.followup(separate)
  const unload = h.factory.dispose()
  gate.resolve(undefined)
  await maintenance
  await unload
  expect(h.agent.inbox.nextTurn.some(message => message.id === notice.id)).toBe(false)
  expect(h.projection.stateOf(h.agent.session).notices[notice.id]).toBe('guard-rejected')
  h.agent.model.select({ provider: 'mock', model: 'later-user-model' })
  expect(h.agent.inbox.nextTurn.some(message => message.id === separate.id)).toBe(true)
  expect(h.agent.wakePending?.(separate.id)).toBe(true)
  await h.agent.whenIdle()
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === separate.id)).toHaveLength(1)
  expect(h.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === notice.id)).toBe(false)
  h.agent.model.select({ provider: 'mock', model: 'original-model' })
  h.adapterRegistration()
  const restoredAdapter = new MockAdapter([textResponse('Resumed after verified producer reload.')])
  h.ctx.llm.registerAdapter(['mock'], restoredAdapter)
  let restored: NativeGenerationDelivery | undefined
  await h.ctx.plugin({ inject: ['tools', 'agents', 'sessions', 'sessionController', 'sessionPersistence', 'agentLoop'], apply: (scope: Context) => { restored = createNativeGenerationDelivery(scope, h.projection) } })
  if (restored === undefined) throw new Error('reloaded factory missing')
  expect(await restored(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)).toBe('pending')
  await h.agent.whenIdle()
  expect(h.projection.stateOf(h.agent.session).notices[notice.id]).toBe('settled')
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === notice.id)).toHaveLength(1)
  expect(restoredAdapter.requests).toHaveLength(1)
  expect(restoredAdapter.requests[0]?.model).toBe('original-model')
}, 20000)


it('awaits an admitted persistence read on unload without enqueueing its notice afterwards', async () => {
  const h = await nativeFixture(), notice = createGenerationWatchNotice('Existing video complete.')
  const entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
  const stat = h.ctx.sessionPersistence.stat.bind(h.ctx.sessionPersistence)
  const delayed = vi.spyOn(h.ctx.sessionPersistence, 'stat').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await released.promise
    return stat(...args)
  })
  onTestFinished(() => { delayed.mockRestore() })
  const delivery = h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run)
  const rejected = expect(delivery).rejects.toThrow('producer unloaded')
  await entered.promise
  let finished = false
  const unload = h.factory.dispose().then(() => { finished = true })
  try {
    await vi.waitFor(() => { expect(h.factory.state).toBe(FiberState.UNLOADING) })
    expect(finished).toBe(false)
  } finally { released.resolve(undefined) }
  await Promise.all([unload, rejected])
  expect(h.agent.inbox.nextTurn.some(message => message.id === notice.id)).toBe(false)
  expect(h.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === notice.id)).toBe(false)
  expect(h.adapter.requests).toHaveLength(2)
  h.agent.model.select({ provider: 'mock', model: 'later-user-model' })
}, 20000)
