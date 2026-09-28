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

it.each(['transcript-to-novel', 'transcript-to-script'])('%s keeps each source and writing stage in the authorized project', async (name) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const skill = await ctx.skills.get(name)
    const input = renderSkillContent(skill!)
    for (const path of ['source/links.md', 'source/media/', 'transcript/raw/', 'transcript/reviewed/',
      'outline/source-', 'outline/adaptation-', 'draft/', 'final/', 'qa/']) {
      expect(input).toContain(path)
    }
    expect(input).toMatch(/链接.*本地.*转写/su)
    expect(input).toMatch(/不覆盖原件/u)
    expect(input).toMatch(/outline\/source-v1\.md.*用户素材.*爆款剧本.*不补入本项目故事事实/su)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('keeps cloud transcription receipts and versioned raw results in the project', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const skill = await ctx.skills.get('audio-transcribe')
    const input = renderSkillContent(skill!)
    expect(input).toContain('source/media/')
    expect(input).toContain('source/links.md')
    expect(input).toContain('transcript/raw/')
    expect(input).toContain('transcript/jobs/')
    expect(input).toContain('transcript/reviewed/')
    expect(input).toContain('人工修订另存新文件，保留原始版本')
    expect(input).toContain('audio_transcribe')
  } finally {
    await ctx.fiber.dispose()
  }
})
