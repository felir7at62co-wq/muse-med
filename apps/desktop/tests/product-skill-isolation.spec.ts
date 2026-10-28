import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as yaml from 'js-yaml'
import { expect, it, vi } from 'vitest'
import NativePreset from '../../desktop-host/src/native-preset.ts'
import { desktopSkillDirectories } from '../../desktop-host/src/bundled-skills.ts'

const preset = fileURLToPath(new URL('../../desktop-host/presets/short-drama/agent.cordis.yml', import.meta.url))
const patch = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

it.each(['literal', 'item-expression', 'array-expression', 'config-expression', 'context-expression', 'context-config-expression'])('an actual Agent retains %s custom roots without shared environment roots shadowing them', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-skill-isolation-'))
  const ctx = new Context()
  try {
    const bundled = join(root, 'bundled')
    const legacy = join(root, 'legacy')
    const inherited = join(root, 'inherited-bundle')
    const workspace = join(root, 'workspace')
    const user = join(root, 'muse', 'skills')
    const product = join(root, 'product')
    const custom = join(root, 'custom')
    ctx.provide('dirs', [custom])
    await mkdir(join(workspace, '.git'), { recursive: true })
    await mkdir(product, { recursive: true })
    for (const [directory, name] of [[user, 'user-creative'], [custom, 'custom-creative'],
      [join(workspace, '.muse/skills'), 'project-muse'], [join(workspace, '.dsh/skills'), 'project-dsh'],
      [join(workspace, '.agents/skills'), 'project-agents']] as const) {
      await mkdir(join(directory, name), { recursive: true })
      await writeFile(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Persistent creative skill\n---\n${name} body\n`)
    }
    for (const [directory, label] of [[bundled, 'product'], [join(legacy, 'skills'), 'legacy'], [inherited, 'inherited']] as const) {
      await mkdir(join(directory, 'shared-skill'), { recursive: true })
      await writeFile(join(directory, 'shared-skill', 'SKILL.md'), `---\nname: shared-skill\ndescription: ${label}\n---\n${label} body\n`)
      if (label !== 'product') {
        await mkdir(join(directory, `${label}-only`), { recursive: true })
        await writeFile(join(directory, `${label}-only`, 'SKILL.md'), `---\nname: ${label}-only\ndescription: old\n---\nold body\n`)
      }
    }
    vi.stubEnv('DSH_AGENTS_HOME', legacy)
    vi.stubEnv('DSH_HOME', legacy)
    vi.stubEnv('DSH_BUNDLED_SKILL_DIR', inherited)
    const hostProvider = loadOverlayPatches('muse-med', patch).find(row => row.id === 'skill-filesystem')
    expect(hostProvider).toMatchObject({ disabled: false, config: { includeDefaultRoots: false, includeProjectRoots: true } })
    const profileConfig = mode === 'config-expression' ? { __jsExpr: JSON.stringify({ customSkillDirs: [custom] }) }
      : mode === 'context-config-expression' ? { __jsExpr: '({ customSkillDirs: dirs })' }
        : { customSkillDirs: mode === 'context-expression' ? { __jsExpr: 'dirs' }
          : mode === 'array-expression' ? { __jsExpr: JSON.stringify([custom]) }
            : mode === 'item-expression' ? [{ __jsExpr: JSON.stringify(custom) }] : [custom] }
    const profileRows = [{ insert: [{ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: profileConfig }] }]
    const configuredSkillProvider = composeEntries([profileRows]).find(row => row.id === 'skill-filesystem')
    const protectedRows = composeEntries([profileRows, hostProvider === undefined ? [] : [hostProvider]])
    const hostConfig: unknown = protectedRows.find(row => row.id === 'skill-filesystem')?.config
    expect(hostConfig).not.toHaveProperty('customSkillDirs')
    if (hostConfig === null || typeof hostConfig !== 'object' || Array.isArray(hostConfig)) {
      throw new Error('The product filesystem skill provider must declare an object config')
    }
    const rows = yaml.load(await readFile(preset, 'utf8'), { schema: entryListSchema }) as Array<{ name: string }>
    // This fixture mounts the actual product's entire skill contribution, not its shell/model/media rows.
    const skillRows = rows.filter(row => ['@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill'].includes(row.name))
    expect(skillRows.map(row => row.name)).toEqual(['@deepseek-ai/dsh-tool-skill'])
    const presetRoot = join(root, 'presets')
    await mkdir(join(presetRoot, 'product-skills'), { recursive: true })
    await writeFile(join(presetRoot, 'product-skills', 'agent.cordis.yml'), yaml.dump(skillRows))
    await symlink(fileURLToPath(new URL('../../../packages/bundle/base/node_modules', import.meta.url)),
      join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump([
      ...['llm', 'sessions', 'projections', 'prompt', 'tools', 'agents', 'loop', 'skills'].map(id => ({
        id, name: `test:${id}`, ...(id === 'loop' ? { config: { agents: [] } } : {}),
      })),
      { ...hostProvider, name: '@deepseek-ai/dsh-skill-filesystem', config: { ...hostConfig, bundledSkillDir: bundled, watch: false,
        customSkillDirs: desktopSkillDirectories(product, user, configuredSkillProvider?.config) } },
      { id: 'presets', name: 'test:presets', config: { default: 'product-skills' } },
      { id: 'preset-product-skills', name: 'test:native', config: { id: 'product-skills', directory: join(presetRoot, 'product-skills') } },
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test:llm', Llm], ['test:sessions', Sessions], ['test:projections', SessionProjections],
      ['test:prompt', SystemPrompt], ['test:tools', Tools], ['test:agents', AgentRegistry],
      ['test:loop', AgentLoop], ['test:skills', Skills], ['test:presets', AgentPresets],
      ['test:native', NativePreset],
      ['@deepseek-ai/dsh-skill-filesystem', SkillFilesystem], ['@deepseek-ai/dsh-tool-skill', ToolSkill],
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
    const handle = await ctx.agents.create({ sessionId: SessionId('product-skill-scope'), meta: { cwd: workspace },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx) } })
    const options = { scope: scopeOf(handle.agent.ctx), cwd: workspace }
    expect((await ctx.skills.list(options)).map(skill => skill.name)).toEqual(['custom-creative', 'project-agents', 'project-dsh', 'project-muse', 'shared-skill', 'user-creative'])
    const content: unknown = expect.stringContaining('product body')
    expect(await ctx.skills.get('shared-skill', options)).toMatchObject({ source: 'bundled', content })
    const preserved = await readFile(join(custom, 'custom-creative', 'SKILL.md'), 'utf8')
    await ctx.fiber.dispose()
    const restarted = new Context()
    try {
      await restarted.plugin(Skills)
      await restarted.plugin(SkillFilesystem, { ...hostConfig, bundledSkillDir: bundled, watch: false,
        customSkillDirs: [product, user, custom] })
      expect((await restarted.skills.list({ cwd: workspace })).map(skill => skill.name)).toEqual([
        'custom-creative', 'project-agents', 'project-dsh', 'project-muse', 'shared-skill', 'user-creative',
      ])
      expect(await readFile(join(custom, 'custom-creative', 'SKILL.md'), 'utf8')).toBe(preserved)
    } finally { await restarted.fiber.dispose() }

  } finally {
    vi.unstubAllEnvs()
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
