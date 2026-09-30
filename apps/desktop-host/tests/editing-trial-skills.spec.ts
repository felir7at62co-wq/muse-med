import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

const bundledSkillDir = fileURLToPath(new URL('../skills/', import.meta.url))
const names = ['muse-episode-design', 'muse-script-doctor', 'muse-dialogue-polish'] as const

it('resolves the trial skills referenced by the editing entry', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const editing = await ctx.skills.get('muse-script-editing')
    const routes = [...editing!.content.matchAll(/`(muse-(?:episode-design|script-doctor|dialogue-polish))`/gu)]
      .map(match => match[1]!)
    expect(new Set(routes)).toEqual(new Set(names))
    for (const name of routes) expect(await ctx.skills.get(name)).toBeDefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each(names)('discovers %s with readable local guidance and both invocation routes', async (name) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const summary = (await ctx.skills.list()).find(skill => skill.name === name)
    expect(summary).toMatchObject({
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: join(bundledSkillDir, name) },
    })
    const skill = await ctx.skills.get(name)
    expect(skill).toBeDefined()
    const links = [...skill!.content.matchAll(/\]\((references\/[^)]+)\)/gu)].map(match => match[1]!)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect((await readFile(join(bundledSkillDir, name, link), 'utf8')).trim()).not.toBe('')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each(names)('retains pinned upstream bytes and license for %s', async (name) => {
  const directory = join(bundledSkillDir, name, 'upstream')
  const source: unknown = JSON.parse(await readFile(join(directory, 'SOURCE.json'), 'utf8'))
  assert(source !== null && typeof source === 'object')
  assert('repository' in source && typeof source.repository === 'string')
  assert('revision' in source && typeof source.revision === 'string')
  assert('license' in source && typeof source.license === 'string')
  assert('files' in source && Array.isArray(source.files))
  expect(source.repository).toMatch(
    /^https:\/\/github\.com\/(?:lixiaoxiao9888-create\/short-drama-factory|ur-grue\/autopunk-media-skills)$/u,
  )
  expect(source.revision).toMatch(/^[a-f0-9]{40}$/u)
  expect(source.license).toBe('MIT')
  expect(source.files.length).toBeGreaterThan(1)
  const paths: string[] = []
  for (const candidate of source.files) {
    const file: unknown = candidate
    assert(file !== null && typeof file === 'object')
    assert('source' in file && typeof file.source === 'string')
    assert('local' in file && typeof file.local === 'string')
    assert('sha256' in file && typeof file.sha256 === 'string')
    paths.push(file.source)
    expect(file.local).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/u)
    const bytes = await readFile(join(directory, file.local))
    expect(createHash('sha256').update(bytes).digest('hex'), file.source).toBe(file.sha256)
  }
  expect(paths).toContain('LICENSE')
})
