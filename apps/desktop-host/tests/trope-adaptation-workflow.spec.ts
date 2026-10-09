import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

const skill = await readFile(new URL('../skills/trope-adaptation/SKILL.md', import.meta.url), 'utf8')

function instructionFor(situation: string): string {
  const row = skill.split('\n').find(line => line.startsWith(`| ${situation} |`))
  expect(row, `缺少「${situation}」的换梗处理规则`).toBeDefined()
  return row!.split('|')[2]!.trim()
}

it('orders source evidence, highlights, user decisions, proposals, and review', () => {
  const stages = ['## 来源分析', '## 看点清单与用户确认', '## 候选方案', '## 候选人工审核与进入大纲', '## 改编大纲与审校']
  const positions = stages.map(stage => skill.indexOf(stage))
  expect(positions.every(position => position >= 0)).toBe(true)
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
  expect(skill).toMatch(/切片转写.*描述.*来源位置/su)
  expect(skill).toContain('用户指定重点片段')
  expect(skill).toMatch(/没有.*热度证据.*不.*自动识别热点/su)
})

it('instructs the agent to mark source gaps instead of inventing evidence', () => {
  expect(instructionFor('来源依据不足')).toMatch(/列出缺口.*等待.*不.*编造/u)
})

it('instructs the agent to await missing decisions and reuse explicit ones', () => {
  expect(instructionFor('用户尚未确认看点')).toMatch(/清单.*确认.*候选方案前暂停/u)
  expect(instructionFor('用户已有明确要求')).toMatch(/记录依据.*不重复询问/u)
})

it('instructs the agent to revise proposals that omit required highlights', () => {
  expect(instructionFor('候选方案遗漏必保留看点')).toMatch(/退回修订.*不得进入改编大纲/u)
})

it('documents the normal route through selected proposal and review', () => {
  expect(instructionFor('正常流程')).toMatch(/候选方案.*用户选定方向.*候选人工审核.*明确确认可进入大纲.*改编大纲.*审校/u)
  expect(skill).toMatch(/事件.*冲突机制.*情绪回报.*反转.*必要铺垫/su)
  expect(skill).toMatch(/保留.*改写.*遗漏.*因果/su)
  expect(skill).toMatch(/保留原事件.*核心机制/su)
  expect(skill).toMatch(/已明确选定换梗方向.*直接沿该方向.*不重新提供候选方案.*独立人工审核/u)
})

it('instructs the agent to wait for separate human review before outlining', () => {
  const review = skill.split('## 候选人工审核与进入大纲')[1]!.split('## 改编大纲与审校')[0]!
  expect(review).toMatch(/单独停下.*主证据实际证明的事实.*未排除的替代解释.*反转因果.*交用户人工审核/su)
  expect(review).toMatch(/用户选择候选方向.*不等于证据链审核通过.*不等于授权写正式大纲/su)
  expect(review).toMatch(/此前已明确审核当前候选版本.*记录.*用户消息与版本.*不重复询问/su)
  expect(review).toMatch(/明确确认当前所选候选版本的证据链与反转因果可以进入大纲.*否则停在候选阶段/su)
  expect(instructionFor('用户仅选定方向')).toMatch(/人工审核证据链与反转因果.*未获明确确认前停在候选阶段/u)
  expect(skill).toMatch(/完成候选人工审核并取得用户明确进入大纲的确认后.*outline\/adaptation-v1\.md/su)
})

it('instructs the agent to preserve unresolved gaps without claiming a certain reversal', () => {
  const review = skill.split('## 候选人工审核与进入大纲')[1]!.split('## 改编大纲与审校')[0]!
  expect(review).toMatch(/未解决的关键证据或反转因果缺口.*不得.*确定翻盘.*先修订候选并复核.*用户明确决定如何处置缺口/su)
  expect(review).toMatch(/接受待解决项不等于该项已被证明.*待审草案.*标明缺口与待补条件.*不把条件性反转写成确定结局/su)
  expect(instructionFor('候选仍有关键缺口')).toMatch(/修订并复核.*待解决项.*不表示已证明.*不写确定翻盘/u)
})

it('instructs attribution proposals to check concrete outcomes and independent evidence', () => {
  const proposals = skill.split('## 候选方案')[1]!.split('## 改编大纲与审校')[0]!
  expect(proposals).toMatch(/每个候选.*被冒领的具体成果/su)
  for (const phrase of ['冒领前形成', '第三方核对', '接触成果', '反转时才公开', '主证据', '补强证据']) {
    expect(proposals).toContain(phrase)
  }
  for (const claim of ['样式设计', '实际制作', '词曲创作', '研发贡献', '署名', '名分']) {
    expect(proposals).toContain(claim)
  }
  expect(proposals).toContain('主张→主证据实际证明的事实→允许得出的结论')
  expect(proposals).toMatch(/结论不得超过证据的证明力/u)
  expect(proposals).toMatch(/日期、持有、送检、技艺、现场复现.*不得从这些事实直接推出原创归属/su)
  expect(proposals).toMatch(/技艺、持有、现场复现不得单独证明具体成果归属/u)
  expect(proposals).toMatch(/至少一种.*合理替代解释.*主证据能否排除/su)
  expect(proposals).toMatch(/无法排除.*标记缺口.*不得宣称因果闭环/su)
  expect(proposals).toMatch(/不得.*擅自缩小用户必保留.*需要改变时先交用户决定/su)
  expect(proposals).toMatch(/内部因果自洽，不要求法律级证明/u)
  expect(proposals).toMatch(/证据不足.*标记缺口.*不得宣称因果闭环/su)
})

it('instructs proposals to ground scale in source coverage and user goals', () => {
  const proposals = skill.split('## 候选方案')[1]!.split('## 改编大纲与审校')[0]!
  expect(proposals).toMatch(/篇幅建议必须依据实际覆盖的来源素材和用户目标/u)
  expect(proposals).toMatch(/用户已限定集数或篇幅时直接沿用/u)
  expect(proposals).toMatch(/不得无依据地把长篇或新增更大对手当作必需设定/u)
  expect(proposals).toMatch(/扩展方向只能作为待用户选择的可选方案/u)
  expect(proposals).toMatch(/篇幅建议不得提出无依据的绝对规则/u)
})

it('loads the revised skill through the bundled Skill Registry', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
      watch: false,
    })
    const loaded = await ctx.skills.get('trope-adaptation')
    expect(loaded).toBeDefined()
    const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/u, '').trimEnd()
    expect(renderSkillContent(loaded!)).toContain(`<skill_instructions>\n${body}\n</skill_instructions>`)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('checks the edited writer oracle text without claiming a replay result', async () => {
  const expected = await readFile(new URL('../../../snapshots/session/muse-trope-adaptation-skill/writer.expected.jsonl', import.meta.url), 'utf8')
  const results = expected.trimEnd().split(/\r?\n/u).map(line => JSON.parse(line) as {
    type: string
    data?: { message?: { content?: { type: string; text?: string }[] } }
  }).filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(1)
  const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/u, '').trimEnd()
  expect(results[0]?.data?.message?.content?.[0]?.text).toContain(`<skill_instructions>\n${body}\n</skill_instructions>`)
})
