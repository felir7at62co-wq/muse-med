import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

it('discovers WeChat acquisition with project state and verified transcription handoff', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)), watch: false })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'wechat-shortdrama-harvest')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    const skill = await ctx.skills.get('wechat-shortdrama-harvest')
    if (!skill) throw new Error('Missing shared WeChat skill')
    const input = renderSkillContent(skill)
    expect(input).toContain('SHORTDRAMA_WORK')
    expect(input).toContain('audio-transcribe')
    expect(input).toContain('不能说全集已完成')
  } finally {
    await ctx.fiber.dispose()
  }
})
