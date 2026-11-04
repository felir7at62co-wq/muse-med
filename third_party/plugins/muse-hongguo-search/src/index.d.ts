/** Deployment bounds for the read-only official public-page client. */
export interface HongguoConfig {
  requestTimeoutMs?: number; maxResponseBytes?: number; cacheTtlMs?: number;
  maxPages?: number; requestIntervalMs?: number; maxCacheEntries?: number; incompletePageRetries?: number;
}
/** Source count; approximate:false does not guarantee backend precision. */
export interface Count { raw: string | null; value: number | null; approximate: boolean; precisionStep: number | null }
export type Board = 'hot-drama' | 'hot-real-drama' | 'hot-ai-drama' | 'hot-comic-drama';
/** Public ranking metric names retained independently on every source observation. */
export type MetricField = 'collection' | 'likes' | 'heat';
/** An unavailable displayed count; the source text remains in the corresponding Count. */
export interface MissingMetric { field: MetricField; reason: 'not_displayed' | 'unparseable' }
/** Counts and rank from one fetched board page, before cross-board deduplication. */
export interface RankingObservation {
  board: Board; page: number; rank: number; sourceUrl: string; fetchedAt: string; updateDate: string | null;
  sourceFormat: 'embedded_json' | 'rendered_html'; collection: Count; likes: Count; heat: Count; missingMetrics: MissingMetric[];
}
/** Completeness of one metric among the fetched ranking observations. */
export interface MetricFieldCoverage { known: number; missing: number; complete: boolean }
/** Field coverage of fetched observations only; absent pages are reported separately. */
export interface MetricCoverage {
  scope: 'fetched_ranking_observations'; observations: number; complete: boolean;
  fields: Record<MetricField, MetricFieldCoverage>;
}
export interface Drama {
  seriesId: string; title: string; url: string; watchPageUrl: string | null; urlKind: string; watchPageKind: string; coverUrl: string | null; description: string;
  tags: string[]; collection: Count; likes: Count; episodeCount: number | null;
  [key: string]: unknown;
}
/** A parsed ranking card before cross-board deduplication. */
export interface RankingEntry extends Drama { heat: Count; observation: RankingObservation }
/** A unique series with all board observations and conservative displayed counts. */
export interface RankedDrama extends Drama {
  heat: Count; observations: RankingObservation[]; collectionSelection: 'minimum_observed';
  conflicts: { field: MetricField; values: number[] }[];
}
export interface RankingResult {
  scope: 'public_rankings'; items: RankedDrama[]; fetchedAt: string; fromCache: boolean; note: string;
  coverage: { boards: Board[]; pagesFetched: number; pagesExpected: number; uniqueSeries: number;
    complete: boolean; metrics: MetricCoverage; truncated: boolean; failures: { board: string; page: number; sourceUrl: string; error: string }[];
    pages: { board: string; page: number; sourceUrl: string; fetchedAt: string; updateDate: string | null; fromCache: boolean; attempts: number; itemCount: number }[] };
}
export interface RankingOptions { boards?: Board[]; refresh?: boolean }
export interface PagingOptions { offset?: number; limit?: number }
export class HongguoClient {
  constructor(config?: HongguoConfig, dependencies?: { fetch?: typeof fetch; now?: () => number });
  rankings(options?: RankingOptions, signal?: AbortSignal): Promise<RankingResult>;
  collections(options?: RankingOptions & PagingOptions & { minCollections?: number; includeUncertain?: boolean }, signal?: AbortSignal): Promise<RankingResult & { minCollections: number; totalMatched: number; totalUncertain: number; uncertain: Partial<Drama>[]; offset: number; limit: number; thresholdNote: string }>;
  search(options: PagingOptions & { query: string; refresh?: boolean }, signal?: AbortSignal): Promise<{ scope: 'public_keyword_search_initial_window'; query: string; items: Drama[]; availableInWindow: number; sourceReportedTotal: string | null; sourceUrl: string; fetchedAt: string; fromCache: boolean; complete: false; truncated: boolean; note: string; offset: number; limit: number }>;
  detail(options: { seriesId: string; refresh?: boolean }, signal?: AbortSignal): Promise<Drama>;
  dispose(): void;
}
export const name: 'muse-hongguo-search';
export const inject: readonly ['tools'];
export function resolveConfig(config?: HongguoConfig): Required<HongguoConfig>;
/** Structural Cordis context keeps consumers independent of unpublished DSH package versions. */
export function apply(ctx: { tools: { register(definition: object): () => void }; effect(factory: () => () => void, label?: string): unknown }, config?: HongguoConfig): void;
