/**
 * A preset id that a durable record still names must keep resolving after the
 * directory that answered it is renamed: a session's creation header and its
 * `agent-preset/selected` events are permanent, and this version has no alias
 * mechanism. `DEPRECATED_PRESET_IDS` is the resolution-only answer — it must
 * never reach the roster, and it must never shadow a root that still supplies
 * the old id.
 *
 * `$DSH_HOME` is repointed per test because the derived user root is resolved in
 * the constructor: the plugin must be mounted while the environment names the
 * temporary home, or it would reach the developer's real one.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AgentPresets, {
  agentPresetProjectionDefinition, COMPOSITION_FILE, SHIPPED_PRESET_ROOT, type Config,
} from '@deepseek-ai/dsh-agent-presets'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const USER_ROOT_SEGMENT = '.agent-presets'
const VALID = '- id: tool-alpha\n  name: ../../plugins/contribute.js\n  config:\n    tool: alpha\n'

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-preset-deprecated-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

/** Boot a roster over the shipped root and the derived user root. */
async function roster(config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresets, {
    default: 'short-drama',
    roots: [],
    includeShippedRoot: true,
    includeUserRoot: true,
    ...config,
  })
  return ctx
}

/** Hand-place a preset directory under the harness home's preset root. */
async function seedHomePreset(id: string): Promise<void> {
  await mkdir(join(home, USER_ROOT_SEGMENT, id), { recursive: true })
  await writeFile(join(home, USER_ROOT_SEGMENT, id, COMPOSITION_FILE), VALID)
}

describe('a deprecated preset id', () => {
  it('resolves to the preset that replaced it', async () => {
    const ctx = await roster()

    const resolved = await ctx.agentPresets.resolve('short-drama-local')

    expect(resolved.id).toBe('short-drama')
    expect(resolved.path).toBe(join(SHIPPED_PRESET_ROOT, 'short-drama', COMPOSITION_FILE))
  })

  it('never joins the roster the picker reads', async () => {
    const ctx = await roster()

    expect((await ctx.agentPresets.list()).map(preset => preset.id))
      .toEqual(['standard', 'ptc', 'minimal', 'cordis', 'short-drama'])
  })

  it('yields to a root that still supplies the old id', async () => {
    // The archived directory is recoverable by rename, and restoring it must
    // reach THAT preset rather than the one that replaced it.
    await seedHomePreset('short-drama-local')
    const ctx = await roster()

    const resolved = await ctx.agentPresets.resolve('short-drama-local')

    expect(resolved.trust).toBe('user')
    expect(resolved.path).toBe(join(home, USER_ROOT_SEGMENT, 'short-drama-local', COMPOSITION_FILE))
  })

  it('leaves an id with no successor a plain not-found', async () => {
    const ctx = await roster()

    await expect(ctx.agentPresets.resolve('never-existed')).rejects.toThrow(/not found/)
  })

  it('is what a session labels itself with, through the projection view', async () => {
    // The header label and the picker's current mode read this wire view and
    // look the value up in the roster, so an unresolved id renders as itself.
    const definition = agentPresetProjectionDefinition
    const created: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('legacy'),
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'short-drama-local',
    }

    expect(definition.wire.view(definition.init(created))).toBe('short-drama')
    expect(definition.wire.view(definition.apply('short-drama-local', {
      type: 'agent-preset/selected', seq: 0 as never, time: 0, data: { agentPreset: 'short-drama-local' },
    }))).toBe('short-drama')
    expect(definition.wire.view(null)).toBeNull()
  })

  it('marks its successor as the default when the stored default was renamed', async () => {
    const ctx = await roster({ default: 'short-drama-local' })

    const exported = await ctx.agentPresets.remoteExportList()

    expect(exported.presets.find(row => row.id === 'short-drama')?.isDefault).toBe(true)
    expect(exported.presets.filter(row => row.isDefault)).toHaveLength(1)
    expect(exported.presets.map(row => row.id)).toHaveLength(5)
  })

  it('marks a real preset as the default when a root still supplies the old id', async () => {
    await seedHomePreset('short-drama-local')
    const ctx = await roster({ default: 'short-drama-local' })

    const exported = await ctx.agentPresets.remoteExportList()

    expect(exported.presets.find(row => row.id === 'short-drama-local')?.isDefault).toBe(true)
    expect(exported.presets.find(row => row.id === 'short-drama')?.isDefault).toBe(false)
  })
})
