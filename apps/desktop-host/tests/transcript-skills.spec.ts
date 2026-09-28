import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

const bundledSkillDir = fileURLToPath(new URL('../skills/', import.meta.url))

it('discovers the first-person transcript skill as bundled model input', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'transcript-to-novel')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    expect(summary?.description).toMatch(/转写/u)
    const skill = await ctx.skills.get('transcript-to-novel')
    expect(skill).toBeDefined()
    const input = renderSkillContent(skill!)
    expect(input).toMatch(/第一人称/u)
    expect(input).toMatch(/只有音视频.*audio-transcribe/su)
    expect(input).toMatch(/来源.*版本/su)
    expect(input).toMatch(/爆款剧本.*开头/su)
    expect(skill?.content).not.toMatch(/[A-Z]:[\\/]|等待用户确认/u)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('discovers the scene-script transcript skill without assigning uncertain speech', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'transcript-to-script')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    expect(summary?.description).toMatch(/音频|视频/u)
    const skill = await ctx.skills.get('transcript-to-script')
    expect(skill).toBeDefined()
    const input = renderSkillContent(skill!)
    expect(input).toMatch(/归属未核实/u)
    expect(input).toMatch(/不.*补.*台词/su)
    expect(input).toMatch(/来源.*版本/su)
    expect(input).toMatch(/爆款剧本.*开头/su)
    expect(skill?.content).not.toMatch(/[A-Z]:[\\/]|等待用户确认/u)
  } finally {
    await ctx.fiber.dispose()
  }
})
