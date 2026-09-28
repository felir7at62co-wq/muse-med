import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

const bundledSkillDir = fileURLToPath(new URL('../skills/', import.meta.url))

it('discovers direct media import with its source and download limits', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'media-link-import')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    const skill = await ctx.skills.get('media-link-import')
    const input = renderSkillContent(skill!)
    expect(input).toMatch(/HTTPS.*直链/u)
    expect(input).toMatch(/抖音分享页.*微信视频号.*不解析页面/su)
    expect(input).toMatch(/使用许可.*source\/links\.md.*source\/media\//su)
    expect(input).toMatch(/scripts\/import_media\.py/u)
  } finally {
    await ctx.fiber.dispose()
  }
})
