import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

it('keeps disabled WeChat acquisition out of the registry and preserves its transcription handoff', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)), watch: false })
    expect((await ctx.skills.list()).some(skill => skill.name === 'wechat-shortdrama-harvest')).toBe(false)
    expect(await ctx.skills.get('wechat-shortdrama-harvest')).toBeUndefined()
    const input = await readFile(new URL('../skills/wechat-shortdrama-harvest/SKILL.md.disabled', import.meta.url), 'utf8')
    expect(input).toContain('SHORTDRAMA_WORK')
    expect(input).toContain('audio-transcribe')
    expect(input).toContain('video_ocr')
    expect(input).toMatch(/视频转小说.*优先复用已有字幕\/转写.*已获授权.*ASR 原稿.*queue_full.*尚未受理.*实测效率.*video_ocr/su)
    expect(input).toMatch(/视频转剧本.*purpose=screenplay/su)
    expect(input).toContain('OCR 失败或部分覆盖不能静默回退')
    expect(input).toContain('不能说全集已完成')
  } finally {
    await ctx.fiber.dispose()
  }
})
