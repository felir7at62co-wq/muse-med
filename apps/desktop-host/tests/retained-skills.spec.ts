/** Retired instructions remain available in test fixtures, outside product discovery. */
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
const retiredRoot = fileURLToPath(new URL('./fixtures/retired-writing-skills/', import.meta.url))

it('keeps retired instructions outside the product catalog while retaining their exact bytes for historical tests', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir: productRoot, watch: false })
    const listed = new Set((await ctx.skills.list()).map(skill => skill.name))
    const active = new Set<string>()
    for (const entry of await readdir(productRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const files = await readdir(join(productRoot, entry.name))
      if (!files.includes('SKILL.md') && !files.includes('SKILL.md.disabled')) continue
      const disabled = files.includes('SKILL.md.disabled')
      const original = await readFile(join(productRoot, entry.name, disabled ? 'SKILL.md.disabled' : 'SKILL.md'), 'utf8')
      const name = /^name:\s*(.+)$/mu.exec(original)?.[1]
      expect(name, entry.name).toBeDefined()
      if (name === undefined) throw new Error('retained skill has no name')
      expect(await readFile(join(retainedRoot, entry.name, 'SKILL.md'), 'utf8')).toBe(original)
      if (disabled) {
        expect(listed.has(name), name).toBe(false)
        expect(await ctx.skills.get(name), name).toBeUndefined()
      } else active.add(name)
    }
    expect(listed).toEqual(active)
    const retired = await readdir(retiredRoot, { withFileTypes: true })
    expect(retired.length).toBeGreaterThan(0)
    for (const entry of retired) {
      if (!entry.isDirectory()) continue
      const files = await readdir(join(retiredRoot, entry.name))
      const filename = files.includes('SKILL.md.disabled') ? 'SKILL.md.disabled' : 'SKILL.md'
      const original = await readFile(join(retiredRoot, entry.name, filename), 'utf8')
      const name = /^name:\s*(.+)$/mu.exec(original)?.[1]
      expect(name, entry.name).toBeDefined()
      if (name === undefined) throw new Error('retired skill has no name')
      expect(listed.has(name), name).toBe(false)
      expect(await ctx.skills.get(name), name).toBeUndefined()
      expect(await readFile(join(retainedRoot, entry.name, 'SKILL.md'), 'utf8')).toBe(original)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
