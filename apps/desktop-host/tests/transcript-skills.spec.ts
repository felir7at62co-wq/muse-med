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
    expect(input).toMatch(/音频文件.*audio-transcribe/su)
    expect(input).toMatch(/视频.*video_ocr/su)
    expect(input).toMatch(/视频.*已获授权.*ASR.*purpose: "screenplay"/su)
    expect(input).toMatch(/queue_full.*尚未受理.*未提交集.*实测效率.*video_ocr/su)
    expect(input).toMatch(/queued=true.*保留原身份.*不假称取消/su)
    expect(input).toMatch(/silent.*不算失败/su)
    expect(input).toMatch(/partial\/failed.*覆盖不足.*不补写漏掉的对白/su)
    expect(input).toMatch(/优先复用用户已提供.*不为已有文字重复识别/su)
    expect(input).toMatch(/persistent_text_candidate.*不是非剧情水印证据/su)
    expect(input).toMatch(/OCR.*ASR.*分文件保存.*标明文字来源/su)
    expect(input).toMatch(/来源.*版本/su)
    expect(input).toMatch(/阅读.*爆款剧本.*不设开写门禁/su)
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
    expect(input).toContain('purpose: "screenplay"')
    expect(input).toMatch(/不.*补.*台词/su)
    expect(input).toMatch(/来源.*版本/su)
    expect(input).toMatch(/仿真人分场剧本.*参考文章.*不设开写门禁/su)
    expect(input).toMatch(/严格\/编辑来源整理路径先将转写.*分场剧本.*再从该稿写.*outline\/source-v1\.md/su)
    expect(input).toMatch(/新故事忠实路径.*原 ASR、实际帧与来源账.*不把完整整理稿设为 baseline 前置/su)
    expect(input).toMatch(/outline\/adaptation-v1\.md.*用户选定方向后成稿/su)
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
    expect(input).toMatch(/outline\/source-v1\.md.*用户素材.*案例.*不补入本项目故事事实/su)
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
    expect(input).toContain('`subtitles`（极速识别）')
    expect(input).toContain('`screenplay`（标准识别）')
    expect(input).toContain('查询与重试保持原用途')
  } finally {
    await ctx.fiber.dispose()
  }
})
