import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-binding-owner-')))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory)
  const harness = await mountAgentLoopTestHarness(ctx)
  const id = SessionId('original-session')
  const agent = await harness.create(id, selection, { cwd: root })
  const source = new JsonStorageBackend(root)
  const record = { path: root, title: 'project', sessionIds: [id], createdAt: '2026-01-01', updatedAt: '2026-01-01' }
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['original-workspace'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'original-workspace': record } } }))
  const authority = new OwnedWorkspaceStorage({ sourceBackend: 'json', root: join(root, 'owned') }, source)
  const unit = await authority.kv.open({ name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true })
  ctx.provide('generationWorkspaceAuthority', authority)
  ctx.effect(() => async () => { await authority.close(); await source.close() })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ready')]))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'begin' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { root, ctx, agent, unit, record }
}

describe('native generation execution binding', () => {
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
