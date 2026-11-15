import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
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

  it('captures a virtual Skill without optional routing or metadata', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const { path: _path, resourceBase: _base, whenToUse: _when, metadata: _metadata, ...virtual } = value.skill
    const result = await collectMarketSkill(virtual, limits)
    const body = result['skills/fixture-skill/SKILL.md']
    if (body === undefined) throw new Error('Missing virtual instructions')
    expect(marketSkill(Buffer.from(body).toString('utf8'), virtual.name)).toEqual({
      description: virtual.description, content: virtual.content, invocation: virtual.invocation,
    })
  })

  it('refuses virtual path traversal and resource-count overflow before returning publication bytes', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const { path: _path, resourceBase: _base, ...virtual } = value.skill
    await expect(collectMarketSkill({ ...virtual, name: '../unselected' }, limits)).rejects.toThrow('invalid-path')
    await expect(collectMarketSkill(virtual, { ...limits, fileCount: 1 })).rejects.toThrow('expanded-limit')
    await expect(collectMarketSkill(virtual, { ...limits, expandedBytes: 1 })).rejects.toThrow('expanded-limit')
    expect(await readFile(join(value.path, 'SKILL.md'), 'utf8')).toBe(instructions)
  })

  it('refuses non-directory, relative and pathless bundle resources', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    await expect(collectMarketSkill({ ...value.skill, resourceBase: { kind: 'url', url: 'https://skills.invalid/bundle/' } }, limits))
      .rejects.toThrow('non-bundle-skill')
    await expect(collectMarketSkill({ ...value.skill, resourceBase: { kind: 'directory', path: 'relative-bundle' } }, limits))
      .rejects.toThrow('non-bundle-skill')
    const { path: _path, ...pathless } = value.skill
    await expect(collectMarketSkill(pathless, limits)).rejects.toThrow('non-bundle-skill')
  })

  it('refuses a bundle with missing instructions and retains its remaining resource bytes', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    await rm(join(value.path, 'SKILL.md'))
    await expect(collectMarketSkill(value.skill, limits)).rejects.toThrow('missing-skill')
    expect(await readFile(join(value.path, 'references/rules.txt'), 'utf8')).toBe('Keep the original scene.\n')
  })

  it('refuses private configuration names found inside the selected directory', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const file = join(value.path, '.env')
    await writeFile(file, 'PRIVATE_FIXTURE_VALUE=retained\n')
    await expect(collectMarketSkill(value.skill, limits)).rejects.toThrow('invalid-path')
    expect(await readFile(file, 'utf8')).toBe('PRIVATE_FIXTURE_VALUE=retained\n')
  })

  it('refuses a directory alias instead of following it into the renamed bundle', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    const original = value.path + '.original'
    await rename(value.path, original)
    await symlink(original, value.path, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(collectMarketSkill(value.skill, limits)).rejects.toThrow('linked-resource')
    expect(await readFile(join(original, 'SKILL.md'), 'utf8')).toBe(instructions)
  })

  it('refuses a directory changed after its entries were observed', async () => {
    const value = await bundle(); cleanups.push(value.cleanup)
    mutation.directory = value.path
    mutation.run = async () => {
      await mkdir(join(value.path, 'late-resource'))
      await utimes(value.path, new Date(0), new Date(0))
    }
    await expect(collectMarketSkill(value.skill, limits)).rejects.toThrow('changed-resource')
    expect(await readFile(join(value.path, 'SKILL.md'), 'utf8')).toBe(instructions)
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
