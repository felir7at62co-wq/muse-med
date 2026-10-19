/** Disabled instructions remain available for maintenance, outside product discovery. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'
import { retainedSkillsFixture } from './retained-skills-fixture.ts'

const retainedRoot = retainedSkillsFixture()
const productRoot = fileURLToPath(new URL('../skills/', import.meta.url))

it('excludes every disabled instruction from the product catalog while copying its exact bytes for maintenance tests', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir: productRoot, watch: false })
    const listed = new Set((await ctx.skills.list()).map(skill => skill.name))
    const active = new Set<string>()
    let disabledCount = 0
    for (const entry of await readdir(productRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const files = await readdir(join(productRoot, entry.name))
      const disabled = files.includes('SKILL.md.disabled')
      const original = await readFile(join(productRoot, entry.name, disabled ? 'SKILL.md.disabled' : 'SKILL.md'), 'utf8')
      const name = /^name:\s*(.+)$/mu.exec(original)?.[1]
      expect(name, entry.name).toBeDefined()
      if (name === undefined) throw new Error('retained skill has no name')
      expect(await readFile(join(retainedRoot, entry.name, 'SKILL.md'), 'utf8')).toBe(original)
      if (disabled) {
        disabledCount++
        expect(listed.has(name), name).toBe(false)
        expect(await ctx.skills.get(name), name).toBeUndefined()
      } else active.add(name)
    }
    expect(disabledCount).toBeGreaterThan(0)
    expect(listed).toEqual(active)
  } finally {
    await ctx.fiber.dispose()
  }
})
