/** Types for the retained MIT public-page parser; it never evaluates page JavaScript. */
export type Board = 'hot-drama' | 'hot-real-drama' | 'hot-ai-drama' | 'hot-comic-drama' | 'new-drama' | 'followed-drama' | 'must-watch-drama';
export interface Count {
  raw: string | null;
  value: number | null;
  approximate: boolean;
  precisionStep: number | null;
}
export interface RankingEntry {
  seriesId: string;
  title: string;
  url: string;
  coverUrl: string | null;
  description: string;
  tags: string[];
  collection: Count;
  likes: Count;
  heat: Count;
  rankingPrimary: Count & { label: string };
  /** Displayed share count; only ranking cards show it. */
  shares: Count;
  /** Displayed 0–10 rating, or null when not shown. */
  rating: number | null;
  /** Number of ratings behind `rating`. */
  ratingCount: Count;
  episodeCount: number | null;
  observation: {
    board: Board;
    page: number;
    rank: number;
    sourceUrl: string;
    fetchedAt: string;
    updateDate: string | null;
    sourceFormat: 'embedded_json' | 'rendered_html';
  };
}
export const ORIGIN: 'https://hongguoduanju.com';
export const BOARDS: readonly Board[];
/** Extracts inert loader JSON; unfinished streamed values reject unless explicitly allowed. */
export function routeData(html: string, route: string, options?: { allowPending?: boolean }): Record<string, unknown>;
export function parseCount(raw: unknown, label?: string): Count;
/** Parses a displayed 0–10 rating such as 9.4分; returns null when absent or not a rating. */
export function parseRating(raw: unknown): number | null;
export function parseRanking(html: string, options: {
  board: Board; page: number; sourceUrl: string; fetchedAt: string;
}): { items: RankingEntry[]; page: number; totalPages: number; updateDate: string | null };
export class IncompletePageError extends Error {}
