/** Deployment bounds for the read-only official public-page client. */
export interface HongguoConfig {
  requestTimeoutMs?: number; maxResponseBytes?: number; cacheTtlMs?: number;
  maxPages?: number; requestIntervalMs?: number; maxCacheEntries?: number; incompletePageRetries?: number;
}
/** Source count; approximate:false does not guarantee backend precision. */
export interface Count { raw: string | null; value: number | null; approximate: boolean; precisionStep: number | null }
export type Board = 'hot-drama' | 'hot-real-drama' | 'hot-ai-drama' | 'hot-comic-drama';
export interface Drama {
  seriesId: string; title: string; url: string; watchPageUrl: string | null; urlKind: string; watchPageKind: string; coverUrl: string | null; description: string;
  tags: string[]; collection: Count; likes: Count; episodeCount: number | null;
  [key: string]: unknown;
}
export interface RankingResult {
  scope: 'public_rankings'; items: Drama[]; fetchedAt: string; fromCache: boolean; note: string;
  coverage: { boards: Board[]; pagesFetched: number; pagesExpected: number; uniqueSeries: number;
    complete: boolean; truncated: boolean; failures: { board: string; page: number; sourceUrl: string; error: string }[];
    pages: { board: string; page: number; sourceUrl: string; fetchedAt: string; updateDate: string | null; fromCache: boolean; itemCount: number }[] };
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
