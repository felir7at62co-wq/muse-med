/** Public Qimao metadata types; absent site metrics remain unknown. */
import type { Branded } from '@deepseek-ai/dsh-brand';

export type QimaoBookId = Branded<'qimao-book-id'>;
export type Channel = 'boy' | 'girl';
export type Board = 'hot' | 'new' | 'over' | 'collect' | 'update';
export type Period = 'date' | 'month';
export type MetricField = 'heat' | 'cumulativePopularity' | 'readOccurrences';
export interface QimaoConfig {
  requestTimeoutMs?: number; maxResponseBytes?: number; requestIntervalMs?: number; cacheTtlMs?: number;
  maxCacheEntries?: number; maxPages?: number; allowLegacyResponseHeaders?: boolean;
}
export interface Metric {
  label: string; raw: string | null; value: number | null; approximate: boolean; precisionStep: number | null;
  observedAt: string; missingReason: 'not_displayed' | 'unparseable' | null;
}
export interface Observation {
  source: 'rank' | 'library' | 'detail'; sourceUrl: string; fetchedAt: string;
  channel?: Channel; board?: Board; period?: Period; page?: number; rank?: number; positionOnPage?: number;
  filter?: 'recent_short_ongoing'; sort?: 'click'; bookId?: QimaoBookId;
  metrics: Record<MetricField, Metric>;
}
export interface Book {
  bookId: QimaoBookId; title: string; url: string; author: string; tags: string[]; description: string;
  status: string | null; wordCount: Metric; updatedAt: string | null; metrics: Record<MetricField, Metric>;
  currentReaders: null; goldenPick: null; sourceUrl: string; fetchedAt: string;
  observations: Observation[]; missingMetrics: { field: MetricField; reason: 'not_displayed' | 'unparseable' }[];
}
export interface RankingOptions {
  source?: 'rank' | 'library'; channels?: Channel[]; boards?: Board[]; periods?: Period[]; pages?: number; refresh?: boolean;
}
export interface Coverage {
  completeFor: 'requested_public_pages'; siteWide: false; pagesRequested: number; pagesFetched: number; uniqueBooks: number; complete: boolean;
  failures: { sourceUrl: string; code: string; message: string; page: number; path: string; channel?: Channel; board?: Board; period?: Period }[];
  pages: { sourceUrl: string; fetchedAt: string; fromCache: boolean; transport: 'fetch' | 'https_legacy_headers'; itemCount: number; paginationVerified: boolean; page: number; path: string }[];
  metrics: { scope: 'fetched_public_observations'; observations: number; complete: boolean; fields: Record<MetricField, { known: number; missing: number; complete: boolean }> };
}
export interface RankingResult {
  scope: 'public_rank_initial_windows' | 'public_filtered_library_pages'; items: Book[]; coverage: Coverage;
  selection: { source: 'rank' | 'library'; filter?: 'recent_short_ongoing'; updatedWithinDays?: number; wordCountBelow?: number; status?: string; sort?: 'click' };
  fetchedAt: string; fromCache: boolean; note: string;
}
export type SearchResult = Omit<RankingResult, 'scope'> & {
  scope: 'collected_public_window_search'; query: string; complete: false; matchedInWindow: number; availableInWindow: number; offset: number; limit: number;
};
export type DetailResult = Book & { fromCache: boolean; transport: 'fetch' | 'https_legacy_headers' };
export interface QimaoDependencies {
  fetch?: typeof fetch; now?: () => number;
  legacyRequest?: (url: URL, config: Required<QimaoConfig>, signal: AbortSignal) => Promise<string>;
}
export class QimaoClient {
  constructor(config?: QimaoConfig, dependencies?: QimaoDependencies);
  readonly config: Required<QimaoConfig>;
  rankings(options?: RankingOptions, signal?: AbortSignal): Promise<RankingResult>;
  search(options: RankingOptions & { query: string; offset?: number; limit?: number }, signal?: AbortSignal): Promise<SearchResult>;
  detail(options: { bookId: string; refresh?: boolean }, signal?: AbortSignal): Promise<DetailResult>;
  dispose(): Promise<void>;
}
export function resolveConfig(config?: QimaoConfig): Required<QimaoConfig>;
export const name: 'muse-qimao-data';
export const inject: readonly ['tools'];
/** Register in the caller's Cordis scope; disposal awaits admitted metadata reads. */
export function apply(ctx: { tools: { register(definition: object): () => void }; effect(factory: () => (() => void | Promise<void>), label?: string): unknown }, config?: QimaoConfig): void;
