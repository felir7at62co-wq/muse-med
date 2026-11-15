/** Current video-to-screenplay guidance is available from both product Skill registries. */
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'
import * as CreationSkills from '../src/creation-skills.ts'

const productRoot = fileURLToPath(new URL('../skills/', import.meta.url))

it('forwards the maintained bundled video guide and its actual resources into creation', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFilesystem, { includeDefaultRoots: false, bundledSkillDir: productRoot, watch: false })
    const creation = ctx.isolate('skills')
    await creation.plugin(SkillRegistry)
    await creation.plugin(CreationSkills)
    expect(creation.skills).not.toBe(ctx.skills)
    const directory = join(productRoot, 'video-to-screenplay')
    const original = await ctx.skills.get('video-to-screenplay')
    expect(original).toBeDefined()
    expect(original?.source).toBe('bundled')
    expect(original?.resourceBase).toEqual({ kind: 'directory', path: directory })
    expect(original?.invocation).toMatchObject({ modelInvocable: true, userInvocable: true })
    expect((await ctx.skills.list()).filter(skill => skill.name === 'video-to-screenplay')).toHaveLength(1)
    expect((await creation.skills.list()).filter(skill => skill.name === 'video-to-screenplay')).toHaveLength(1)
    const forwarded = await creation.skills.get('video-to-screenplay')
    expect(forwarded).toMatchObject({ name: 'video-to-screenplay', provider: 'muse-creation', source: 'bundled',
      content: original!.content, path: original!.path, resourceBase: original!.resourceBase })
    for (const registry of [ctx.skills, creation.skills]) {
      expect(await registry.get('transcript-to-script')).toBeUndefined()
    }
    ctx.effect(() => ctx.skills.register({ name: 'unlisted-video-route', description: 'Unapproved bundled writing guide',
      source: 'bundled', content: 'Do not forward this bundled instruction.' }))
    expect(await ctx.skills.get('unlisted-video-route')).toBeDefined()
    expect(await creation.skills.get('unlisted-video-route')).toBeUndefined()
    const files = await readdir(directory, { recursive: true, withFileTypes: true })
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue
      const path = join(file.parentPath, file.name)
      const content = await readFile(path, 'utf8')
      expect(content.trim(), path).not.toBe('')
      for (const link of content.matchAll(/\]\(([^)]+)\)/gu)) {
        const target = link[1]
        if (target === undefined || /^(?:https?:|#)/u.test(target)) continue
        await expect(access(resolve(dirname(path), target.split('#')[0]!)), `${path}: ${target}`).resolves.toBeUndefined()
      }
    }
  } finally { await ctx.fiber.dispose() }
})
