/** Matching through a real profile/Loader composition, with only credentials and HTTP mocked. */
import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Assets from '../src/index.ts'
import { matchingProject, provider, tree } from './matching-fixture.ts'

it('discovers and executes match_preview under Loader without modifying any project file', async () => {
  const root = await matchingProject(), before = await tree(root), mock = provider()
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(mock.fetch)
  let ctx: Context | undefined
  try {
    const loaded = await configurationFixture({ hmr: false, rows: [
      { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-test-token' } },
      { id: 'assets', name: 'cordis:assets', config: { workspaceSecrets: false, matchPageSize: 1 } },
    ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, assets: Assets } })
    ctx = loaded.ctx
    const definition = ctx.tools.get('drama_assets')!
    expect(definition).toBeDefined()
    const args = { method: 'match_preview', project_dir: root, requirements_path: 'requirements.json' }
    expect(validateJsonSchemaValue(definition.parameters, args, '')).toEqual([])
    const result = await ctx.tools.execute({ callId: ToolCallId('match-preview-loader'), name: 'drama_assets',
      arguments: args, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(validateJsonSchemaValue(definition.output.schema, result.value, '')).toEqual([])
    expect(result.value).toMatchObject({ method: 'match_preview', status: 'reuse_ready',
      counts: { reuse_ready: 3 }, paid_requests: 0, local_writes: 0, remote_writes: 0 })
    expect(mock.calls).toHaveLength(8)
    expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
    expect(await tree(root)).toEqual(before)
    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.get('drama_assets')).toBeUndefined()
  } finally {
    await ctx?.fiber.dispose()
    transport.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects invalid matching deployment limits before registering tools', async () => {
  const loaded = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: {} },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials } })
  try {
    expect(() => { Assets.apply(loaded.ctx, { matchPageSize: 1001 }) }).toThrow('Matching limits')
    expect(() => { Assets.apply(loaded.ctx, { matchPageLimit: 0 }) }).toThrow('Matching limits')
    expect(loaded.ctx.tools.get('drama_assets')).toBeUndefined()
  } finally { await loaded.ctx.fiber.dispose() }
})
