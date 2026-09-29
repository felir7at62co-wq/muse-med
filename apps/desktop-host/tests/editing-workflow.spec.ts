import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

const bundledSkillDir = fileURLToPath(new URL('../skills/', import.meta.url))

it('loads both source routes, the outline decision, and complete script delivery', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const skill = await ctx.skills.get('muse-script-editing')
    expect(skill).toBeDefined()
    const input = renderSkillContent(skill!)
    expect(input).toMatch(/小说转剧本.*视频转剧本/su)
    expect(input).toMatch(/剧名.*搜索.*资源.*转写/su)
    expect(input).toMatch(/transcript-to-script.*muse_kb_ingest_script/su)
    expect(input).toMatch(/来源大纲.*换梗.*集数.*字数.*用户.*本作大纲/su)
    expect(input).toMatch(/爆款转写.*剧本.*优先.*muse_kb_search.*muse_kb_read/su)
    expect(input).toMatch(/剧本按计划集数.*全稿.*交付/su)
    expect(input).not.toMatch(/不写正式正文|不得写正式正文/u)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('routes editor feedback to project versions and reports verified knowledge-base writes', async () => {
  const skill = await readFile(new URL('../skills/editing/SKILL.md', import.meta.url), 'utf8')
  expect(skill).toMatch(/编辑反馈.*原话.*大纲.*版本.*处理结果/su)
  expect(skill).toMatch(/编辑反馈.*项目.*记录.*知识库.*授权.*写入.*读回/su)
  const preset = await readFile(new URL('../presets/editing/agent.cordis.yml', import.meta.url), 'utf8')
  for (const phrase of ['muse-script-editing', '小说转剧本', '视频转剧本', '换梗', '全部正文']) {
    expect(preset).toContain(phrase)
  }
})

it('discovers separate novel conversion and trope-change guidance', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    for (const name of ['novel-to-script', 'trope-adaptation']) {
      const summary = (await ctx.skills.list()).find(skill => skill.name === name)
      expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
      expect(await ctx.skills.get(name)).toBeDefined()
    }
    const trope = renderSkillContent((await ctx.skills.get('trope-adaptation'))!)
    for (const phrase of ['换梗方案', '用户选择', '集数', '字数']) expect(trope).toContain(phrase)
    expect(trope).not.toMatch(/每批\s*(?:1-)?5\s*集|500-700字/u)
  } finally {
    await ctx.fiber.dispose()
  }
})


it('makes the shared screenplay format available from both adaptation routes', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'screenplay-format')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    const format = renderSkillContent((await ctx.skills.get('screenplay-format'))!)
    for (const phrase of ['第1集', '1-1', '人物：', '▲', 'OS', 'VO', '【下集钩子】', '时间轴']) {
      expect(format).toContain(phrase)
    }
    for (const name of ['novel-to-script', 'transcript-to-script', 'muse-script-editing']) {
      expect(renderSkillContent((await ctx.skills.get(name))!)).toContain('screenplay-format')
    }
    expect((await ctx.skills.get('screenplay-format'))!.content).not.toMatch(/[A-Z]:[\\/]/u)
  } finally {
    await ctx.fiber.dispose()
  }
})
