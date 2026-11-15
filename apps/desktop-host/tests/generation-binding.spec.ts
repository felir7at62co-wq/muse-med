import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { captureGenerationSessionBinding, acquireGenerationSessionBinding } from '@deepseek-ai/dsh-tool-jubian/generation-binding'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { OwnedWorkspaceStorage } from '../src/workspace-owned-storage.ts'

vi.mock('../src/workspace-process-snapshot.ts', () => ({
  readWorkspaceProcessSnapshot: () => Promise.resolve({ platform: 'posix', stdout: `${process.pid} test-runner\n`, stderr: '' }),
}))

const selection = { provider: 'mock', model: 'original-model' }
async function fixture(options: { request?: boolean; selection?: ModelSelection } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-binding-owner-')))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory)
  const harness = await mountAgentLoopTestHarness(ctx)
  const id = SessionId('original-session')
  const chosen = options.selection ?? selection
  const agent = await harness.create(id, chosen, { cwd: root })
  const source = new JsonStorageBackend(root)
  const record = { path: root, title: 'project', sessionIds: [id], createdAt: '2026-01-01', updatedAt: '2026-01-01' }
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['original-workspace'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'original-workspace': record } } }))
  const authority = new OwnedWorkspaceStorage({ sourceBackend: 'json', root: join(root, 'owned') }, source)
  const unit = await authority.kv.open({ name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true })
  ctx.provide('generationWorkspaceAuthority', authority)
  ctx.effect(() => async () => { await authority.close(); await source.close() })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ready')], {
    efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
  }))
  if (options.request !== false) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'begin' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  return { root, ctx, agent, unit, record }
}

