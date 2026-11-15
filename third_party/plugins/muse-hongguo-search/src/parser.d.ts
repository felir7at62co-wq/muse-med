import type { Count, Board, Drama, RankingEntry } from './index.js';
export const ORIGIN: 'https://hongguoduanju.com';
export const BOARDS: readonly Board[];
export const SEARCH_WINDOW_LIMIT: 10;
export function decodeEntities(value: string): string;
export function routeData(html: string, route: string): Record<string, unknown>;
export function parseCount(raw: unknown, label?: string): Count;
export function parseRanking(html: string, options: { board: Board; page: number; sourceUrl: string; fetchedAt: string }): { items: RankingEntry[]; page: number; totalPages: number; updateDate: string | null };
export function parseDetail(html: string, options: { seriesId: string; sourceUrl: string; fetchedAt: string }): Drama;
export function parseSearch(html: string, options: { query: string; sourceUrl: string; fetchedAt: string }): { items: Drama[]; sourceReportedTotal: string | null };
/** Validate the official public keyword JSON first page; missing or contradictory data throws rather than reporting zero matches. */
export function parseSearchResponse(value: unknown, options: { query: string; sourceUrl: string; fetchedAt: string }): { items: Drama[]; sourceReportedTotal: string };
export class IncompletePageError extends Error {}
export class SearchUnavailableError extends Error { readonly code: 'HONGGUO_SEARCH_UNAVAILABLE'; constructor(reason: string) }
