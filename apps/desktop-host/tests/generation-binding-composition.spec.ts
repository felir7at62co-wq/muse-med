/** Actual Workspace Registry, JSONL Session owner and private Desktop backend, without provider traffic. */
import { mkdtemp, realpath, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { captureGenerationSessionBinding } from '@deepseek-ai/dsh-tool-jubian/generation-binding'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as WorkspaceOwned from '../src/workspace-owned-storage.ts'

vi.mock('../src/workspace-process-snapshot.ts', () => ({
  readWorkspaceProcessSnapshot: () => Promise.resolve({ platform: 'posix', stdout: `${process.pid} test-runner\n`, stderr: '' }),
}))

it('uses the production workspace domain and original JSONL Session with exclusive ownership', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-owned-composition-')))
  const legacyRoot = join(root, 'legacy'), successor = join(root, 'successor'), sessions = join(root, 'sessions')
  await mkdir(legacyRoot)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'))
  onTestFinished(() => { fetch.mockRestore() })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory)
  await ctx.plugin(JsonlPersistence, { root: sessions, compression: 'none' })
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ready')]))
  const agent = await harness.create(SessionId('registered-original'), { provider: 'mock', model: 'original' }, { cwd: root })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'begin' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: legacyRoot })
  await ctx.plugin(WorkspaceOwned, { root: successor, sourceBackend: 'json' })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { workspace: 'muse-workspace-owned' } })
  const workspaceFiber = ctx.plugin(WorkspaceRegistry)
  await workspaceFiber
  const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(agent.id))
  expect(workspace).toBeDefined()
  if (workspace === undefined) throw new Error('original workspace missing')
  const captured = await captureGenerationSessionBinding(ctx, agent, new AbortController().signal)
  expect(captured?.binding).toMatchObject({ sessionId: agent.id, workspaceId: workspace.id, workingDirectory: root,
    model: { provider: 'mock', model: 'original' } })
  if (captured === undefined) throw new Error('production binding missing')
  await ctx.workspaceRegistry.archiveSession(agent.id, { stopActivity: true })
  expect(ctx.workspaceRegistry.archivedSessionIds).toContain(agent.id)
  expect(captured.lease.signal.aborted).toBe(true)
  expect(() => { captured.lease.assertCurrent() }).toThrow()
  expect(workspace.sessionIds).toContain(agent.id)
  expect(ctx.workspaceRegistry.get(workspace.id)).toBe(workspace)
  await workspaceFiber.dispose()
  await ctx.plugin(WorkspaceRegistry)
  expect(ctx.workspaceRegistry.get(workspace.id)?.sessionIds).toContain(agent.id)
  expect(ctx.workspaceRegistry.archivedSessionIds).toContain(agent.id)
  expect(fetch).not.toHaveBeenCalled()
}, 20000)
