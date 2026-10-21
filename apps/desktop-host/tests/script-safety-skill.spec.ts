/** Historical script review resources remain loadable outside the product catalog. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'
import { CREATION_SKILL_NAMES } from '../src/creation-skills.ts'
import { retainedSkillsFixture } from './retained-skills-fixture.ts'

const historicalRoot = retainedSkillsFixture()

it('loads the retired review reference from the historical fixture without advertising it in creation', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      bundledSkillDir: historicalRoot,
      watch: false,
    })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'reviewing-micro-drama-scripts')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } })
    const skill = await ctx.skills.get('reviewing-micro-drama-scripts')
    if (skill?.resourceBase?.kind !== 'directory') throw new Error('Missing bundled review resources')
    expect(renderSkillContent(skill)).toContain('references/platform-guidelines.md')
    const reference = await readFile(join(skill.resourceBase.path, 'references/platform-guidelines.md'), 'utf8')
    expect(reference).toContain('# 动画微短剧（漫剧）内容创作建议')
    expect(reference).toContain('## 漫剧信息（剧壳）创作建议')
    expect(skill.content).not.toContain('/Downloads/')
    expect(CREATION_SKILL_NAMES).not.toContain(skill.name)
  } finally {
    await ctx.fiber.dispose()
  }
})
