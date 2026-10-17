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
    expect(prompt).toContain('主动从已读内容与用户要求分析题材、可能吸引的观众')
    expect(prompt).toContain('不虚构人口画像、市场数据或热度')
    expect(prompt).toContain('普通转写、格式转换不额外增加这套分析')
    expect(prompt).toContain('区分画面媒介、题材类型、情绪观感与美术风格')
    expect(prompt).toContain('仿真人允许与真人摄影质感融合的玄幻生物')
    expect(prompt).toContain('不套用人类面部与无面容三视图版式')
    expect(prompt).not.toContain('3–5个关键动作或场景切换')
    expect(prompt).not.toContain('以15秒视频包为参考')
    expect(prompt).toContain('建议每镜1–4秒，有台词时按8个有效字/秒估算')
    expect(prompt).toContain('对白直接跟在对应画面描述后，逐字引用原文台词')
    expect(prompt).toContain('禁止写入国旗、国徽、党旗、党徽、军旗、军徽')
    expect(prompt).toContain('首次仍逐字使用，不预先修改')
    expect(prompt).toContain('只有确认失败与对应词语有关时')
    expect(prompt).toContain('最小替换或删除，其余台词逐字保留')
    expect(prompt).toContain('禁止改写、删减或替换整段台词')
    expect(prompt).toContain('技术性失败不构成修改台词的理由')
    expect(prompt).toContain('按项目已定画幅设计构图')
    expect(prompt).toContain('角色资产图固定为16:9横版、白底')
    expect(prompt).toContain('右侧是同一角色的无面容全身三视图')
    expect(prompt).toContain('人物面部同样不写“脸红”“面部发红”')
    for (const id of ['planning', 'delegation']) expect(rows.some(row => row.id === id)).toBe(false)
    expect(prompt).not.toContain('pipeline_state.json')
    expect(rows.some(row => row.id === 'tool-shot-script')).toBe(false)
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
    const editingSkill = await readFile(join(productRoot, '..', 'skills', 'editing', 'SKILL.md'), 'utf8')
    expect(editingSkill).toContain('检索摘要不等于读过全文')
    expect(editingSkill).not.toContain('不得写正式正文')
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
