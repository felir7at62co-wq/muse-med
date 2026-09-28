import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

const bundledSkillDir = fileURLToPath(new URL('../skills/', import.meta.url))

it('bundles a pool claim skill that requires the user to authorize targets and window', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, bundledSkillDir, watch: false })
    const summary = (await ctx.skills.list()).find(skill => skill.name === 'jubian-snatch')
    expect(summary).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true } })
    expect(summary?.description).toMatch(/抢本|认领/u)
    const skill = await ctx.skills.get('jubian-snatch')
    const text = renderSkillContent(skill!)
    expect(text).toMatch(/canClaim=1/u)
    expect(text).toMatch(/用户.*明确授权/su)
    expect(text).toMatch(/jubian_claim\.inspect/u)
    expect(text).toMatch(/jubian_snatch/u)
    expect(text).toMatch(/进程重启.*不恢复/su)
    expect(skill?.content).not.toMatch(/[A-Z]:[\\/]|\.credentials-alt|JUBIAN_TOKEN/u)
  } finally { await ctx.fiber.dispose() }
})
