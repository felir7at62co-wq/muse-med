import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

it('discovers Douyin video acquisition with authenticated fallback and transcription handoff', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)), watch: false })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'douyin-download')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    const skill = await ctx.skills.get('douyin-download')
    if (!skill) throw new Error('Missing shared Douyin skill')
    const input = renderSkillContent(skill)
    expect(input).toContain('modal_id')
    expect(input).toContain('audio-transcribe')
    expect(input).toContain('source/media/douyin/')
    expect(input).toContain('--cookie-file')
  } finally {
    await ctx.fiber.dispose()
  }
})
