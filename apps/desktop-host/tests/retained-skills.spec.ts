/** Maintained writing instructions load with their resources; retired instructions stay fixture-only. */
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'
import { retainedSkillsFixture } from './retained-skills-fixture.ts'

const retainedRoot = retainedSkillsFixture()
const productRoot = fileURLToPath(new URL('../skills/', import.meta.url))
const retiredRoot = fileURLToPath(new URL('./fixtures/retired-writing-skills/', import.meta.url))
const writingSkills = ['muse-script-doctor', 'novel-to-script', 'muse-dialogue-polish', 'muse-episode-design', 'screenplay-format']

it('keeps writing skills in the default catalog and preserves retired-only instructions', async () => {
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
      expect(listed.has(name), name).toBe(writingSkills.includes(name))
      if (writingSkills.includes(name)) expect(await ctx.skills.get(name), name).toBeDefined()
      else expect(await ctx.skills.get(name), name).toBeUndefined()
      const expected = writingSkills.includes(name) ? await readFile(join(productRoot, entry.name, 'SKILL.md'), 'utf8') : original
      expect(await readFile(join(retainedRoot, entry.name, 'SKILL.md'), 'utf8')).toBe(expected)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each(writingSkills)('loads maintained %s with archived resources and valid local references', async (name) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir: productRoot, watch: false })
    const directory = join(productRoot, name), originalDirectory = join(retiredRoot, name)
    const summaries = (await ctx.skills.list()).filter(skill => skill.name === name)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.invocation.modelInvocable).toBe(true)
    const loaded = await ctx.skills.get(name)
    expect(loaded?.path).toBe(join(directory, 'SKILL.md'))
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: directory })
    expect(loaded?.content.trim()).toBeTruthy()
    const originals = (await readdir(originalDirectory, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => relative(originalDirectory, join(entry.parentPath, entry.name))).sort()
    const restored = (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => relative(directory, join(entry.parentPath, entry.name))).sort()
    expect(restored).toEqual(expect.arrayContaining(originals))
    for (const file of originals) {
      const original = await readFile(join(originalDirectory, file))
      const current = await readFile(join(directory, file))
      if (!file.endsWith('.md') || file.split(/[\\/]/)[0] === 'upstream') {
        expect(current, file).toEqual(original)
        continue
      }
      expect(current.toString('utf8').trim(), file).not.toBe('')
      for (const link of current.toString('utf8').matchAll(/\]\(([^)]+)\)/gu)) {
        const target = link[1]
        if (target === undefined || /^(?:https?:|#)/u.test(target)) continue
        await expect(access(resolve(dirname(join(directory, file)), target.split('#')[0]!)), `${file}: ${target}`).resolves.toBeUndefined()
      }
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
