import type { Work } from './types.ts';

/**
 * Returns when a work's metric values were measured.
 * @param work Current work record.
 * @returns `metricsObservedAt`, else `observedAt` when any value is known, else null when no metric value is known.
 */
export function metricsMeasuredAt(work: Pick<Work, 'metrics' | 'observedAt' | 'metricsObservedAt'>): string | null {
  return work.metricsObservedAt ?? (work.metrics.some(metric => metric.value !== null) ? work.observedAt : null);
}
