export type Channel = 'boy' | 'girl';
export type Board = 'hot' | 'new' | 'over' | 'collect' | 'update';
export type Period = 'date' | 'month';
export const ORIGIN: 'https://www.qimao.com';
export const CHANNELS: Readonly<Record<Channel, string>>;
export const BOARDS: Readonly<Record<Board, string>>;
export const PERIODS: Readonly<Record<Period, string>>;
export const METRIC_LABELS: Readonly<Record<'heat' | 'cumulativePopularity' | 'readOccurrences', string>>;
export class QimaoError extends Error { constructor(code: string, message: string); code: string; }
export interface QimaoMetric {
  label: string; raw: string | null; value: number | null; approximate: boolean;
  precisionStep: number | null; observedAt: string; missingReason: string | null;
}
export interface QimaoRankingItem {
  bookId: string; title: string; url: string; author: string; tags: string[]; description: string;
  status: string | null; coverUrl: string | null; updatedAt: string | null; wordCount: QimaoMetric;
  metrics: Record<'heat' | 'cumulativePopularity' | 'readOccurrences', QimaoMetric>;
  currentReaders: null; goldenPick: null; sourceUrl: string; fetchedAt: string;
  observations: Array<{ channel: Channel; board: Board; period: Period; page: number; rank: number }>;
}
export interface RankingOptions { channel: Channel; board: Board; period: Period; sourceUrl: string; fetchedAt: string; }
export interface RankingPageConfig { total: number; pageSize: number; month: string; }
export function parseMetric(raw: string | null, label: string, observedAt: string): QimaoMetric;
export function bookId(value: string): string;
export function parseRanking(html: string, options: RankingOptions): { items: QimaoRankingItem[]; page: 1; paginationVerified: false };
export function rankingPageConfig(html: string): RankingPageConfig;
export function parseRankingApi(body: string, options: RankingOptions, expected: RankingPageConfig & { page: number }): { items: QimaoRankingItem[]; page: number; total: number; month: string };
