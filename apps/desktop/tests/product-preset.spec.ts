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
const patchPath = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

it('loads exactly the six product modes without discovering other shipped or personal presets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-product-preset-'))
  const ctx = new Context()
  try {
    const patch = loadOverlayPatches('muse-med', patchPath).find(row => row.id === 'agent-preset-registry')
    const presetConfig = patch?.config as Record<string, unknown> | undefined
    expect(presetConfig).toMatchObject({ default: 'short-drama' })
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
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect((await ctx.agentPresets.list()).map(row => row.id).sort()).toEqual(['cordis', 'editing', 'minimal', 'ptc', 'short-drama', 'standard'])
    expect(ctx.agentPresets.defaultId).toBe('short-drama')
    const document = await ctx.agentPresets.readDocument('short-drama')
    const source = document.content
    const rows = yaml.load(source, { schema: entryListSchema }) as Array<{ id: string; config?: { prefix?: string } }>
    expect(rows.some(row => row.id === 'tool-jubian')).toBe(false)
    for (const id of ['drama-gate', 'tool-drama-assets', 'tool-shot-script', 'tool-bgm-compose', 'tool-episode-render', 'perception-bgm']) {
      expect(rows.some(row => row.id === id), id).toBe(true)
    }
    expect(rows.find(row => row.id === 'perception-bgm')?.config).toMatchObject({
      catalogUrl: 'https://muse.tos-cn-beijing.volces.com/bgm/index.json',
    })
    expect(source).toContain("fontsDir: !!js process.env.MUSE_FONTS_DIR || 'C:/Windows/Fonts'")
    expect(source).toContain("subtitleFontFamily: !!js process.env.MUSE_FONT_FAMILY || 'SimHei'")
    expect(source).toContain("watermarkFontFamily: !!js process.env.MUSE_FONT_FAMILY || 'Microsoft YaHei'")
    const prompt = rows.find(row => row.id === 'persona')?.config?.prefix ?? ''
    for (const requirement of ['pipeline_state.json', 'assets_manifest.json', '1440×2560', '4.6 Mbps', 'asr_aligned', 'idempotency_key', 'CC-BY-NC-4.0', 'scriptName', 'episodeCount', 'stale']) {
      expect(prompt, requirement).toContain(requirement)
    }
    for (const requirement of ['自主检索', '来源页和许可', 'agent_review', '用户图仍需确认', '不自动安装或启动小红书']) {
      expect(prompt, requirement).toContain(requirement)
    }
    for (const requirement of ['整批提示词', 'image_generate_batch', '逐项验收']) {
      expect(prompt, requirement).toContain(requirement)
    }
    const editingSource = (await ctx.agentPresets.readDocument('editing')).content
    const editingRows = yaml.load(editingSource, { schema: entryListSchema }) as Array<{ id: string; config?: { prefix?: string } }>
    const editingPrompt = editingRows.find(row => row.id === 'persona')?.config?.prefix ?? ''
    const editingModelInput = JSON.parse(await readFile(new URL('./expected/editing-model-input.json', import.meta.url), 'utf8')) as {
      personaPrefix: string
    }
    expect(editingPrompt).toBe(editingModelInput.personaPrefix)
    expect(editingPrompt).toContain('正式写作前')
    expect(editingPrompt).toContain('爆款剧本')
    expect(editingPrompt).toContain('实际阅读')
    for (const id of ['agent-instructions', 'editing-tools', 'tool-fs', 'tool-skill', 'tool-goal', 'tool-web', 'present']) {
      expect(editingRows.some(row => row.id === id), id).toBe(true)
    }
    const editingSkill = await readFile(join(productRoot, '..', 'skills', 'editing', 'SKILL.md'), 'utf8')
    expect(editingSkill).toContain('单页不够时继续分页')
    expect(editingSkill).toContain('不得写正式正文')
    expect(source).not.toMatch(/[CE]:\\|EDY|默认授权|自动授权/)
    for (const requirement of ['每集至少 2 首不同曲目', '按情绪分段', 'policy_findings', '1.5 秒三角交叉淡化', '24 小时', 'max_review_attempts=3', 'content_duration_ms', '离线、不外传', '不自动删除', '片尾 2 秒', '被委派的子代理只返回调用方要的分片结果', '给了 schema 就用 structured_output 返回']) {
      expect(prompt, requirement).toContain(requirement)
    }
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
