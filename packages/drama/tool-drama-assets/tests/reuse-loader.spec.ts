/** Reuse planning under real Loader composition, with external reads mocked. */
import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Assets from '../src/index.ts'
import { tree } from './matching-fixture.ts'
import { mapping, reuseProject, reuseProvider } from './reuse-fixture.ts'

it('executes centralized multi-shot preview through Loader with zero writes and no approval', async () => {
  const root = await reuseProject(undefined, [mapping(), mapping(902)]), before = await tree(root), mock = reuseProvider()
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(mock.fetch)
  const loaded = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-test-token' } },
    { id: 'assets', name: 'cordis:assets', config: { workspaceSecrets: false, matchPageSize: 1 } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, assets: Assets } })
  try {
    const definition = loaded.ctx.tools.get('drama_assets')
    if (!definition) throw new Error('Missing drama_assets')
    const args = { method: 'reuse_preview', project_dir: root, requirements_path: 'requirements.json', plan_path: 'reuse.json' }
    expect(validateJsonSchemaValue(definition.parameters, args, '')).toEqual([])
    const result = await loaded.ctx.tools.execute({ callId: ToolCallId('reuse-preview-loader'), name: 'drama_assets',
      arguments: args, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(validateJsonSchemaValue(definition.output.schema, result.value, '')).toEqual([])
    expect(result.value).toMatchObject({ method: 'reuse_preview', status: 'reuse_ready', apply_allowed: false,
      shots: [{ storyboard_id: 901, status: 'awaiting_confirmation' }, { storyboard_id: 902, status: 'awaiting_confirmation' }],
      local_writes: 0, remote_writes: 0, paid_requests: 0 })
    expect(await tree(root)).toEqual(before)
    expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
    const tools = loaded.ctx.tools
    await loaded.ctx.fiber.dispose()
    expect(tools.get('drama_assets')).toBeUndefined()
  } finally {
    await loaded.ctx.fiber.dispose()
    transport.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
