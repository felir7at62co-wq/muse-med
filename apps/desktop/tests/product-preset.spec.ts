import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as DramaGate from '@deepseek-ai/dsh-guard-drama'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

const productRoot = fileURLToPath(new URL('../../desktop-host/presets', import.meta.url))
const patchPath = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

it('loads exactly the five product modes without discovering other shipped or personal presets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-product-preset-'))
  const ctx = new Context()
  try {
    const patch = loadOverlayPatches('muse-med', patchPath).find(row => row.id === 'agent-presets')
    const presetConfig = patch?.config as Record<string, unknown> | undefined
    expect(presetConfig).toMatchObject({ default: 'short-drama', includeShippedRoot: false, includeUserRoot: false })
    const productRows = yaml.load(await readFile(join(productRoot, 'short-drama', 'agent.cordis.yml'), 'utf8'),
      { schema: entryListSchema }) as Array<{ id: string; name: string }>
    const guard = productRows.find(row => row.id === 'drama-gate')
    expect(guard).toBeDefined()
    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump([
      { id: 'system-prompt', name: 'test:prompt' },
      { id: 'tools', name: 'test:tools' },
      guard,
      { id: 'session-projections', name: 'test:projections' },
      { id: 'agent-presets', name: 'test:presets', config: { ...presetConfig, roots: [{ path: productRoot, trust: 'system' }] } },
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test:projections', SessionProjections], ['test:presets', AgentPresets],
      ['test:prompt', SystemPrompt], ['test:tools', Tools], ['@deepseek-ai/dsh-guard-drama', DramaGate],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect((await ctx.agentPresets.list()).map(row => row.id).sort()).toEqual(['cordis', 'minimal', 'ptc', 'short-drama', 'standard'])
    expect(ctx.agentPresets.defaultId).toBe('short-drama')
    expect(ctx.agentPresets.authorable).toBe(false)
    const source = await ctx.agentPresets.read('short-drama')
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
    for (const requirement of ['用户提供的参考图', '逐图审核和用户确认', '不自动安装或启动小红书']) {
      expect(prompt, requirement).toContain(requirement)
    }
    expect(source).not.toMatch(/[CE]:\\|EDY|默认授权|自动授权/)
    for (const requirement of ['每集至少 2 首不同曲目', '按情绪分段', 'policy_findings', '1.5 秒三角交叉淡化', '24 小时', 'max_review_attempts=3', 'content_duration_ms', '离线、不外传', '不自动删除', '片尾 2 秒']) {
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
