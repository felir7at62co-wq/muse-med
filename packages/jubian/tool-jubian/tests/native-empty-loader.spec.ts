/** Empty native previews report local failure through the Loader and Agent session. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { stableSha256, submissionSemantics } from '@deepseek-ai/dsh-jubian-api'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

it('records the empty-subject diagnostic without ledger or HTTP side effects', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const ledgerRoot = join(home, 'ledger')
  await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot, workspaceSecrets: false } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  const noNetwork = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'))
  try {
    const payload = { id: 1, scriptId: 2708, isGenerate: 1, storyboardMaterialList: [],
      modelConfig: JSON.stringify({ modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN',
        standardId: 11, genType: 3, modelGenerationTypeId: 7, videoStandardId: 91,
        duration: 8, genNum: 1, ratio: '9:16', resolution: '720p', prompt: 'A quiet street', materialList: [] }) }
    const key = stableSha256(submissionSemantics(payload))
    await mkdir(join(home, 'video_tasks'))
    const previewPath = join(home, 'video_tasks', 'empty.storyboard-native.prepared.json')
    await writeFile(previewPath, JSON.stringify({ version: 1, operation: 'prepare_storyboard_native_video',
      status: 'prepared', createdAt: '2026-10-08T00:00:00Z', scriptId: 2708, storyboardId: 1,
      estimatedSubmissions: 1, assetSummary: { count: 0, orderedAssets: [] }, payload,
      idempotencyKey: key, nextAction: 'Review before submitting' }))
    const adapter = new MockAdapter([
      toolCallResponse('empty-preview', 'jubian_storyboard', { method: 'submit_video',
        preview_path: previewPath, idempotency_key: key }),
      textResponse('Stopped before submission.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('empty-preview-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Check this prepared video.' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(true)
    expect(results).toMatchSnapshot('local empty-subject refusal')
    expect(noNetwork).not.toHaveBeenCalled()
    expect(await new JubianLedger({ root: ledgerRoot }).records()).toEqual([])
  } finally {
    noNetwork.mockRestore()
    await ctx.fiber.dispose()
  }
})
