/** Advisory findings travel through the loaded tools, durable log and next model request. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

/** Read the last tool response as the model receives it. */
function lastResult(options: GenerateOptions): { fingerprint: string; preview_path: string } {
  const message = options.messages.filter(message => message.role === 'tool').at(-1)
  const text = message?.content.filter(part => part.type === 'text').map(part => part.text).join('')
  if (!text) throw new Error('Missing model-visible tool result')
  const result = JSON.parse(text) as { fingerprint: string; preview_path: string }
  return { fingerprint: result.fingerprint, preview_path: result.preview_path }
}

it('keeps dirty previews actionable, reports saved prompt findings and clears them after a verified free edit', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const config = { modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN', standardId: 11,
    genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, genNum: 1,
    ratio: '9:16', resolution: '720p', prompt: '@[主角](lead)', materialList: [] }
  const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
  const boards = new Map([1, 2].map(id => [id, { id, scriptId: 2708, storyboardName: `EP01-P${id}`,
    isGenerate: 0, modelConfig: JSON.stringify(config), storyboardMaterialList: [{
      assetId: 'lead-id', materialAssetId: 81285, fileName: '主角', materialKey: 'lead', materialType: 'image',
      materialUrl: url, sortOrder: 1 }] }]))
  const writes: Record<string, unknown>[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
    let data: unknown
    if (init?.method === 'PUT' && path.endsWith('/aigc/storyboard')) {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request body')
      const body = JSON.parse(init.body) as NonNullable<ReturnType<typeof boards.get>>
      expect(body.isGenerate).toBe(0)
      writes.push(body); boards.set(body.id, body); data = null
    } else if (init?.method !== 'GET') throw new Error('Unexpected provider mutation')
    else if (path.includes('/aigc/storyboard/')) data = boards.get(Number(path.split('/').at(-1)))
    else if (path.includes('/aigc/material/list')) data = { total: 1, rows: [{ id: 1, assetId: 81285,
      scriptId: 2708, hsAssetId: 'lead-id', assetUrl: url, hsAssetStatus: 'Active', isUsed: 1 }] }
    else if (path.includes('/aigc/asset/')) data = { id: 81285, scriptId: 2708, assetUrl: url }
    else if (path.includes('/model/charge/')) data = [{ ...config, id: 11,
      genTypes: [{ id: 7, type: 3 }], videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }]
    else throw new Error(`Unexpected provider read ${path}`)
    return new Response(JSON.stringify({ code: 200, data }))
  })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: join(home, 'ledger'), workspaceSecrets: false,
      promptRiskReview: { terms: ['国旗', '国徽'], contextChars: 8 } } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    await writeFile(join(home, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    const clean = '@[主角](lead)在婚房内回头。'
    const dirty = '@[主角](lead)【全局禁止】不出现国旗国徽。'
    const adapter = new MockAdapter([
      toolCallResponse('batch-preview', 'jubian_storyboard', { method: 'edit_batch_preview', script_id: 2708,
        project_dir: home, edits: [{ storyboard_id: 1, changes: { prompt: dirty } },
          { storyboard_id: 2, changes: { prompt: '@[主角](lead)说：“国旗。”' } }] }),
      options => toolCallResponse('save-dirty', 'jubian_storyboard', { method: 'edit_apply', script_id: 2708,
        project_dir: home, ...lastResult(options), idempotency_key: lastResult(options).fingerprint }),
      toolCallResponse('prepare-dirty', 'jubian_storyboard', { method: 'prepare_video', storyboard_id: 1, project_dir: home }),
      toolCallResponse('correct-preview', 'jubian_storyboard', { method: 'edit_preview', script_id: 2708,
        project_dir: home, storyboard_id: 1, changes: { prompt: clean } }),
      options => toolCallResponse('save-corrected', 'jubian_storyboard', { method: 'edit_apply', script_id: 2708,
        project_dir: home, ...lastResult(options), idempotency_key: lastResult(options).fingerprint }),
      toolCallResponse('prepare-corrected', 'jubian_storyboard', { method: 'prepare_video', storyboard_id: 1, project_dir: home }),
      toolCallResponse('readback', 'jubian_storyboard', { method: 'get', storyboard_id: 1 }),
      textResponse('已修正描述并回读；原台词需对照来源保留。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('prompt-risk-review'), { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '检查并修正视频卡提示词，不生成视频。' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(7)
    for (const result of results) expect(result.data.message.isError).toBeFalsy()
    const values = results.map(result => JSON.parse(result.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('')) as {
      status: string
      prompt_risk_review?: { total_matches: number }
      storyboard?: { model_config: { prompt: string } }
    })
    expect(values[0]).toMatchObject({ status: 'ready', prompt_risk_review: { total_matches: 3 } })
    expect(values[1]).toMatchObject({ status: 'applied', items: [{ verified_readback: true }, { verified_readback: true }] })
    expect(values[2]).toMatchObject({ status: 'prepared', prompt_risk_review: { total_matches: 2 } })
    expect(values[4]).toMatchObject({ status: 'applied', items: [{ verified_readback: true }] })
    expect(values[5]).toMatchObject({ status: 'prepared', prompt_risk_review: { total_matches: 0 } })
    expect(values[6]?.storyboard?.model_config.prompt).toBe(clean)
    expect(values.filter(value => value.prompt_risk_review).map(value => ({ status: value.status, review: value.prompt_risk_review })))
      .toMatchSnapshot('advisory findings before and after readback')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('prompt_risk_review')
    expect(JSON.stringify(adapter.requests[3]!.messages)).toContain('不凭引号认定原台词')
    expect(boards.get(2)?.modelConfig).toContain('国旗')
    expect(writes).toHaveLength(3)
  } finally { transport.mockRestore(); await ctx.fiber.dispose() }
})
