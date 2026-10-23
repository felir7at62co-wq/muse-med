/** Resolve a title to one explicit source and preserve the actual returned episode directory. */
import { BridgeError, type Parameters, type RequestPort } from './port.ts'
import { projectResult, type Result } from './result.ts'
import type { SeriesSelection } from './series.ts'

/** Model-readable candidate identities, without playback addresses. */
export interface DramaCandidate { readonly title: string; readonly srcAppId: string; readonly originDramaId: string }
/** A title alone cannot select between multiple exact matches. */
export type CatalogSelection = { readonly kind: 'selected'; readonly selection: SeriesSelection }
  | { readonly kind: 'selection-required'; readonly candidates: readonly DramaCandidate[] }
/** Explicit request limits; supplied by the consumer's resolved configuration. */
export interface CatalogLimits { readonly maxQueryChars: number; readonly maxEpisodeCount: number; readonly maxResultItems: number; readonly maxSeriesEpisodes: number }
/** The caller supplies either a query or both previously selected identifiers. */
export interface CatalogInput { readonly query?: string; readonly srcAppId?: string; readonly dramaId?: string }
const normalized = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
function accepted(result: Result): void { if (!result.ok) throw new BridgeError(result.status) }

/**
 * Read the real catalog before starting any per-episode media operation.
 * @param port - Borrowed, authenticated high-level native connection.
 * @param input - Exact title or explicit source identity selected from search.
 * @param limits - Bound directory size, query length and page width.
 * @param signal - Calling Session's cancellation.
 * @returns A selected source with actual numbers, or candidates requiring disambiguation.
 */
export async function resolveSeriesCatalog(port: RequestPort, input: CatalogInput, limits: CatalogLimits, signal: AbortSignal): Promise<CatalogSelection> {
  signal.throwIfAborted()
  let selection: { srcAppId: string; dramaId: string }
  if (input.srcAppId !== undefined || input.dramaId !== undefined) {
    if (input.query !== undefined || !/^wx[0-9a-f]{16}$/.test(input.srcAppId ?? '') || !/^[A-Za-z0-9_-]{1,64}$/.test(input.dramaId ?? '')) throw new BridgeError('invalid-arguments')
    selection = { srcAppId: String(input.srcAppId), dramaId: String(input.dramaId) }
  } else {
    if (typeof input.query !== 'string' || !input.query.trim() || Array.from(input.query).length > limits.maxQueryChars || /[\x00\r\n]/.test(input.query)) throw new BridgeError('invalid-arguments')
    const search = projectResult('search', await port.request('search', { query: input.query }, signal), limits)
    accepted(search)
    const candidates = search.data.candidates ?? []
    const query = normalized(input.query)
    const exact = candidates.filter(item => normalized(item.title) === query)
    if (exact.length !== 1 || search.data.partial === true) return { kind: 'selection-required', candidates }
    const candidate = exact[0]!
    selection = { srcAppId: candidate.srcAppId, dramaId: candidate.originDramaId }
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(selection.dramaId)) throw new BridgeError('invalid-arguments')
  const detail = projectResult('detail', await port.request('detail', selection, signal), limits)
  accepted(detail)
  if (detail.data.srcAppId !== selection.srcAppId || detail.data.dramaId !== selection.dramaId) throw new BridgeError('response-identity-mismatch')
  const count = detail.data.episodeCount
  if (count === undefined || !Number.isSafeInteger(count) || count < 1 || count > limits.maxSeriesEpisodes) throw new BridgeError('catalog-count-unconfirmed')
  const actual = new Set<number>()
  let complete = true
  for (let start = 1; start <= count;) {
    signal.throwIfAborted()
    const width = Math.min(limits.maxEpisodeCount, count - start + 1)
    const params: Parameters = { ...selection, start, count: width }
    const page = projectResult('episodes', await port.request('episodes', params, signal), limits)
    accepted(page)
    if (page.data.srcAppId !== selection.srcAppId || page.data.dramaId !== selection.dramaId
      || page.data.episodeCount !== count || page.data.requestedStart !== start
      || page.data.requestedEndExclusive !== start + width) throw new BridgeError('catalog-identity-unconfirmed')
    const numbers = page.data.episodeNumbers ?? []
    if (numbers.some(number => number < start || number >= start + width)) throw new BridgeError('catalog-window-unconfirmed')
    for (const number of numbers) actual.add(number)
    if (page.data.partial === true || numbers.length !== width) complete = false
    start += width
  }
  const numbers = [...actual].sort((left, right) => left - right)
  return { kind: 'selected', selection: { ...selection, episodeCount: count, actualEpisodeNumbers: numbers,
    catalogComplete: complete && numbers.length === count && numbers.every((value, index) => value === index + 1),
    ...(detail.data.title === undefined ? {} : { title: detail.data.title }) } }
}