describe('native generation execution binding', () => {
  it('does not capture a Session before its first model request', async () => {
    const h = await fixture({ request: false })
    expect(h.agent.session.requestHeader()).toBeUndefined()
    await expect(captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('does not capture a Session removed from its workspace', async () => {
    const h = await fixture()
    await h.unit.putRecord('workspaces', 'original-workspace', { ...h.record, sessionIds: [] })
    await expect(captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('refuses incomplete owner compositions without holding model or directory resources', async () => {
    const h = await fixture()
    const captured = await captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)
    if (captured === undefined) throw new Error('binding not captured')
    captured.lease.release()
    const partial = new Context()
    onTestFinished(() => partial.fiber.dispose())
    await expect(captureGenerationSessionBinding(partial, h.agent, new AbortController().signal)).resolves.toBeUndefined()
    partial.provide('generationWorkspaceAuthority', h.ctx.generationWorkspaceAuthority)
    partial.provide('workingDirectory', h.ctx.workingDirectory)
    await expect(acquireGenerationSessionBinding(partial, h.agent, captured.binding, new AbortController().signal)).resolves.toBeUndefined()
    await expect(captureGenerationSessionBinding(partial, h.agent, new AbortController().signal)).resolves.toBeUndefined()
    h.agent.model.select({ ...selection, model: 'after-refusal' })
    await h.ctx.workingDirectory.set(h.agent, h.root)
  })

  it('rejects a binding that names another native Session before acquiring its owners', async () => {
    const h = await fixture()
    const captured = await captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)
    if (captured === undefined) throw new Error('binding not captured')
    captured.lease.release()
    await expect(acquireGenerationSessionBinding(h.ctx, h.agent,
      { ...captured.binding, sessionId: SessionId('other-session') }, new AbortController().signal)).rejects.toThrow('does not name the live native Session')
    h.agent.model.select({ ...selection, model: 'after-refusal' })
  })

  it('holds an explicit request reasoning effort until release', async () => {
    const high = { ...selection, reasoningEffort: ReasoningEffortId('high') }
    const h = await fixture({ selection: high })
    const captured = await captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)
    if (captured === undefined) throw new Error('binding not captured')
    expect(captured.binding.model).toEqual(high)
    expect(() => { h.agent.model.select(selection) }).toThrow('guarded model')
    captured.lease.assertCurrent()
    captured.lease.release()
    h.agent.model.select(selection)
  })

  it('rechecks the live Agent registry before permitting continuation', async () => {
    const h = await fixture()
    const owner = new Context()
    onTestFinished(() => owner.fiber.dispose())
    owner.provide('sessions', h.ctx.sessions)
    owner.provide('sessionProjections', h.ctx.sessionProjections)
    owner.provide('generationWorkspaceAuthority', h.ctx.generationWorkspaceAuthority)
    owner.provide('workingDirectory', h.ctx.workingDirectory)
    await owner.plugin(AgentRegistry)
    const detach = owner.agents.enter(h.agent, undefined)
    onTestFinished(detach)
    const captured = await captureGenerationSessionBinding(owner, h.agent, new AbortController().signal)
    if (captured === undefined) throw new Error('binding not captured')
    detach()
    expect(() => { captured.lease.assertCurrent() }).toThrow('generation Session owner changed')
    captured.lease.release()
    h.agent.model.select({ ...selection, model: 'after-detach' })
  })

  it('rejects directory drift observed before the owner delivers cancellation', async () => {
    const h = await fixture()
    const captured = await captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)
    if (captured === undefined) throw new Error('binding not captured')
    const other = join(h.root, 'other')
    await mkdir(other)
    // The observed owner value changes before its cancellation callback reaches this lease.
    const read = vi.spyOn(h.ctx.workingDirectory, 'get').mockReturnValue(other)
    try {
      expect(captured.lease.signal.aborted).toBe(false)
      expect(() => { captured.lease.assertCurrent() }).toThrow('generation working directory changed')
    } finally {
      read.mockRestore()
      captured.lease.release()
    }
    await h.ctx.workingDirectory.set(h.agent, other)
    expect(h.ctx.workingDirectory.get(h.agent.session)).toBe(other)
  })

  it('reports owner cleanup rejection while releasing the held model and directory', async () => {
    const h = await fixture()
    const reported = Promise.withResolvers<undefined>()
    const installed = Promise.withResolvers<undefined>()
    const warning = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => { reported.resolve(undefined) })
    onTestFinished(() => { warning.mockRestore() })
    const register = h.agent.ctx.effect.bind(h.agent.ctx)
    const effect = vi.spyOn(h.agent.ctx, 'effect').mockImplementation((execute, label) => {
      if (label !== 'generation.executionBinding') return register(execute, label)
      return register(async function* () {
        yield async () => { throw new Error('owner cleanup unavailable') }
        yield register(execute, label)
        installed.resolve(undefined)
      }, label)
    })
    const captured = await captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)
      .finally(() => { effect.mockRestore() })
    if (captured === undefined) throw new Error('binding not captured')
    await installed.promise
    captured.lease.release()
    await reported.promise
    expect(warning).toHaveBeenCalledWith('generation binding cleanup failed: Error: owner cleanup unavailable')
    expect(captured.lease.signal.aborted).toBe(true)
    h.agent.model.select({ ...selection, model: 'after-cleanup-error' })
    await mkdir(join(h.root, 'after-cleanup'))
    await h.ctx.workingDirectory.set(h.agent, 'after-cleanup')
  })

  it('holds the exact real Agent model, directory and original workspace identity', async () => {
    const h = await fixture()
    const captured = await captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)
    expect(captured).toBeDefined()
    if (captured === undefined) throw new Error('binding not captured')
    expect(captured.binding).toMatchObject({ sessionId: h.agent.id, workspaceId: 'original-workspace',
      workspacePath: h.root, workingDirectory: h.root, model: selection })
    expect(() => { h.agent.model.select({ ...selection, model: 'changed' }) }).toThrow('guarded model')
    await mkdir(join(h.root, 'other'))
    await expect(h.ctx.workingDirectory.set(h.agent, 'other')).rejects.toThrow('guarded directory')
    captured.lease.assertCurrent()
    captured.lease.release()
    h.agent.model.select({ ...selection, model: 'changed' })
    await h.ctx.workingDirectory.set(h.agent, 'other')
    expect(h.agent.model.current()?.model).toBe('changed')
  })

  it('rejects a different membership epoch even after reattachment at the same path', async () => {
    const h = await fixture()
    const captured = await captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)
    if (captured === undefined) throw new Error('binding not captured')
    captured.lease.release()
    await h.unit.putRecord('workspaces', 'original-workspace', { ...h.record, sessionIds: [] })
    await h.unit.putRecord('workspaces', 'original-workspace', h.record)
    await expect(acquireGenerationSessionBinding(h.ctx, h.agent, captured.binding, new AbortController().signal)).rejects.toThrow('membership changed')
  })

  it('uses the submitted request model and does not overwrite a later user selection', async () => {
    const h = await fixture()
    h.agent.model.select({ ...selection, model: 'user-changed' })
    await expect(captureGenerationSessionBinding(h.ctx, h.agent, new AbortController().signal)).rejects.toThrow('does not match')
    expect(h.agent.model.current()?.model).toBe('user-changed')
    await expect(h.unit.putRecord('workspaces', 'original-workspace', { ...h.record, title: 'after-refusal' })).resolves.toBeUndefined()
  })

  it('revokes the complete binding when the operation owner cancels', async () => {
    const h = await fixture(), owner = new AbortController()
    const captured = await captureGenerationSessionBinding(h.ctx, h.agent, owner.signal)
    if (captured === undefined) throw new Error('binding not captured')
    owner.abort(new Error('owner cancelled'))
    expect(captured.lease.signal.aborted).toBe(true)
    expect(() => { captured.lease.assertCurrent() }).toThrow()
    await h.unit.putRecord('workspaces', 'original-workspace', { ...h.record, sessionIds: [] })
    h.agent.model.select({ ...selection, model: 'after-cancel' })
  })
})
