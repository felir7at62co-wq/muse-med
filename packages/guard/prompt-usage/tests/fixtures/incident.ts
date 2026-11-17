/**
 * Measured replies from local Muse sessions on `muse-cloud-yunying`/`gemini-3.1-pro`.
 * `usage` is the provider-reported usage, `toolSchemaTokens` the heuristic size of the
 * request's tool schemas, `estimateTokens` the logged `request/context.workingContextTokens`.
 * Rejected rows are tool-less `stop` replies from the relay lane that dropped tools.
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** One labelled reply. */
export interface IncidentRow {
  /** Session id prefix and event sequence of the reply. */
  source: string
  usage: TokenUsage
  toolSchemaTokens: number
  estimateTokens: number
  expected: 'reject' | 'pass'
}

const prompt = (inputTokens: number, outputTokens = 100): TokenUsage => ({ inputTokens, outputTokens })

/** Desktop thresholds for the route. */
export const ROUTE = { provider: 'muse-cloud-yunying', model: 'gemini-3.1-pro', minToolSchemaRatio: 1, minEstimateRatio: 0.5 }

/** Every inferred bad reply and the healthy replies closest to the thresholds. */
export const INCIDENT_ROWS: readonly IncidentRow[] = [
  { source: 'da65c279 seq 119', usage: { inputTokens: 4637, outputTokens: 662 }, toolSchemaTokens: 24235, estimateTokens: 52798, expected: 'reject' },
  { source: 'da65c279 seq 133', usage: prompt(5571), toolSchemaTokens: 24235, estimateTokens: 40858, expected: 'reject' },
  { source: 'b6bdc6a7 seq 18', usage: prompt(2161), toolSchemaTokens: 7389, estimateTokens: 11697, expected: 'reject' },
  { source: '9dda25a7 seq 22', usage: prompt(4424), toolSchemaTokens: 10030, estimateTokens: 17565, expected: 'reject' },
  { source: 'b85be448 seq 451', usage: prompt(7734), toolSchemaTokens: 12682, estimateTokens: 63915, expected: 'reject' },
  { source: 'b85be448 seq 462', usage: prompt(7839), toolSchemaTokens: 12682, estimateTokens: 63969, expected: 'reject' },
  { source: 'b85be448 seq 473', usage: prompt(9005), toolSchemaTokens: 12682, estimateTokens: 64429, expected: 'reject' },
  { source: 'b85be448 seq 484', usage: prompt(9237), toolSchemaTokens: 12682, estimateTokens: 64531, expected: 'reject' },
  { source: 'da65c279 seq 23', usage: prompt(20659), toolSchemaTokens: 10326, estimateTokens: 17045, expected: 'pass' },
  { source: 'da65c279 seq 50', usage: { inputTokens: 6951, outputTokens: 100, cacheReadTokens: 20018 }, toolSchemaTokens: 10326, estimateTokens: 29390, expected: 'pass' },
  { source: 'da65c279 seq 112', usage: prompt(50349), toolSchemaTokens: 24235, estimateTokens: 56957, expected: 'pass' },
  { source: '15eb2463 seq 19', usage: prompt(24916), toolSchemaTokens: 12493, estimateTokens: 17862, expected: 'pass' },
  { source: '59f840a0 seq 39', usage: prompt(23156), toolSchemaTokens: 10749, estimateTokens: 23144, expected: 'pass' },
  { source: '3ad9fba1 seq 5402', usage: prompt(43447), toolSchemaTokens: 18386, estimateTokens: 66284, expected: 'pass' },
  { source: '24dcf223 seq 24073', usage: prompt(120129), toolSchemaTokens: 32935, estimateTokens: 214869, expected: 'pass' },
]
