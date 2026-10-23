/** Numeric interaction counts; null means the service did not provide a usable count. */
export interface InteractionCounts { likes: number | null; comments: number | null; recommendations: number | null; shares: number | null }
/** One actual episode observation, without personal or playback data. */
export interface EpisodeEngagement { episodeNo: number; status: string; observedAtMs: number | null; counts: InteractionCounts }
/** A timed series observation; totals are episode sums, never distinct people. */
export interface EngagementReport {
  scope: 'episode' | 'series'; aggregation: 'episode-sum'; source: 'usergetdramameta'
  startedAtMs: number; finishedAtMs: number; episodeCount: number; catalogComplete: boolean; complete: boolean
  totals: InteractionCounts; knownTotals: InteractionCounts; coveredEpisodes: InteractionCounts
  missingEpisodeNumbers: number[]; episodes: EpisodeEngagement[]
}
const nullableCount = { oneOf: [{ type: 'integer' }, { type: 'null' }] } as const
/** Fixed fields accepted from the target's interaction endpoint. */
export const interactionCountsSchema = { type: 'object', additionalProperties: false, properties: {
  likes: { ...nullableCount, required: true }, comments: { ...nullableCount, required: true },
  recommendations: { ...nullableCount, required: true }, shares: { ...nullableCount, required: true },
} } as const
/** One observation persisted in tool results. */
export const episodeEngagementSchema = { type: 'object', additionalProperties: false, properties: {
  episodeNo: { type: 'integer', required: true }, status: { type: 'string', required: true },
  observedAtMs: { ...nullableCount, required: true }, counts: { ...interactionCountsSchema, required: true },
} } as const
/** Model-readable aggregate and all episode observations. */
export const engagementReportSchema = { type: 'object', additionalProperties: false, properties: {
  scope: { type: 'string', enum: ['episode', 'series'], required: true },
  aggregation: { type: 'string', enum: ['episode-sum'], required: true }, source: { type: 'string', enum: ['usergetdramameta'], required: true },
  startedAtMs: { type: 'integer', required: true }, finishedAtMs: { type: 'integer', required: true }, episodeCount: { type: 'integer', required: true },
  catalogComplete: { type: 'boolean', required: true }, complete: { type: 'boolean', required: true },
  totals: { ...interactionCountsSchema, required: true }, knownTotals: { ...interactionCountsSchema, required: true }, coveredEpisodes: { ...interactionCountsSchema, required: true },
  missingEpisodeNumbers: { type: 'array', items: { type: 'integer' }, required: true },
  episodes: { type: 'array', items: episodeEngagementSchema, required: true },
} } as const
