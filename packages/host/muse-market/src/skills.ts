/** Provider adapter for verified market Skill releases. */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'
import { marketSkill } from './package.ts'
import type { MuseMarketLocal } from './local.ts'
import type { MarketManifest, MarketRelease } from './types.ts'

/** Build a provider over exact installed releases without copying them into shared roots.
 * @param local Installation verifier and resource locations.
 * @param releases Exact enabled or session-bound Skill releases.
 * @param providerName Scope-local provider identifier.
 * @returns Metadata-only catalogs and bodies reverified from their selected release on use; discovery still reads Skill files.
 */
export function createMarketSkillProvider(local: MuseMarketLocal, releases: readonly MarketRelease[], providerName: string): SkillProvider {
  const definition = async (
    release: MarketRelease, skill: MarketManifest['skills'][number], options: SkillLookupOptions,
  ): Promise<SkillDefinition & { readonly path: string; readonly resourceBase: { readonly kind: 'directory'; readonly path: string } }> => {
    options.signal?.throwIfAborted()
    const path = join(local.directory(release), ...skill.path.split('/'))
    const parsed = marketSkill(await readFile(path, { encoding: 'utf8', signal: options.signal }), skill.name)
    options.signal?.throwIfAborted()
    return { name: skill.name, path, ...parsed, source: 'muse-market', provider: providerName,
      resourceBase: { kind: 'directory', path: dirname(path) } }
  }
  return {
    name: providerName,
    async list(options = {}) {
      options.signal?.throwIfAborted()
      const rows: SkillCandidate[] = []
      for (const release of releases) {
        options.signal?.throwIfAborted()
        await local.verify(release)
        options.signal?.throwIfAborted()
        for (const skill of release.manifest.skills) {
          const row = await definition(release, skill, options)
          rows.push({ name: row.name, path: row.path, description: row.description, invocation: row.invocation,
            source: row.source, provider: row.provider, resourceBase: row.resourceBase, rank: 350, locator: row.name })
        }
      }
      return rows
    },
    async get(candidate: SkillCandidate, options = {}) {
      options.signal?.throwIfAborted()
      for (const release of releases) {
        const skill = release.manifest.skills.find(row => row.name === candidate.name)
        if (skill === undefined) continue
        await local.verify(release)
        options.signal?.throwIfAborted()
        return await definition(release, skill, options)
      }
      return undefined
    },
  }
}
