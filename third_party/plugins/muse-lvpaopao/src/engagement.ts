/** Read actual episode interactions and report complete or explicitly partial series sums. */
import { resolveSeriesCatalog, type CatalogLimits } from './catalog.ts'
import { BridgeError, type Parameters, type RequestPort } from './port.ts'
import { errorResult, projectResult, type Result } from './result.ts'
import type { EpisodeEngagement, InteractionCounts } from './engagement-data.ts'
const keys = ['likes', 'comments', 'recommendations', 'shares'] as const
const empty = (): InteractionCounts => ({ likes: null, comments: null, recommendations: null, shares: null })

/**
 * Collect four counts without media acquisition, retries or interaction mutations.
 * @param port - Borrowed authenticated connection.
 * @param input - Title or selected source; an optional episode selects one catalog episode.
 * @param limits - Resolved catalog bounds.
 * @param signal - Cancels collection without replaying the current native request.
 * @returns Source-bound totals and episode rows; missing counts never become zero totals.
 */
export async function readEngagement(port: RequestPort, input: Parameters, limits: CatalogLimits, signal: AbortSignal): Promise<Result> {
  const startedAtMs = Date.now()
  const catalog = await resolveSeriesCatalog(port, input, limits, signal)
  if (catalog.kind === 'selection-required') return { action: 'engagement', ok: false, status: 'selection-required',
    data: { candidates: [...catalog.candidates] }, warnings: ['Select an actual source identity; no episode interactions were requested.'] }
  const selection = catalog.selection
  if (input.episodeNo !== undefined && !selection.actualEpisodeNumbers.includes(input.episodeNo)) throw new BridgeError('episode-not-in-catalog')
  const numbers = input.episodeNo === undefined ? selection.actualEpisodeNumbers : [input.episodeNo]
  const episodes: EpisodeEngagement[] = []
  for (const episodeNo of numbers) {
    signal.throwIfAborted()
    let value: unknown
    try { value = await port.request('engagement', { srcAppId: selection.srcAppId, dramaId: selection.dramaId, episodeNo }, signal) }
    catch (error) {
      signal.throwIfAborted()
      episodes.push({ episodeNo, status: errorResult('engagement', error).status, observedAtMs: null, counts: empty() })
      break
    }
    const result = projectResult('engagement', value, limits)
    if (result.data.srcAppId !== selection.srcAppId || result.data.dramaId !== selection.dramaId
      || result.data.episodeEngagement?.episodeNo !== episodeNo) throw new BridgeError('response-identity-mismatch')
    episodes.push(result.data.episodeEngagement)
    // An unsuccessful native read stops admission; it never becomes a retry loop.
    if (!result.ok) break
  }
  const missingEpisodeNumbers = Array.from({ length: selection.episodeCount }, (_, index) => index + 1)
    .filter(number => input.episodeNo === undefined || input.episodeNo === number)
    .filter(number => !episodes.some(episode => episode.episodeNo === number && episode.status === 'engagement-returned'))
  const totals = empty(), knownTotals = empty(), coveredEpisodes = empty()
  const expected = input.episodeNo === undefined ? selection.episodeCount : 1
  for (const key of keys) {
    const observed = episodes.filter(row => row.status === 'engagement-returned' && row.counts[key] !== null)
    const sum = observed.reduce((total, row) => total + (row.counts[key] ?? 0), 0)
    coveredEpisodes[key] = observed.length
    knownTotals[key] = observed.length > 0 && Number.isSafeInteger(sum) ? sum : null
    totals[key] = observed.length === expected && (input.episodeNo !== undefined || selection.catalogComplete) ? knownTotals[key] : null
  }
  const complete = keys.every(key => totals[key] !== null)
  return { action: 'engagement', ok: true, status: complete ? 'engagement-returned' : 'engagement-partial',
    data: { identityMatched: true, srcAppId: selection.srcAppId, dramaId: selection.dramaId, ...(selection.title === undefined ? {} : { title: selection.title }),
      engagement: { scope: input.episodeNo === undefined ? 'series' : 'episode', aggregation: 'episode-sum', source: 'usergetdramameta',
        startedAtMs, finishedAtMs: Date.now(), episodeCount: selection.episodeCount, catalogComplete: selection.catalogComplete, complete,
        totals, knownTotals, coveredEpisodes, missingEpisodeNumbers, episodes } },
    warnings: ['Counts are episode sums observed over the reported time range, not distinct people or a simultaneous platform-wide snapshot. Recommendations use the current-episode all-user public-like amount, never friend-only counts.',
      ...(complete ? [] : ['Unavailable, failed or unread episodes leave the affected total null. knownTotals cover only observed episode counts.'])] }
}
