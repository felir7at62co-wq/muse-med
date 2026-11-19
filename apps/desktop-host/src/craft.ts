/** Lean short-drama composition: craft rules are preset-scoped skills, and only runtime notes stay resident. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerEditingRuntimeSections } from './editing-policy.ts'
import { installShortDramaDelivery } from './short-drama-delivery.ts'

/** Cordis plugin identity. */
export const name = 'muse-craft'
/** Scoped system-prompt and skill registries. */
export const inject = ['systemPrompt', 'skills']

/** One craft skill as stored in `craft-skills/<name>/SKILL.md`. */
export interface CraftSkill {
  readonly name: string
  readonly description: string
  readonly content: string
}

const SKILL_FILE = /^---\nname: (?<name>[a-z0-9-]+)\ndescription: (?<description>[^\n]+)\n---\n\n(?<content>[\s\S]+)$/u

/**
 * Read the craft skills shipped beside this module.
 * @param root - Directory holding one `<name>/SKILL.md` per skill.
 * @returns the skills in name order; a file whose header is malformed or names another skill throws.
 */
export function readCraftSkills(root: string = fileURLToPath(new URL('../craft-skills', import.meta.url))): CraftSkill[] {
  const directories = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  return directories.map((directory) => {
    const groups = SKILL_FILE.exec(readFileSync(join(root, directory, 'SKILL.md'), 'utf8'))?.groups
    if (groups?.name !== directory || groups.description === undefined || groups.content === undefined) {
      throw new Error(`muse-craft: ${directory}/SKILL.md needs a name matching its directory, a one-line description and a body`)
    }
    return { name: groups.name, description: groups.description, content: groups.content }
  })
}

/**
 * Register the craft skills for this preset alone and keep the delivery checks and runtime notes of the editing presets.
 * @param ctx - Lean short-drama preset's standing scope.
 */
export function apply(ctx: Context): void {
  installShortDramaDelivery(ctx)
  registerEditingRuntimeSections(ctx)
  for (const skill of readCraftSkills()) ctx.skills.register({ ...skill, source: 'bundled' })
}
