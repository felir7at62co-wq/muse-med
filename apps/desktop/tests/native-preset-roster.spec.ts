/**
 * The product roster: which presets it publishes, and that the compositions
 * beyond the original pair actually mount.
 *
 * A hand-built `ctx.plugin(...)` suite cannot answer either question. The roster
 * is discovered from the product's own preset directory, discovery refuses to
 * hand out a preset whose rows do not resolve, and a native composition resolves
 * its rows through the adapter's own `import`. These cases therefore boot a
 * Loader, point the real `agent-presets` row at the product root over a
 * `node_modules` that links the workspace packages the compositions name, and
 * mount through `AgentPresets.standingKeyFor`, which composes the preset and
 * rejects any composition whose rows did not become usable.
 *
 * The Host composition that supplies services such as `fs` and `subagents` is
 * out of this suite's scope, so a case supplies the real module for every row it
 * asserts on and loads the rest as plugins that contribute nothing. The
 * packaged-runtime smoke (`scripts/smoke-runtime.ts`) is the check that activates
 * all five presets against the real Host.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Skills from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'
import NativePreset from '../../desktop-host/src/native-preset.ts'

const productRoot = fileURLToPath(new URL('../../desktop-host/presets', import.meta.url))
const patchPath = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

/** A row this case does not assert on, loaded as a plugin that contributes nothing. */
const INERT = { apply() {} }

/** Every workspace package directory, keyed by manifest name. */
async function workspacePackages(): Promise<Map<string, string>> {
  const directories: string[] = []
  for (const group of await readdir(join(repositoryRoot, 'packages'))) {
    for (const entry of await readdir(join(repositoryRoot, 'packages', group)).catch(() => [])) {
      directories.push(join(repositoryRoot, 'packages', group, entry))
    }
  }
  for (const app of await readdir(join(repositoryRoot, 'apps'))) {
    directories.push(join(repositoryRoot, 'apps', app))
  }
  const found = new Map<string, string>()
  for (const directory of directories) {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').catch(() => undefined)
    if (manifest === undefined) continue
    const name = (JSON.parse(manifest) as { name?: string }).name
    if (name !== undefined) found.set(name, directory)
  }
  return found
}

/** Every package specifier the five product compositions name, nested groups included. */
async function productSpecifiers(): Promise<Set<string>> {
  const specifiers = new Set<string>()
  const collect = (rows: readonly unknown[]): void => {
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const { name, config } = row as { name?: unknown; config?: unknown }
      if (typeof name === 'string' && !name.startsWith('cordis:') && !name.startsWith('.') && !name.includes(':')) {
        specifiers.add(name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/'))
      }
      if (Array.isArray(config)) collect(config)
    }
  }
  for (const id of await readdir(productRoot)) {
    const source = await readFile(join(productRoot, id, 'agent.cordis.yml'), 'utf8')
    collect(yaml.load(source, { schema: entryListSchema }) as readonly unknown[])
  }
  return specifiers
}

