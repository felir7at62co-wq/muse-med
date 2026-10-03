export { HongguoClient, resolveConfig } from './index.js';
export type { HongguoConfig, Count, Board, Drama, RankingResult, RankingOptions, PagingOptions } from './index.js';
import type { Drama } from './index.js';
export function deduplicate(items: Drama[]): Drama[];
export function thresholdStatus(item: Drama, minimum: number): 'meets' | 'below' | 'uncertain' | 'unknown';
