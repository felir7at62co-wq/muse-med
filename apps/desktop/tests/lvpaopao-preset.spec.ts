/** The unified director borrows one Host bridge without starting an unconfigured target. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import SubprocessRuntime, { type SubprocessHandle, type SubprocessTerminalEnvironment, type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'
import { bridgeConfigured, lvpaopaoModules, requestBridgeStatus } from './fixtures/lvpaopao-preset.mjs'
import NativePreset from '../../desktop-host/src/native-preset.ts'
import { DESKTOP_SOURCE_PLUGINS } from '../src/core-package-set.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { createDevelopmentProjectMetadata } from '../src/project-manager.ts'

interface Row {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
  readonly insert?: readonly Row[]
}

const hostRoot = new URL('../../desktop-host/', import.meta.url)
const pluginRoot = new URL('../../../third_party/plugins/muse-lvpaopao/', import.meta.url)

async function rows(path: URL): Promise<readonly Row[]> {
  return yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema }) as readonly Row[]
}

class NoSpawn extends SubprocessRuntime {
  calls = 0
  resolveExecutable(): Promise<string> { throw new Error('No executable lookup is expected') }
  terminalEnvironment(): Promise<SubprocessTerminalEnvironment> { throw new Error('No terminal lookup is expected') }
  spawn(): SubprocessHandle { this.calls++; throw new Error('No process may start') }
  spawnTerminal(): Promise<SubprocessTerminalHandle> { this.calls++; throw new Error('No terminal may start') }
}

it('pins the shared provider and scopes its consumer to the single selectable director', async () => {
  const defaults = await rows(new URL('config/defaults.cordis.patch.yml', hostRoot))
  const provider = defaults.flatMap(row => row.insert ?? []).filter(row => row.id === 'muse-lvpaopao-bridge')
  expect(provider).toEqual([{ id: 'muse-lvpaopao-bridge', name: 'muse-lvpaopao/bridge' }])
  expect(defaults.find(row => row.id === 'agent-preset-registry')?.config)
    .toMatchObject({ default: 'short-drama', selectablePresets: ['short-drama'] })
  const bundle = await rows(new URL('cordis.patch.yml', pluginRoot))
  expect(bundle).toEqual([{ insert: provider }])
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis', 'creation', 'short-drama']) {
    const consumer = (await rows(new URL(`presets/${preset}/agent.cordis.yml`, hostRoot)))
      .filter(row => row.id === 'muse-lvpaopao')
    expect(consumer, preset).toEqual(preset === 'short-drama' ? [{ id: 'muse-lvpaopao', name: 'muse-lvpaopao' }] : [])
  }
  expect(DESKTOP_SOURCE_PLUGINS).toContain('muse-lvpaopao')
  const inventory: unknown = JSON.parse(await readFile(new URL('../../../third_party/plugins/owned-downloads.json', import.meta.url), 'utf8'))
  expect(inventory).toMatchObject({ 'muse-lvpaopao': { version: '0.1.0' } })
  const profile = await mkdtemp(join(tmpdir(), 'muse-lvpaopao-bundles-'))
  try {
    createDevelopmentProjectMetadata(profile, { schemaVersion: 1, version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: '22.19.0', pnpmVersion: '10.30.0' })
    const metadata: unknown = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(metadata).toHaveProperty('dsh.profile.bundles', expect.not.arrayContaining(['muse-lvpaopao']))
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

it('loads the actual provider and scoped consumer while an absent connection stays process-free', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-lvpaopao-preset-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Llm)
    await ctx.plugin(Sessions)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NoSpawn)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = lvpaopaoModules()
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader registration') },
      getOrCreateModuleJob() { throw new Error('Unexpected module job') },
      resolveSync() { throw new Error('Unexpected resolver') }, load() { throw new Error('Unexpected module load') },
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected plugin ${specifier}`)
        return modules.get(specifier)
      },
    }
    const defaults = await rows(new URL('config/defaults.cordis.patch.yml', hostRoot))
    const provider = defaults.flatMap(row => row.insert ?? []).find(row => row.id === 'muse-lvpaopao-bridge')
    if (provider === undefined) throw new Error('Missing shared provider row')
    const include = join(directory, 'host.yml')
    await writeFile(include, yaml.dump([{ ...provider, config: { connectionFile: join(directory, 'not-configured.json') } }]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(include).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(bridgeConfigured(ctx)).toBe(false)
    expect(ctx.tools.schemas()).toEqual([])
    const presetDirectory = join(directory, 'short-drama')
    await mkdir(presetDirectory)
    const consumers = (await rows(new URL('presets/short-drama/agent.cordis.yml', hostRoot)))
      .filter(row => row.id === 'muse-lvpaopao')
    await writeFile(join(presetDirectory, 'agent.cordis.yml'), yaml.dump(consumers))
    await writeFile(join(presetDirectory, 'preset.yml'), 'name: 短剧编导\n')
    await ctx.plugin(AgentPresets, { default: 'short-drama', selectablePresets: ['short-drama'] })
    await ctx.plugin(NativePreset, { id: 'short-drama', directory: presetDirectory })
    const create = (id: string) => ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: directory },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'short-drama') } })
    const first = await create('lvpaopao-unconfigured-first')
    const second = await create('lvpaopao-unconfigured-second')
    expect((await ctx.agentPresets.remoteExportList()).presets.map(preset => preset.id)).toEqual(['short-drama'])
    expect((await ctx.agentPresets.resolve('editing')).id).toBe('short-drama')
    expect(ctx.tools.schemas(first.agent).map(tool => tool.name)).toEqual(['lvpaopao'])
    expect(ctx.tools.schemas(second.agent).map(tool => tool.name)).toEqual(['lvpaopao'])
    expect(ctx.tools.schemas()).toEqual([])
    const result = await ctx.tools.execute({ callId: ToolCallId('lvpaopao-unconfigured'), name: 'lvpaopao',
      arguments: { action: 'status' }, agent: first.agent, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('Expected canonical text result')
    const visible: unknown = JSON.parse(block.text)
    expect(visible).toMatchObject({ action: 'status', ok: false, status: 'unconfigured', data: { ready: false } })
    await first.dispose()
    await expect(requestBridgeStatus(ctx, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unconfigured' })
    expect(ctx.tools.schemas(second.agent).map(tool => tool.name)).toEqual(['lvpaopao'])
    expect((ctx.subprocess as NoSpawn).calls).toBe(0)
    await second.dispose()
    await expect(requestBridgeStatus(ctx, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unconfigured' })
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
