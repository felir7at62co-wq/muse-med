import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { MemoryCredentials } from '../../../packages/credentials/credentials/tests/memory.ts'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as Jubian from '@deepseek-ai/dsh-tool-jubian'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as yaml from 'js-yaml'
import { expect, it, vi } from 'vitest'

// The product's own composition, the one the desktop roster registers as `short-drama`.
const presetPath = fileURLToPath(new URL('../../desktop-host/presets/short-drama/agent.cordis.yml', import.meta.url))
const hostPatch = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const bundledSkillDir = fileURLToPath(new URL('../../../packages/drama/skills/skills', import.meta.url))

it('loads desktop Jubian on the Host and short-drama skill tools from the bundled source root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-short-drama-loader-'))
  const ctx = new Context()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected Jubian request') })
  try {
    const presetRows = yaml.load(await readFile(presetPath, 'utf8'), { schema: entryListSchema }) as Array<{ id: string; name: string; config?: Record<string, unknown> }>
    const hostPatches = loadOverlayPatches('muse-med', hostPatch)
    const jubian = hostPatches.flatMap(patch => patch.insert ?? []).find(row => row.id === 'tool-jubian')
    // The Host owns the only skill provider: the presets declare none, and the overlay is where
    // that provider's row comes from (its runtime directories arrive from `src/index.ts`).
    const provider = hostPatches.find(row => row.id === 'skill-filesystem')
    const skill = presetRows.find(row => row.id === 'tool-skill')
    const persona = presetRows.find(row => row.id === 'persona')?.config
    expect(jubian?.name).toBe('@deepseek-ai/dsh-tool-jubian')
    expect(provider?.config).toMatchObject({ includeDefaultRoots: false })
    expect(skill?.name).toBe('@deepseek-ai/dsh-tool-skill')
    expect(persona?.prefix).toContain('分集脚本、镜头包编写')
    expect(persona?.prefix).toContain('image_generate_batch')
    expect(persona?.prefix).toContain('全部视频包')
    expect(persona?.prefix).toContain('同轮并行提交')
    expect(persona?.prefix).toContain('submit_video_batch')
    expect(persona?.prefix).toContain('DUO_YUAN_TAN_SUO')
    expect(persona?.prefix).toContain('成片 MP4 与可在剪映继续编辑的草稿工程')
    expect(presetRows.some(row => row.id === 'tool-jubian')).toBe(false)
    expect(presetRows.some(row => row.id === 'skill-filesystem')).toBe(false)
    if (!jubian || !provider || !skill) throw new Error('Missing short-drama or Desktop Host row')
    const providerConfig: unknown = provider.config
    if (typeof providerConfig !== 'object' || providerConfig === null || Array.isArray(providerConfig)) {
      throw new Error('Missing skill provider config')
    }
    const jubianConfig = jubian.config as Record<string, unknown> | undefined

    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump([
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'agents', name: '@deepseek-ai/dsh-agent' },
      { id: 'skills', name: '@deepseek-ai/dsh-skill' },
      { id: 'credentials', name: 'test:credentials' },
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem',
        config: { ...providerConfig, bundledSkillDir, watch: false } },
      skill,
      { ...jubian, config: { ...jubianConfig, workspaceSecrets: false, ledgerRoot: join(root, 'ledger') } },
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-skill', SkillRegistry],
      ['test:credentials', MemoryCredentials], ['@deepseek-ai/dsh-skill-filesystem', SkillFilesystem],
      ['@deepseek-ai/dsh-tool-skill', ToolSkill], ['@deepseek-ai/dsh-tool-jubian', Jubian],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()

    expect(ctx.get('jubianImage')).toBeDefined()
    expect(ctx.tools.get('jubian_video')?.description).toContain('image_generate 会真实计费')
    const listed = await ctx.skills.list()
    expect(listed.find(row => row.name === 'tweet-drama-core')).toMatchObject({ source: 'bundled', provider: 'filesystem' })
    const loaded = await ctx.tools.execute({ name: 'skill', arguments: { name: 'tweet-drama-core' },
      callId: ToolCallId('short-drama-skill'), signal: new AbortController().signal })
    expect(loaded.isError).toBe(false)
    const block = loaded.content[0]
    if (block?.type !== 'text') throw new Error('Expected rendered skill content')
    expect(block.text).toContain('pipeline_state.json')
    const pipeline = await ctx.tools.execute({ name: 'skill', arguments: { name: 'tweet-drama-pipeline' },
      callId: ToolCallId('short-drama-pipeline'), signal: new AbortController().signal })
    expect(pipeline.isError).toBe(false)
    const pipelineBlock = pipeline.content[0]
    if (pipelineBlock?.type !== 'text') throw new Error('Expected pipeline skill content')
    expect(pipelineBlock.text).toContain('默认按独立项目实体开并行批次')
    expect(pipelineBlock.text).toContain('image_generate_batch')
    expect(pipelineBlock.text).toContain('先检查整批提示词')
    expect(pipelineBlock.text).toContain('全部视频包')
    expect(pipelineBlock.text).toContain('同轮并行提交')
    expect(pipelineBlock.text).toContain('submit_video_batch')
    expect(pipelineBlock.text).toContain('最终回复同时交付成片、剪映草稿工程及其引用素材的路径')
    expect(fetch).not.toHaveBeenCalled()

    const entries = [...ctx.loader.entries()]
    await entries.find(row => row.options.id === 'tool-jubian')?.fiber?.dispose()
    expect(ctx.get('jubianImage')).toBeUndefined()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
    await entries.find(row => row.options.id === 'skill-filesystem')?.fiber?.dispose()
    expect(await ctx.skills.list()).toEqual([])
    await entries.find(row => row.options.id === 'tool-skill')?.fiber?.dispose()
    expect(ctx.tools.get('skill')).toBeUndefined()
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
