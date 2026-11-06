/** Scope-local Skill provider synthesized only for an enabled market Bot. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from './index.ts'

export const name = 'muse-market-bot-skills'
export const inject = ['museMarket', 'skills']

/** Exact locally installed Bot release selected by the Host. */
export interface Config {
  readonly releaseId: string
}

export const Config = Schema.object({ releaseId: Schema.string().required() })

/** Register only the Skill files declared by one verified Bot manifest. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const provider = await ctx.museMarket.botSkillProvider(config.releaseId)
  ctx.skills.registerProvider(() => provider)
}
