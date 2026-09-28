import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

const bundledSkillDir = fileURLToPath(new URL('../skills/', import.meta.url))

it('loads the editing workflow from authorized cases and source through a complete script delivery', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const skill = await ctx.skills.get('muse-script-editing')
    expect(skill).toBeDefined()
    const input = renderSkillContent(skill!)
    expect(input).toMatch(/muse_kb_search.*案例.*muse_kb_read.*muse_kb_read_opening/su)
    expect(input).toMatch(/来源大纲.*本作大纲.*正式正文.*剧本按计划集数.*小说按计划章节.*全稿.*交付/su)
    expect(input).toMatch(/待改编来源是这份用户素材.*爆款剧本只是写法参考/su)
    expect(input).toMatch(/剧本按计划集数.*小说按计划章节/su)
    expect(input).toMatch(/剧本另核对.*小说另核对/su)
    expect(input).toMatch(/未读完.*不得.*完整.*大纲/su)
    expect(input).toMatch(/相关案例不可读时[^。]*不写正式正文/u)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('routes editor feedback to project versions without claiming a cloud knowledge-base write', async () => {
  const skill = await readFile(new URL('../skills/editing/SKILL.md', import.meta.url), 'utf8')
  expect(skill).toMatch(/编辑反馈.*原话.*大纲.*版本.*处理结果/su)
  expect(skill).toMatch(/项目.*记录.*不会自动写入.*知识库/su)
  const preset = await readFile(new URL('../presets/editing/agent.cordis.yml', import.meta.url), 'utf8')
  expect(preset).toMatch(/muse-script-editing.*来源大纲.*本作大纲.*全部.*正文/su)
})
