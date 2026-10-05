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
    expect(input).toContain('工具调用自动开始下载')
    expect(input).toContain('重启后可继续使用')
    expect(input).toContain('DESKTOP_HOST_REQUIRED')
    expect(input).toContain('不读取外部 Chrome 数据库')
    expect(input).not.toContain('--browser-profile')
    expect(input).toContain('douyin_download')
    expect(input).toContain('_ROUTER_DATA')
    expect(input).toContain('ffmpeg 完整解码成功')
    expect(input).toContain('`urls` 数组')
  } finally {
    await ctx.fiber.dispose()
  }
})
