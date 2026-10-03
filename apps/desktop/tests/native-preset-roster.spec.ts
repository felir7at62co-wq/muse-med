/**
 * The product roster over the upstream preset registry.
 *
 * The Desktop Host declares one row per packaged `presets/<id>` directory and nothing else, so the
 * roster is exactly those six ids in the order their `preset.yml` gives, defaults to the product's
 * own `short-drama`, and every definition carries the rows the packaged composition file declares.
 * A composition file is product data: registering it must never rewrite it. The packaged-runtime
 * smoke (`scripts/smoke-runtime.ts`) is the check that activates all six against the real Host.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import NativePreset from '../../desktop-host/src/native-preset.ts'

const productRoot = fileURLToPath(new URL('../../desktop-host/presets', import.meta.url))

/** The Loader's `!!js` scalar, which a composition declares and the Loader evaluates at activation. */
const JS_SCHEMA = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value: string) => ({ __jsExpr: value }),
})])

/**
 * Read one composition file as entry rows.
 * @param path - Absolute composition path.
 * @returns The declared rows, with `!!js` values kept as expressions.
 */
async function readRows(path: string): Promise<{ id?: string; name?: string; config?: Record<string, unknown> }[]> {
  return yaml.load(await readFile(path, 'utf8'), { schema: JS_SCHEMA }) as { id?: string; name?: string; config?: Record<string, unknown> }[]
}

describe('the product preset roster', () => {
  it('declares exactly the packaged composition directories, in their own order', async () => {
    const directories = (await readdir(productRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    const ctx = new Context()
    try {
      await ctx.plugin(Loader)
      // The registry records a session projection it never reads here.
      ctx.provide('sessionProjections', { register: () => () => {} })
      await ctx.plugin(AgentPresetRegistry, { default: 'short-drama' })
      for (const id of directories) await ctx.plugin(NativePreset, { id, directory: join(productRoot, id) })

      const roster = await ctx.agentPresets.list()

      expect(roster.map(row => row.id).sort()).toEqual(directories)
      // `preset.yml` order decides the picker's sequence; the product's own composition is last.
      expect(roster.map(row => row.id)).toEqual(['standard', 'ptc', 'minimal', 'cordis', 'short-drama', 'editing'])
      expect(ctx.agentPresets.defaultId).toBe('short-drama')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the rows the packaged composition declares, without rewriting the file', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Loader)
      ctx.provide('sessionProjections', { register: () => () => {} })
      await ctx.plugin(AgentPresetRegistry, { default: 'short-drama' })
      const path = join(productRoot, 'short-drama', 'agent.cordis.yml')
      const before = await readFile(path, 'utf8')
      await ctx.plugin(NativePreset, { id: 'short-drama', directory: join(productRoot, 'short-drama') })

      const document = await ctx.agentPresets.readDocument('short-drama')
      const declared = await readRows(path)
      const rows = yaml.load(document.content, { schema: JS_SCHEMA }) as { id?: string; name?: string }[]

      expect(rows.map(row => row.id)).toEqual(declared.map(row => row.id))
      expect(rows.map(row => row.name)).toEqual(declared.map(row => row.name))
      expect(await readFile(path, 'utf8')).toBe(before)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the composition-authoring skills the cordis composition serves', async () => {
    // That row points at this package's own directory, so the skills have to ship beside it.
    const rows = await readRows(join(productRoot, 'cordis', 'agent.cordis.yml'))
    const provider = rows.find(row => row.id === 'skill-filesystem')
    const skills = (await readdir(join(productRoot, 'cordis', 'skills'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()

    expect(skills).toEqual(['cordis-plugin-development', 'editing-cordis-compositions'])
    for (const name of skills) {
      await expect(readFile(join(productRoot, 'cordis', 'skills', name, 'SKILL.md'), 'utf8')).resolves.toContain('name:')
    }
    const expression: unknown = expect.stringContaining("'presets', 'cordis', 'skills'")
    expect(provider?.config?.customSkillDirs).toEqual([{ __jsExpr: expression }])
  })
})