/** Link every named workspace package under one temporary root's `node_modules`. */
async function linkWorkspacePackages(root: string, names: Iterable<string>): Promise<void> {
  const packages = await workspacePackages()
  for (const name of names) {
    const target = packages.get(name)
    if (target === undefined) continue
    const link = join(root, 'node_modules', ...name.split('/'))
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

/**
 * Boot a Loader over the real product roster.
 * @param modules - modules the composition rows resolve, keyed by specifier.
 * @param run - receives the booted context; the harness disposes it afterwards.
 * @param fallback - module for rows this case does not assert on; absent leaves
 * an unmapped specifier a failure, so a case can require every row it mounts.
 */
async function withRoster(
  modules: ReadonlyMap<string, unknown>,
  run: (ctx: Context) => Promise<void>,
  fallback?: unknown,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'muse-preset-roster-'))
  const ctx = new Context()
  try {
    await linkWorkspacePackages(root, await productSpecifiers())
    const presetConfig = loadOverlayPatches('muse-med', patchPath).find(row => row.id === 'agent-presets')?.config
    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump([
      { id: 'system-prompt', name: 'test:prompt' },
      { id: 'tools', name: 'test:tools' },
      { id: 'session-projections', name: 'test:projections' },
      { id: 'skills', name: 'test:skills' },
      {
        id: 'agent-presets',
        name: 'test:presets',
        config: { ...presetConfig as object, roots: [{ path: productRoot, trust: 'system' }] },
      },
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    // Host-plane services the terminal stack's executors inject. This suite
    // never runs a shell, so the slots only have to resolve for the row to
    // activate; the executors themselves are out of scope here.
    ctx.provide('sandboxPolicy', { mode: 'danger-full-access', workspaceRoot: root } as never)
    ctx.provide('subprocess', { spawn() { throw new Error('the product roster suite never spawns a subprocess') } } as never)
    ctx.loader.builtins.include = Include
    // Every native composition nests rows in `cordis:group` rows, which only
    // mount when the Loader carries this builtin.
    ctx.loader.builtins.group = Group
    const host = new Map<string, unknown>([
      ['test:prompt', SystemPrompt], ['test:tools', Tools],
      ['test:projections', SessionProjections], ['test:skills', Skills], ['test:presets', AgentPresets],
      ['@deepseek-ai/dsh-desktop-host/native-preset', { default: NativePreset }],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      const found = host.get(specifier) ?? modules.get(specifier) ?? fallback
      if (found === undefined) throw new Error(`Unexpected module ${specifier}`)
      return found
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await run(ctx)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

it('publishes exactly the five product presets in declared order, including every native composition', async () => {
  await withRoster(new Map(), async (ctx) => {
    const roster = await ctx.agentPresets.list()
    expect(roster.map(preset => preset.id)).toEqual(['standard', 'ptc', 'minimal', 'cordis', 'short-drama'])
    expect(roster.map(preset => preset.trust)).toEqual(['system', 'system', 'system', 'system', 'system'])
    // Discovery's health verdict: every row of every preset names a package the
    // product tree resolves, which is what a mount would need first.
    expect(roster.filter(preset => preset.broken !== undefined)).toEqual([])
    expect(ctx.agentPresets.defaultId).toBe('short-drama')
    expect(ctx.agentPresets.authorable).toBe(false)
  })
})

it('mounts the minimal composition with the persistent shell inside its group', async () => {
  // Every row of this composition is the real plugin: its whole point is the
  // shell published from inside a nested group.
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-persona', await import('@deepseek-ai/dsh-persona')],
    ['@deepseek-ai/dsh-terminal', await import('@deepseek-ai/dsh-terminal')],
    ['@deepseek-ai/dsh-terminal-bash', await import('@deepseek-ai/dsh-terminal-bash')],
    ['@deepseek-ai/dsh-tool-bash-persistent', await import('@deepseek-ai/dsh-tool-bash-persistent')],
    ['@deepseek-ai/dsh-tool-pwsh-persistent', await import('@deepseek-ai/dsh-tool-pwsh-persistent')],
  ])
  await withRoster(modules, async (ctx) => {
    const key = await ctx.agentPresets.standingKeyFor('minimal')
    expect(ctx.tools.schemas(key).map(tool => tool.name))
      .toContain(process.platform === 'win32' ? 'pwsh' : 'bash')
  })
})

it('mounts the cordis composition with the authoring skills its persona names', async () => {
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-persona', await import('@deepseek-ai/dsh-persona')],
    ['@deepseek-ai/dsh-skill-filesystem', await import('@deepseek-ai/dsh-skill-filesystem')],
  ])
  await withRoster(modules, async (ctx) => {
    const key = await ctx.agentPresets.standingKeyFor('cordis')
    const names = (await ctx.skills.list({ scope: key })).map(skill => skill.name)
    expect(names).toContain('editing-cordis-compositions')
    expect(names).toContain('cordis-plugin-development')
  }, INERT)
})

it('leaves standard and ptc without a skill provider of their own', async () => {
  // The Host owns the only provider that selects default roots. Both adapters
  // disable the composition's nearer provider, so a real one here would register.
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-skill-filesystem', await import('@deepseek-ai/dsh-skill-filesystem')],
  ])
  await withRoster(modules, async (ctx) => {
    for (const id of ['standard', 'ptc']) {
      const key = await ctx.agentPresets.standingKeyFor(id)
      expect(await ctx.skills.list({ scope: key })).toEqual([])
    }
  }, INERT)
})
