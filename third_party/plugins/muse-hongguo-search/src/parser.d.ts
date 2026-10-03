import type { Count, Board, Drama } from './index.js';
export const ORIGIN: 'https://hongguoduanju.com';
export const BOARDS: readonly Board[];
export function decodeEntities(value: string): string;
export function routeData(html: string, route: string): Record<string, unknown>;
export function parseCount(raw: unknown, label?: string): Count;
export function parseRanking(html: string, options: { board: Board; page: number; sourceUrl: string; fetchedAt: string }): { items: Drama[]; page: number; totalPages: number; updateDate: string | null };
export function parseDetail(html: string, options: { seriesId: string; sourceUrl: string; fetchedAt: string }): Drama;
export function parseSearch(html: string, options: { query: string; sourceUrl: string; fetchedAt: string }): { items: Drama[]; sourceReportedTotal: string | null };
export class IncompletePageError extends Error {}
