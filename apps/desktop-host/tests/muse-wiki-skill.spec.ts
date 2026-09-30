import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

it('discovers Muse Wiki guidance for logged-in navigation, cited synthesis, and concurrent revisions', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false, bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)), watch: false,
    })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'muse-llm-wiki')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    const input = renderSkillContent((await ctx.skills.get('muse-llm-wiki'))!)
    expect(input).toMatch(/wiki_directory.*wiki_search.*wiki_read.*wiki_links/su)
    expect(input).toMatch(/wiki_capture_source.*原文.*wiki_write_page/su)
    for (const phrase of ['private', 'project_id', 'shared', 'citations', 'expected_revision', 'wiki_history', 'skeleton']) {
      expect(input).toContain(phrase)
    }
    expect(input).toMatch(/冲突.*重读.*合并/su)
    expect(input).toMatch(/当前.*登录.*不.*密钥/su)
    const editing = renderSkillContent((await ctx.skills.get('muse-script-editing'))!)
    expect(editing).toContain('muse-llm-wiki')
    const preset = await readFile(new URL('../presets/editing/agent.cordis.yml', import.meta.url), 'utf8')
    expect(preset).toContain('muse-llm-wiki')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('discovers proactive participation guidance across presets with private records and authorized portfolio reads', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false, bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)), watch: false,
    })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'muse-project-participation')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    const input = renderSkillContent((await ctx.skills.get('muse-project-participation'))!)
    for (const phrase of ['muse_kb_wiki_record_project', 'muse_kb_wiki_project_portfolio', 'contribution_id',
      'planned', 'in_progress', 'completed', 'blocked', 'cancelled', 'partial', 'verified_readback', 'account_id']) {
      expect(input).toContain(phrase)
    }
    expect(input).toMatch(/不同 Muse 账号.*分开保存.*不将旧账号.*写入新账号/su)
    expect(input).toMatch(/组合查询.*不返回原始资料/su)
    for (const name of ['standard', 'ptc', 'cordis', 'editing', 'short-drama']) {
      const preset = await readFile(new URL('../presets/' + name + '/agent.cordis.yml', import.meta.url), 'utf8')
      expect(preset).toContain('muse-project-participation')
    }
    const minimal = await readFile(new URL('../presets/minimal/agent.cordis.yml', import.meta.url), 'utf8')
    expect(minimal).toContain('no Muse Wiki tools')
  } finally {
    await ctx.fiber.dispose()
  }
})
