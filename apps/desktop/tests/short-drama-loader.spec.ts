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

const presetPath = fileURLToPath(new URL('../../../packages/preset/agent-presets/presets/short-drama/agent.cordis.yml', import.meta.url))
const hostPatch = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const bundledSkillDir = fileURLToPath(new URL('../../../packages/drama/skills/skills', import.meta.url))

it('loads desktop Jubian on the Host and short-drama skill tools from the bundled source root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-short-drama-loader-'))
  const ctx = new Context()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected Jubian request') })
  try {
    const presetRows = yaml.load(await readFile(presetPath, 'utf8'), { schema: entryListSchema }) as Array<{ id: string; name: string; config?: object }>
    const hostRows = loadOverlayPatches('muse-med', hostPatch).flatMap(patch => patch.insert ?? [])
    const jubian = hostRows.find(row => row.id === 'tool-jubian')
    const filesystem = presetRows.find(row => row.id === 'skill-filesystem')
    const skill = presetRows.find(row => row.id === 'tool-skill')
    expect(jubian?.name).toBe('@deepseek-ai/dsh-tool-jubian')
    expect(filesystem?.name).toBe('@deepseek-ai/dsh-skill-filesystem')
    expect(skill?.name).toBe('@deepseek-ai/dsh-tool-skill')
    expect(presetRows.some(row => row.id === 'tool-jubian')).toBe(false)
    if (!jubian || !filesystem || !skill) throw new Error('Missing short-drama or Desktop Host row')
    const jubianConfig = jubian.config as Record<string, unknown> | undefined

    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump([
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'agents', name: '@deepseek-ai/dsh-agent' },
      { id: 'skills', name: '@deepseek-ai/dsh-skill' },
      { id: 'credentials', name: 'test:credentials' },
      { ...filesystem, config: { ...filesystem.config, includeDefaultRoots: false, bundledSkillDir, watch: false } },
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
