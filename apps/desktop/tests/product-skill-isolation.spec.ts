import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
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

const preset = fileURLToPath(new URL('../../desktop-host/presets/short-drama-local/agent.cordis.yml', import.meta.url))
const patch = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

it('an actual Agent inherits bundled skills without legacy environment roots shadowing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-skill-isolation-'))
  const ctx = new Context()
  try {
    const bundled = join(root, 'bundled')
    const legacy = join(root, 'legacy')
    const inherited = join(root, 'inherited-bundle')
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
    const hostProvider = loadOverlayPatches('dsh desktop', patch).find(row => row.id === 'skill-filesystem')
    expect(hostProvider).toMatchObject({ disabled: false, config: { includeDefaultRoots: false } })
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
      { ...hostProvider, name: '@deepseek-ai/dsh-skill-filesystem', config: { ...hostProvider?.config, bundledSkillDir: bundled, watch: false } },
      { id: 'presets', name: 'test:presets', config: { default: 'product-skills', includeShippedRoot: false, includeUserRoot: false, roots: [{ path: presetRoot, trust: 'system' }] } },
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test:llm', Llm], ['test:sessions', Sessions], ['test:projections', SessionProjections],
      ['test:prompt', SystemPrompt], ['test:tools', Tools], ['test:agents', AgentRegistry],
      ['test:loop', AgentLoop], ['test:skills', Skills], ['test:presets', AgentPresets],
      ['@deepseek-ai/dsh-skill-filesystem', SkillFilesystem], ['@deepseek-ai/dsh-tool-skill', ToolSkill],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const handle = await ctx.agents.create({ sessionId: SessionId('product-skill-scope'),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx) } })
    const options = { scope: scopeOf(handle.agent.ctx) }
    expect((await ctx.skills.list(options)).map(skill => skill.name)).toEqual(['shared-skill'])
    expect(await ctx.skills.get('shared-skill', options)).toMatchObject({ source: 'bundled', content: expect.stringContaining('product body') })
  } finally {
    vi.unstubAllEnvs()
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
