/** Session-scoped Skill candidates reconstructed from an exact publication selection. */
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { SkillProvider } from '@deepseek-ai/dsh-skill'
import { MarketError, marketSkill } from './format.ts'
import { readMarketPackage } from './package.ts'
import type { MuseMarketLocal } from './local.ts'
import type { MarketLocalConfig } from './local.ts'
import type { MuseMarketBindingEntry } from './types.ts'

/** Advertise fixed candidate facts even when cache bytes are missing; loading then refuses instead of falling back.
 * @param local - Owner of verified publication bytes.
 * @param storage - Captured storage paths and limits.
 * @param releases - Current exact Session selection.
 * @param name - Unique scope-local provider identity.
 * @returns Provider that verifies the selected release and resources on every body load.
 */
export function createMarketSkillProvider(
  local: MuseMarketLocal, storage: MarketLocalConfig,
  releases: () => readonly MuseMarketBindingEntry[] | Promise<readonly MuseMarketBindingEntry[]>, name: string,
): SkillProvider {
  return {
    name,
    list: async (options) => {
      options.signal?.throwIfAborted()
      return (await releases()).map(entry => ({ ...entry.skill, source: 'muse-market', provider: name, rank: 350,
        locator: entry.release.id, path: join(storage.root, 'packages', entry.release.id, `skills/${entry.skill.name}/SKILL.md`),
        resourceBase: { kind: 'directory' as const,
          path: join(storage.root, 'packages', entry.release.id, 'skills', entry.skill.name) } }))
    },
    get: async (candidate, options) => {
      const entry = (await releases()).find(item => item.release.id === candidate.locator && item.skill.name === candidate.name)
      if (entry === undefined) throw new MarketError('bound-release-unavailable')
      options.signal?.throwIfAborted()
      const parsed = readMarketPackage(await local.verify(entry.release), storage.limits)
      const member = parsed.manifest.skills[0]
      const bytes = parsed.skillInstructions
      const path = join(storage.root, 'packages', entry.release.id, ...member.path.split('/'))
      options.signal?.throwIfAborted()
      const loaded = marketSkill(new TextDecoder('utf-8', { fatal: true }).decode(bytes), entry.skill.name)
      const summary = { name: entry.skill.name, description: loaded.description, invocation: loaded.invocation,
        ...(loaded.whenToUse === undefined ? {} : { whenToUse: loaded.whenToUse }) }
      if (!isDeepStrictEqual(summary, entry.skill)) throw new MarketError('bound-release-mismatch')
      return { name: entry.skill.name, ...loaded,
        source: 'muse-market', provider: name, path, resourceBase: { kind: 'directory', path: dirname(path) } }
    },
  }
}
