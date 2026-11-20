import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
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
import * as ToolJingliu from '@deepseek-ai/dsh-tool-jingliu'
import JingliuConnection from '@deepseek-ai/dsh-jingliu-connection'
import Commands from '@deepseek-ai/dsh-commands'
import { SHORT_DRAMA_GUIDANCE } from '../../desktop-host/src/short-drama-guidance.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as yaml from 'js-yaml'
import { expect, it, vi } from 'vitest'

// The product's own composition, the one the desktop roster registers as `short-drama`.
const presetPath = fileURLToPath(new URL('../../desktop-host/presets/short-drama/agent.cordis.yml', import.meta.url))
const hostPatch = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const bundledSkillDir = fileURLToPath(new URL('../../../packages/drama/skills/skills', import.meta.url))

it('loads desktop Jingliu on the Host and short-drama skill tools from the bundled source root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-short-drama-loader-'))
  const ctx = new Context()
  vi.stubEnv('MUSE_HOME', root)
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('DSH_FFMPEG_PATH', undefined)
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected Jubian request') })
  try {
    const presetRows = yaml.load(await readFile(presetPath, 'utf8'), { schema: entryListSchema }) as Array<{ id: string; name: string; config?: Record<string, unknown> }>
    const hostPatches = loadOverlayPatches('muse-med', hostPatch)
    const plugins = hostPatches.flatMap(patch => patch.insert ?? [])
    const jingliu = plugins.find(row => row.id === 'tool-jingliu')
    const connection = plugins.find(row => row.id === 'jingliu-connection')
    // Jubian is an optional second channel on the Host, mounted without its conversation video selector.
    const jubian = plugins.find(row => row.name === '@deepseek-ai/dsh-tool-jubian')
    expect(jubian).toMatchObject({ id: 'tool-jubian', config: { generationWatch: true, imagePlatformId: 'KU_AI', videoRecoverySettings: true } })
    expect(jubian).not.toHaveProperty('config.sessionVideoSelection')
    // The Host owns the only skill provider: the presets declare none, and the overlay is where
    // that provider's row comes from (its runtime directories arrive from `src/index.ts`).
    const provider = hostPatches.find(row => row.id === 'skill-filesystem')
    const skill = presetRows.find(row => row.id === 'tool-skill')
    const persona = presetRows.find(row => row.id === 'persona')?.config
    expect(jingliu?.name).toBe('@deepseek-ai/dsh-tool-jingliu')
    expect(provider?.config).toMatchObject({ includeDefaultRoots: false })
    expect(skill?.name).toBe('@deepseek-ai/dsh-tool-skill')
    expect(persona).toMatchObject({ complete: false })
    expect(persona?.prefix).toContain('你是 muse-med 短剧编导 Agent')
    expect(presetRows.find(row => row.id === 'editing-policy')?.name).toBe('@deepseek-ai/dsh-desktop-host/editing-policy')
    expect(persona?.prefix).toContain('jingliu_workflows')
    expect(presetRows.some(row => row.id === 'planning')).toBe(false)
    expect(presetRows.find(row => row.id === 'delegation')).toMatchObject({
      name: 'cordis:group', group: true, config: [
        { id: 'delegation-policy', name: '@deepseek-ai/dsh-desktop-host/delegation-policy' },
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent' } },
        { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
      ],
    })
    expect(persona?.prefix).not.toContain('Check the [exit code')
    expect(persona?.suffix).toContain('short-drama/')
    expect(persona?.suffix).not.toContain('{{cwd}}')
    expect(presetRows.find(row => row.id === 'tool-shot-script')).toMatchObject({
      name: '@deepseek-ai/dsh-tool-shot-script',
      config: { reviewMode: 'advisory' },
    })
    expect(presetRows.some(row => row.id === 'tool-jubian')).toBe(false)
    expect(presetRows.some(row => row.id === 'skill-filesystem')).toBe(false)
    if (!jingliu || !connection || !provider || !skill) throw new Error('Missing short-drama or Desktop Host row')
    const providerConfig: unknown = provider.config
    if (typeof providerConfig !== 'object' || providerConfig === null || Array.isArray(providerConfig)) {
      throw new Error('Missing skill provider config')
    }

    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump([
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'native-executor', name: 'test:native-executor' },
      { id: 'fs', name: 'test:fs' },
      { id: 'subprocess', name: 'test:subprocess' },
      { id: 'projections', name: 'test:projections' },
      { id: 'working-directory', name: 'test:working-directory' },
      { id: 'agents', name: '@deepseek-ai/dsh-agent' },
      { id: 'skills', name: '@deepseek-ai/dsh-skill' },
      { id: 'credentials', name: 'test:credentials' },
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem',
        config: { ...providerConfig, bundledSkillDir, watch: false } },
      skill,
      { id: 'commands', name: 'test:commands' },
      { ...connection, config: {} }, jingliu,
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test:native-executor', NativeExecutor],
      ['test:subprocess', SubprocessLocal],
      ['test:fs', LocalFileSystem], ['test:projections', SessionProjections], ['test:working-directory', WorkingDirectory],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-skill', SkillRegistry],
      ['test:credentials', MemoryCredentials], ['@deepseek-ai/dsh-skill-filesystem', SkillFilesystem],
      ['@deepseek-ai/dsh-tool-skill', ToolSkill], ['@deepseek-ai/dsh-tool-jingliu', ToolJingliu],
      ['@deepseek-ai/dsh-jingliu-connection', JingliuConnection], ['test:commands', Commands],
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

    expect(ctx.get('jubianImage')).toBeUndefined()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
    expect(ctx.tools.get('jingliu_run')).toBeDefined()
    const unavailable = await executeModelToolFixture(ctx, { name: 'jingliu_workflows', arguments: {},
      callId: ToolCallId('unconfigured-jingliu'), signal: new AbortController().signal })
    expect(unavailable.isError).toBe(true)
    expect(JSON.stringify(unavailable.content)).toContain('配置')
    const listed = await ctx.skills.list()
    expect(listed.map(row => row.name)).not.toContain('jubian-asset-library')
    expect(listed.map(row => row.name)).toContain('tweet-drama-asset-vision-check')
    expect(listed.map(row => row.name)).not.toContain('tweet-drama-core')
    expect(listed.find(row => row.name === 'protagonist-asset-sheet')).toMatchObject({
      source: 'bundled', provider: 'filesystem', invocation: { modelInvocable: true },
    })
    const protagonist = await executeModelToolFixture(ctx, { name: 'skill', arguments: { name: 'protagonist-asset-sheet' },
      callId: ToolCallId('short-drama-protagonist'), signal: new AbortController().signal })
    expect(protagonist.isError).toBe(false)
    const protagonistBlock = protagonist.content[0]
    if (protagonistBlock?.type !== 'text') throw new Error('Expected protagonist skill content')
    if (typeof persona?.prefix !== 'string') throw new Error('Expected short-drama persona prefix')
    expect(presetRows.find(row => row.id === 'short-drama-guidance')?.name).toBe('@deepseek-ai/dsh-desktop-host/short-drama-guidance')
    const protagonistGuidance = SHORT_DRAMA_GUIDANCE.match(/生成、重绘主角形象[^。]+protagonist-asset-sheet[^。]+。/u)?.[0]
    if (!protagonistGuidance) throw new Error('Missing protagonist skill guidance')
    await expect([
      '# Short-drama protagonist guidance', '', protagonistGuidance.trim(), '',
      '# Loaded protagonist skill', '',
      protagonistBlock.text.replaceAll(join(bundledSkillDir, 'protagonist-asset-sheet'), '<bundled-skills>/protagonist-asset-sheet'), '',
    ].join('\n')).toMatchFileSnapshot('./expected/protagonist-asset-sheet.expected.md')
    const loaded = await executeModelToolFixture(ctx, { name: 'skill', arguments: { name: 'tweet-drama-core' },
      callId: ToolCallId('short-drama-skill'), signal: new AbortController().signal })
    expect(loaded.isError).toBe(true)
    const pipeline = await executeModelToolFixture(ctx, { name: 'skill', arguments: { name: 'tweet-drama-pipeline' },
      callId: ToolCallId('short-drama-pipeline'), signal: new AbortController().signal })
    expect(listed.map(row => row.name)).not.toContain('tweet-drama-pipeline')
    expect(pipeline.isError).toBe(true)
    expect(fetch).not.toHaveBeenCalled()

    const entries = [...ctx.loader.entries()]
    await entries.find(row => row.options.id === 'tool-jingliu')?.fiber?.dispose()
    expect(ctx.tools.get('jingliu_run')).toBeUndefined()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
    await entries.find(row => row.options.id === 'skill-filesystem')?.fiber?.dispose()
    expect(await ctx.skills.list()).toEqual([])
    await entries.find(row => row.options.id === 'tool-skill')?.fiber?.dispose()
    expect(ctx.tools.get('skill')).toBeUndefined()
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
})
