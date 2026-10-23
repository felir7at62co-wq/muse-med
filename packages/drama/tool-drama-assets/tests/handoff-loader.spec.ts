/** Scripted model handoff through real Loader tools; not a live-model authorization test. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../../../jubian/tool-jubian/src/index.ts'
import * as Assets from '../src/index.ts'
import { character, scene, tree } from './matching-fixture.ts'
import { mapping, reuseProject, image } from './reuse-fixture.ts'
import { handoffProvider } from './handoff-fixture.ts'

it.each(['authorized', 'not-authorized', 'needs_review', 'missing', 'blocked'] as const)(
  'scripts existing-tool handoff for %s without adding a binding executor', async (scenario) => {
    const requirements = scenario === 'needs_review' ? [{ ...character, state_or_costume: '非孕期；青年；家常装' }]
      : scenario === 'missing' ? [{ ...scene, name: '不存在的场景', stable_id: 'unknown' }] : [character]
    const hasPlan = scenario !== 'missing'
    const root = await reuseProject(requirements, [mapping(), mapping(902)])
    const ledger = await mkdtemp(join(tmpdir(), 'muse-handoff-ledger-'))
    const before = await tree(root)
    const mock = handoffProvider(scenario === 'blocked' ? { page: () => { throw new Error('Read failed') } } : {})
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(mock.fetch)
    const loaded = await configurationFixture({ hmr: false, rows: [
      { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-test-token' } },
      { id: 'assets', name: 'cordis:assets', config: { workspaceSecrets: false, matchPageSize: 1 } },
      { id: 'jubian', name: 'cordis:jubian', config: { workspaceSecrets: false, ledgerRoot: ledger } },
    ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, assets: Assets, jubian: Jubian } })
    try {
      const tools = loaded.ctx.tools
      expect(tools.get('drama_assets_confirmation')).toBeUndefined()
      const definition = tools.get('drama_assets')
      const binding = tools.get('jubian_storyboard')
      if (!definition || !binding) throw new Error('Missing existing tools')
      expect(definition.description).toContain('用户授权后')
      const result = await tools.execute({ callId: ToolCallId('preview-' + scenario), name: 'drama_assets',
        arguments: { method: 'reuse_preview', project_dir: root, requirements_path: 'requirements.json',
          ...(hasPlan ? { plan_path: 'reuse.json' } : {}) }, signal: new AbortController().signal })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      expect(validateJsonSchemaValue(definition.output.schema, result.value, '')).toEqual([])
      const preview = result.value
      if (!preview || typeof preview !== 'object' || Array.isArray(preview)) throw new Error('Invalid preview result')
      const groups = preview.groups, shots = preview.shots
      if (!Array.isArray(groups) || !Array.isArray(shots)) throw new Error('Missing groups or shots')
      expect(preview).toMatchObject({ apply_allowed: false, read_only: true, paid_requests: 0, remote_writes: 0 })
      expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
      const expectedStatus = scenario === 'missing' ? 'missing' : scenario === 'blocked' || scenario === 'needs_review'
        ? 'blocked' : 'reuse_ready'
      expect(preview.status).toBe(expectedStatus)
      if (scenario === 'needs_review') expect(groups[0]).toMatchObject({ status: 'needs_review' })
      // Authorization is an authored user instruction in this script, not a new tool-side approval flag.
      if (scenario === 'authorized') {
        expect(groups).toHaveLength(1)
        for (const shot of shots) {
          if (!shot || typeof shot !== 'object' || Array.isArray(shot) || typeof shot.storyboard_id !== 'number') {
            throw new Error('Invalid shot suggestion')
          }
          const args = { method: 'select_assets', storyboard_id: shot.storyboard_id,
            selections: shot.selections, idempotency_key: 'approved-selection-' + String(shot.storyboard_id) }
          expect(validateJsonSchemaValue(binding.parameters, args, '')).toEqual([])
          expect(args.selections).toEqual([{ material_key: 'lead', asset_id: 11 }, { material_key: 'bg', asset_id: 12 }])
          const applied = await tools.execute({ callId: ToolCallId('select-' + String(shot.storyboard_id)), name: 'jubian_storyboard',
            arguments: args, signal: new AbortController().signal })
          expect(applied.isError, JSON.stringify(applied.content)).not.toBe(true)
          const board = mock.boards.get(shot.storyboard_id)
          const expectedMaterials = [
            image(11, 'lead', '陆沉舟（职场装）', 'https://example.invalid/lu.png', 1),
            image(12, 'bg', '大厅', 'https://example.invalid/lobby.png', 2),
            { materialKey: 'voice', materialType: 'audio', materialUrl: 'https://example.invalid/lu.wav', sortOrder: 1 },
          ]
          expect(board?.modelConfig).toEqual({
            prompt: '@[阿舟](lead)走进@[大厅](bg)，@[阿舟](lead)停下。@[声线](voice)',
            platformName: 'fixture', resolution: '720p', materialList: expectedMaterials,
          })
          expect(board?.privateProviderField).toEqual({ retained: true })
          expect(board?.storyboardMaterialList).toEqual(expectedMaterials)
          const repeated = await tools.execute({ callId: ToolCallId('repeat-' + String(shot.storyboard_id)), name: 'jubian_storyboard',
            arguments: args, signal: new AbortController().signal })
          expect(repeated.isError).not.toBe(true)
        }
      }
      const writes = mock.calls.filter(call => call.method !== 'GET')
      expect(writes).toHaveLength(scenario === 'authorized' ? 2 : 0)
      expect(writes.every(call => call.method === 'PUT' && call.body?.isGenerate === 0)).toBe(true)
      expect(await tree(root)).toEqual(before)
    } finally {
      await loaded.ctx.fiber.dispose()
      transport.mockRestore()
      await rm(root, { recursive: true, force: true })
      await rm(ledger, { recursive: true, force: true })
    }
  },
)
