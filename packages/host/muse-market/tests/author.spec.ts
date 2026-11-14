import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFile, rename, symlink, writeFile, unlink } from 'node:fs/promises'
import { collectMarketSkill } from '../src/author.ts'
import { marketSkill } from '../src/format.ts'
import { bundle, instructions, limits, resources } from './fixtures.ts'

const mutation = vi.hoisted(() => {
  const state: { directory?: string; run?: () => Promise<void> } = {}
  return state
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readdir: async (path: string, options: { withFileTypes: true }) => {
    const entries = await fs.readdir(path, options)
    if (path === mutation.directory && mutation.run) {
      const run = mutation.run; delete mutation.run
      await run()
    }
    return entries
  } }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  delete mutation.directory; delete mutation.run
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('selected Skill capture', () => {
  it('captures a virtual Skill without optional routing metadata', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const { path: _path, resourceBase: _base, whenToUse: _hint, metadata: _metadata, ...virtual } = value.skill
    const result = await collectMarketSkill(virtual, limits)
    const parsed = marketSkill(Buffer.from(result['skills/fixture-skill/SKILL.md']!).toString('utf8'), virtual.name)
    expect(parsed).not.toHaveProperty('whenToUse'); expect(parsed).not.toHaveProperty('metadata')
    expect(parsed.content).toBe(virtual.content)
  })

  it('bounds the complete portable resource name even for a valid long invocation name', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const { path: _path, resourceBase: _base, ...virtual } = value.skill
    await expect(collectMarketSkill({ ...virtual, name: 'a'.repeat(241) }, limits)).rejects.toThrow('invalid-path')
  })

  it.each([{ ...limits, fileCount: 1 }, { ...limits, expandedBytes: 1 }])('bounds complete virtual captures with %j', async (bounded) => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const { path: _path, resourceBase: _base, ...virtual } = value.skill
    await expect(collectMarketSkill(virtual, bounded)).rejects.toThrow('expanded-limit')
  })

  it('rejects a linked bundle root and never reads the linked sibling', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const link = join(value.root, 'selected-link'); await symlink(value.path, link, 'junction')
    try {
      await expect(collectMarketSkill({ ...value.skill, path: join(link, 'SKILL.md'),
        resourceBase: { kind: 'directory', path: link } }, limits)).rejects.toThrow('linked-resource')
    } finally { await unlink(link) }
    expect(await readFile(join(value.path, 'SKILL.md'), 'utf8')).toBe(instructions)
  })

  it('rejects private resource names without exporting their bytes', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    await writeFile(join(value.path, '.env'), 'fixture-private-value')
    await expect(collectMarketSkill(value.skill, limits)).rejects.toThrow('invalid-path')
  })

  it('reports a removed instruction file without exporting another bundle as a substitute', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    await unlink(join(value.path, 'SKILL.md'))
    await expect(collectMarketSkill(value.skill, limits)).rejects.toThrow('missing-skill')
  })

  it('refuses a byte-identical bundle directory replacement during capture', async () => {
    const value = await bundle(), replacement = await bundle(); cleanups.push(value.cleanup, replacement.cleanup)
    mutation.directory = value.path
    mutation.run = async () => {
      await rename(value.path, value.path + '.original')
      await rename(replacement.path, value.path)
    }
    await expect(collectMarketSkill(value.skill, limits)).rejects.toThrow('changed-resource')
    expect(await readFile(join(value.path, 'SKILL.md'), 'utf8')).toBe(instructions)
    expect(await readFile(join(value.path + '.original', 'SKILL.md'), 'utf8')).toBe(instructions)
  })
  it('retains complete original bundle bytes and all current metadata', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const result = await collectMarketSkill(value.skill, limits)
    for (const [path, bytes] of Object.entries(resources)) expect(Buffer.from(result[path]!)).toEqual(Buffer.from(bytes))
    expect(await readFile(join(value.path, 'SKILL.md'), 'utf8')).toBe(instructions)
  })

  it('captures virtual instructions with their routing, metadata and invocation flags', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const { path: _path, resourceBase: _base, ...virtual } = value.skill
    const result = await collectMarketSkill(virtual, limits)
    expect(Object.keys(result)).toEqual(['skills/fixture-skill/SKILL.md'])
    expect(marketSkill(Buffer.from(result['skills/fixture-skill/SKILL.md']!).toString('utf8'), virtual.name))
      .toMatchObject({ whenToUse: virtual.whenToUse, metadata: virtual.metadata, invocation: virtual.invocation, content: virtual.content })
  })

  it('refuses a flat Skill sharing a root with another Skill without copying or modifying either', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const flat = join(value.root, 'fixture-skill.md'), second = join(value.root, 'second-skill.md')
    await writeFile(flat, instructions); await writeFile(second, 'private second Skill')
    await expect(collectMarketSkill({ ...value.skill, path: flat,
      resourceBase: { kind: 'directory', path: value.root } }, limits)).rejects.toThrow('non-bundle-skill')
    expect(await readFile(flat, 'utf8')).toBe(instructions)
    expect(await readFile(second, 'utf8')).toBe('private second Skill')
  })

  it('refuses changed registry instructions and bounded resource overflow', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    await expect(collectMarketSkill({ ...value.skill, content: 'old cached body' }, limits)).rejects.toThrow('changed-skill')
    await expect(collectMarketSkill(value.skill, { ...limits, expandedBytes: 4 })).rejects.toThrow('invalid-storage')
  })

  it.skipIf(process.platform === 'win32')('refuses an owned bundle swapped for a sibling link at the directory-read boundary', async () => {
    // Creating file-system links can require privileges on Windows; the fixture never changes host policy.
    const value = await bundle(), sibling = await bundle(); cleanups.push(value.cleanup, sibling.cleanup)
    const privateResource = join(sibling.path, 'references/rules.txt')
    await writeFile(privateResource, 'Unselected sibling resource.\n')
    mutation.directory = value.path
    mutation.run = async () => {
      await rename(value.path, value.path + '.original')
      await symlink(sibling.path, value.path)
    }
    await expect(collectMarketSkill(value.skill, limits)).rejects.toThrow()
    expect(await readFile(privateResource, 'utf8')).toBe('Unselected sibling resource.\n')
  })
})
