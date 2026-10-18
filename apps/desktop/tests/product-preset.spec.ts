import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as DramaGate from '@deepseek-ai/dsh-guard-drama'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'
import NativePreset from '../../desktop-host/src/native-preset.ts'

const productRoot = fileURLToPath(new URL('../../desktop-host/presets', import.meta.url))
const patchPath = fileURLToPath(new URL('../../desktop-host/config/defaults.cordis.patch.yml', import.meta.url))

it('offers one unified Agent while keeping recorded editing sessions recoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-product-preset-'))
  const ctx = new Context()
  try {
    const patch = loadOverlayPatches('muse-med', patchPath).find(row => row.id === 'agent-preset-registry')
    const presetConfig = patch?.config as Record<string, unknown> | undefined
    expect(presetConfig).toMatchObject({ default: 'short-drama', selectablePresets: ['short-drama'] })
    const productRows = yaml.load(await readFile(join(productRoot, 'short-drama', 'agent.cordis.yml'), 'utf8'),
      { schema: entryListSchema }) as Array<{ id: string; name: string }>
    const guard = productRows.find(row => row.id === 'drama-gate')
    expect(guard).toBeDefined()
    // One registry row plus one adapter row per product composition directory: the
    // Desktop Host assembles its roster exactly this way, and nothing else may add a
    // preset — a shipped or personal preset is not discovered from any directory.
    const presets = (await readdir(productRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump([
      { id: 'system-prompt', name: 'test:prompt' },
      { id: 'tools', name: 'test:tools' },
      guard,
      { id: 'session-projections', name: 'test:projections' },
      { id: 'agent-preset-registry', name: 'test:registry', config: presetConfig },
      ...presets.map(id => ({ id: `preset-${id}`, name: 'test:native', config: { id, directory: join(productRoot, id) } })),
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test:projections', SessionProjections], ['test:registry', AgentPresetRegistry], ['test:native', NativePreset],
      ['test:prompt', SystemPrompt], ['test:tools', Tools], ['@deepseek-ai/dsh-guard-drama', DramaGate],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect((await ctx.agentPresets.list()).map(row => row.id).sort()).toEqual(['cordis', 'creation', 'minimal', 'ptc', 'short-drama', 'standard'])
    expect(ctx.agentPresets.defaultId).toBe('short-drama')
    expect((await ctx.agentPresets.remoteExportList()).presets.map(row => row.id)).toEqual(['short-drama'])
    await expect(ctx.agentPresets.resolveForCreation('creation')).rejects.toMatchObject({ code: 'agent-preset/not-selectable' })
    expect(await ctx.agentPresets.resolve('creation')).toMatchObject({ id: 'creation' })
    const creation = (await ctx.agentPresets.list()).find(row => row.id === 'creation')
    expect(creation?.name).toBeUndefined()
    expect(creation?.description).toBeUndefined()
    const document = await ctx.agentPresets.readDocument('short-drama')
    const source = document.content
    const rows = yaml.load(source, { schema: entryListSchema }) as Array<{ id: string; config?: { prefix?: string } }>
    expect(rows.some(row => row.id === 'tool-jubian')).toBe(false)
    for (const id of ['drama-gate', 'tool-drama-assets', 'tool-character-reference', 'tool-bgm-compose', 'tool-episode-render', 'perception-bgm']) {
      expect(rows.some(row => row.id === id), id).toBe(true)
    }
    expect(rows.find(row => row.id === 'perception-bgm')?.config).toMatchObject({
      catalogUrl: 'https://muse.tos-cn-beijing.volces.com/bgm/index.json',
    })
    expect(source).toContain("fontsDir: !!js process.env.MUSE_FONTS_DIR || 'C:/Windows/Fonts'")
    expect(source).toContain("subtitleFontFamily: !!js process.env.MUSE_FONT_FAMILY || 'SimHei'")
    expect(source).toContain("watermarkFontFamily: !!js process.env.MUSE_FONT_FAMILY || 'Microsoft YaHei'")
    const prompt = rows.find(row => row.id === 'persona')?.config?.prefix ?? ''
    expect(prompt).toContain('你是 muse-med 短剧编导 Agent，由 deepseek-flash 驱动。')
    expect(prompt).toContain('结合实际读过的人物处境、关系、冲突和情绪回报')
    expect(prompt).toContain('理解这部作品可能吸引什么观众、应该带来怎样的观看感受')
    expect(prompt).toContain('不虚构人口画像、市场数据或热度')
    expect(prompt).toContain('普通转写、格式转换不额外增加这套分析')
    expect(prompt).toContain('根据作品的媒介、题材与情绪体验，自主设计适合短剧的形象')
    expect(prompt).toContain('仿真人允许真人摄影质感与电影级玄幻生物、法术和虚构场景融合')
    expect(prompt).toContain('不套用人类面部与无面容三视图版式')
    expect(prompt).not.toContain('3–5个关键动作或场景切换')
    expect(prompt).not.toContain('以15秒视频包为参考')
    expect(prompt).toContain('每镜1–4秒是节奏建议，不是视频包时长上限')
    expect(prompt).toContain('有台词时按8个有效字/秒估算')
    expect(prompt).toContain('原文对白内部不插入引用标记，保持逐字不变')
    expect(prompt).toContain('禁止写入国旗、国徽、党旗、党徽、军旗、军徽')
    expect(prompt).toContain('首次仍逐字使用，不预先修改')
    expect(prompt).toContain('只有确认失败与对应词语有关时')
    expect(prompt).toContain('最小替换或删除，其余台词逐字保留')
    expect(prompt).toContain('禁止改写、删减或替换整段台词')
    expect(prompt).toContain('技术性失败不构成修改台词的理由')
    expect(prompt).toContain('按项目已定画幅设计镜头')
    expect(prompt).toContain('角色资产图固定为16:9横版、白底')
    expect(prompt).toContain('右侧是同一角色的无面容全身三视图')
    expect(prompt).toContain('人物面部同样不写“脸红”“面部发红”')
    expect(prompt).toContain('依据实际成图和成片判断吸引力、情绪与叙事效果')
    expect(prompt).toContain('不凭提示词、参数或任务成功就宣称艺术效果达标')
    expect(rows.some(row => row.id === 'planning')).toBe(false)
    const delegation: unknown = rows.find(row => row.id === 'delegation')?.config
    if (!Array.isArray(delegation)) throw new Error('Missing product delegation group')
    for (const [id, provider] of [['tool-subagent', 'spawn'], ['tool-subagent-fork', 'fork']]) {
      const row: unknown = delegation.find((entry: unknown) => typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === id)
      expect(row).toMatchObject({ id, config: { provider } })
    }
    expect(prompt).not.toContain('pipeline_state.json')
    expect(rows.find(row => row.id === 'tool-shot-script')?.config).toMatchObject({ reviewMode: 'advisory', sessionVideoSelection: true })
    expect((await ctx.agentPresets.resolve('editing')).id).toBe('short-drama')
    const editingSource = (await ctx.agentPresets.readDocument('short-drama')).content
    const editingRows = yaml.load(editingSource, { schema: entryListSchema }) as Array<{ id: string; config?: { prefix?: string } }>
    const editingPrompt = editingRows.find(row => row.id === 'persona')?.config?.prefix ?? ''
    expect(editingPrompt).toBe(prompt)
    expect(editingRows.find(row => row.id === 'persona')?.config).toMatchObject({
      complete: false,
    })
    for (const id of ['agent-instructions', 'tool-fs', 'tool-skill', 'tool-goal', 'tool-web', 'present']) {
      expect(editingRows.some(row => row.id === id), id).toBe(true)
    }
    expect(editingRows.find(row => row.id === 'tool-fs-search')?.config).toMatchObject({ sampleOverCapGlobResults: false })
    const editingSkill = join(productRoot, '..', 'skills', 'editing', 'SKILL.md')
    await expect(readFile(editingSkill, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(`${editingSkill}.disabled`, 'utf8')).toContain('name: muse-script-editing')
    expect(source).not.toMatch(/[CE]:\\|EDY|默认授权|自动授权/)
    let calls = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'jubian_storyboard', description: 'No-network provider fixture',
      parameters: { method: { type: 'string' } },
      async execute() { calls++; return [{ type: 'text', text: 'provider reached' }] },
    }))
    const denied = await ctx.tools.execute({ name: 'jubian_storyboard', arguments: { method: 'generate' },
      callId: ToolCallId('product-guard-denied'), signal: new AbortController().signal })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('idempotency_key')
    expect(calls).toBe(0)
    const allowed = await ctx.tools.execute({ name: 'jubian_storyboard', arguments: { method: 'get' },
      callId: ToolCallId('product-read-allowed'), signal: new AbortController().signal })
    expect(allowed.isError).toBe(false)
    expect(calls).toBe(1)
    await [...ctx.loader.entries()].find(row => row.options.id === 'drama-gate')?.fiber?.dispose()
    await ctx.tools.execute({ name: 'jubian_storyboard', arguments: { method: 'generate' },
      callId: ToolCallId('product-guard-disposed'), signal: new AbortController().signal })
    expect(calls).toBe(2)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
