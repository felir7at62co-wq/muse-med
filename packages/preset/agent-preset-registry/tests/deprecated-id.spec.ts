/**
 * A preset id that a durable record still names must keep resolving after the
 * declaration that answered it was renamed: a session's creation header and its
 * `agent-preset/selected` events are permanent, and this version has no alias
 * mechanism. `DEPRECATED_PRESET_IDS` is the resolution-only answer — it must
 * never reach the roster, and it must never shadow a definition that still
 * carries the old id.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { agentPresetProjectionDefinition } from '../src/index.ts'
import { agentOn, contribution, declare, harness } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

/** The product's roster: four native compositions beside the renamed short-drama. */
const ROSTER = ['cordis', 'minimal', 'ptc', 'short-drama', 'standard'] as const

/**
 * Boot a registry holding the product roster.
 * @param options - `default` is the deployment default; `extra` declares further ids.
 * @returns The booted harness context.
 */
async function roster(options: { default?: string; extra?: readonly string[] } = {}): Promise<Context> {
  const ctx = await harness({ default: options.default ?? 'short-drama' })
  contexts.push(ctx)
  for (const id of [...ROSTER, ...options.extra ?? []]) await declare(ctx, contribution(id))
  return ctx
}

describe('a deprecated preset id', () => {
  it('resolves to the preset that replaced it', async () => {
    const ctx = await roster()

    expect((await ctx.agentPresets.resolve('short-drama-local')).id).toBe('short-drama')
  })

  it('never joins the roster the picker reads', async () => {
    const ctx = await roster()

    expect((await ctx.agentPresets.list()).map(preset => preset.id)).toEqual([...ROSTER])
  })

  it('yields to a definition that still carries the old id', async () => {
    // The archived definition is recoverable by rename, and restoring it must
    // reach THAT preset rather than the one that replaced it.
    const ctx = await roster({ extra: ['short-drama-local'] })

    expect((await ctx.agentPresets.resolve('short-drama-local')).id).toBe('short-drama-local')
    expect((await ctx.agentPresets.list()).map(preset => preset.id)).toContain('short-drama-local')
  })

  it('leaves an id with no successor a plain not-found', async () => {
    const ctx = await roster()

    await expect(ctx.agentPresets.resolve('never-existed')).rejects.toThrow(/Unknown agent preset/)
  })

  it('composes the successor for an Agent resuming a session recorded before the rename', async () => {
    // The reported failure: `mount` resolved nothing for the recorded id, so the
    // session could not be composed at all.
    const ctx = await roster()

    const agent = await agentOn(ctx, 'resumed', 'short-drama-local')

    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('short-drama')
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['short-drama'])
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
    expect(exported.presets).toHaveLength(ROSTER.length)
  })

  it('marks a real preset as the default when a definition still carries the old id', async () => {
    const ctx = await roster({ default: 'short-drama-local', extra: ['short-drama-local'] })

    const exported = await ctx.agentPresets.remoteExportList()

    expect(exported.presets.find(row => row.id === 'short-drama-local')?.isDefault).toBe(true)
    expect(exported.presets.find(row => row.id === 'short-drama')?.isDefault).toBe(false)
  })
})
