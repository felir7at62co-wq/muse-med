import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'
import { retainedSkillsFixture } from './retained-skills-fixture.ts'

const bundledSkillDir = retainedSkillsFixture()

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
    expect(input).toMatch(/爆款转写.*剧本.*优先.*muse_kb_wiki_directory.*muse_kb_wiki_read/su)
    expect(input).toMatch(/剧本按计划集数.*全稿.*交付/su)
    expect(input).not.toMatch(/不写正式正文|不得写正式正文/u)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('routes editor feedback to project versions and reports verified knowledge-base writes', async () => {
  const skill = await readFile(new URL('../skills/editing/SKILL.md.disabled', import.meta.url), 'utf8')
  expect(skill).toMatch(/编辑反馈.*原话.*大纲.*版本.*处理结果/su)
  expect(skill).toMatch(/编辑反馈.*项目.*记录.*知识库.*授权.*写入.*读回/su)
})

it('loads retained separate novel conversion and trope-change guidance', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    for (const name of ['novel-to-script', 'trope-adaptation', 'muse-llm-wiki']) {
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


it('limits managed acceptance instructions to modes that provide the project tool', async () => {
  for (const name of ['editing', 'transcript-to-script', 'screenplay-format', 'novel-to-script', 'trope-adaptation']) {
    const body = await readFile(new URL(`../skills/${name}/SKILL.md${name === 'screenplay-format' ? '' : '.disabled'}`, import.meta.url), 'utf8')
    expect(body, name).toContain('当前 Agent 自主核对来源、修改和交付')
    if (name === 'screenplay-format') {
      expect(body).toContain('按当前工具声明区分 advisory 和明确启用的严格部署')
      expect(body).toContain('不把自主检查称为独立审核，也不虚构审校通过')
    } else expect(body, name).toContain('当前工具目录提供 `screenplay_project` 且任务采用受管项目时，才加载')
    expect(body, name).toContain('工具不可用时直接整理普通稿件，不调用受管命令')
  }
})
