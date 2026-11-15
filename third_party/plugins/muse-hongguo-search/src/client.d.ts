export { HongguoClient, resolveConfig } from './index.js';
export type { HongguoConfig, Count, Board, Drama, RankingEntry, RankedDrama, RankingObservation, MissingMetric, MetricField, MetricCoverage, MetricFieldCoverage, RankingResult, RankingOptions, PagingOptions } from './index.js';
import type { RankedDrama, RankingEntry } from './index.js';
export function deduplicate(items: RankingEntry[]): RankedDrama[];
export function thresholdStatus(item: RankedDrama, minimum: number): 'meets' | 'below' | 'uncertain' | 'unknown';
