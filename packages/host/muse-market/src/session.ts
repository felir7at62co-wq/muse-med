/** Required Session publication selections and their deterministic projection. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ProjectionDefinition, SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection'
import { marketManifest, marketRecord } from './format.ts'
import type { MarketRelease, MuseMarketBindingEntry, MuseMarketBindingState } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete immutable market release set selected before the first participating request.
     * Required on read: ignoring it could execute a different default release.
     */
    'muse-market/bound': { readonly releases: readonly MuseMarketBindingEntry[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    museMarketBinding: SessionProjectionSummaryExcluded<MuseMarketBindingState>
  }
}

function releaseRecord(value: unknown): value is MarketRelease {
  if (!marketRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/u.test(value.id)
    || value.sha256 !== value.id || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) return false
  try { marketManifest(value.manifest) }
  catch (_error) { return false }
  return true
}

const releaseSchema = z.custom<MarketRelease>(releaseRecord)
const skillSchema = z.object({
  name: z.string().min(1), description: z.string().min(1), whenToUse: z.string().optional(),
  invocation: z.object({ modelInvocable: z.boolean(), userInvocable: z.boolean() }),
}).transform(skill => ({ name: skill.name, description: skill.description, invocation: skill.invocation,
  ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }) }))
const entrySchema = z.object({ release: releaseSchema, skill: skillSchema })
  .refine(entry => entry.skill.name === entry.release.manifest.skills[0]?.name)
const stateSchema = z.object({ bound: z.boolean(), requested: z.boolean(), releases: z.array(entrySchema) })
  .refine(state => (state.bound || state.releases.length === 0)
    && new Set(state.releases.map(entry => entry.skill.name)).size === state.releases.length
    && new Set(state.releases.map(entry => entry.release.id)).size === state.releases.length)
  .transform((state): MuseMarketBindingState => state)

/** Reconstruct the exact market candidate set without reading private installation state. */
export const marketBindingProjectionDefinition = {
  key: 'museMarketBinding', stateVersion: 1, stateSchema,
  init: () => ({ bound: false, requested: false, releases: [] }),
  apply: (state, event) => {
    if (event.type === 'request/header') return state.requested ? state : { ...state, requested: true }
    if (event.type !== 'muse-market/bound') return state
    if (!state.bound && state.requested) throw new Error('A market release set must be selected before the first request')
    const next = stateSchema.parse({ ...state, bound: true, releases: event.data.releases })
    if (state.bound) {
      if (!isDeepStrictEqual(state.releases, next.releases)) throw new Error('A bound market release set cannot change')
      return state
    }
    return next
  },
  wire: { viewSchema: stateSchema, view: state => state, summary: false },
} satisfies ProjectionDefinition<'museMarketBinding', MuseMarketBindingState>
