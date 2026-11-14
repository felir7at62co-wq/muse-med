/**
 * Route resolution and the pure verdict of prompt-usage-guard: a finished reply
 * fails only when its provider-reported prompt is below both the request's tool
 * definitions and its working-context estimate.
 * @module
 */

import type { FinishReason, TokenUsage } from '@deepseek-ai/dsh-llm'

/** One guarded provider/model route as written in the mounting composition. */
export interface RouteConfig {
  /** Logical provider id of the request, exactly as the loop sends it. */
  provider: string
  /** Logical model id of the request, exactly as the loop sends it. */
  model: string
  /** Multiple of the request's tool-schema estimate the reported prompt must reach. */
  minToolSchemaRatio: number
  /** Fraction of the working-context estimate the reported prompt must reach; below 1. */
  minEstimateRatio: number
}

/** A validated route; thresholds are finite and positive, `minEstimateRatio` is below 1. */
export type ResolvedRoute = Readonly<RouteConfig>

const CONFIG_KEYS: ReadonlySet<string> = new Set(['routes'])
const ROUTE_KEYS: ReadonlySet<string> = new Set(['provider', 'model', 'minToolSchemaRatio', 'minEstimateRatio'])

/**
 * Key one route by its exact provider and model ids.
 * @param provider - logical provider id.
 * @param model - logical model id.
 * @returns a key that never conflates ids containing separators.
 */
export function routeKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ratio(value: unknown, at: string, upper: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= upper) {
    throw new Error(`${at} must be a finite number above 0${upper === Number.POSITIVE_INFINITY ? '' : ` and below ${upper}`}`)
  }
  return value
}

function id(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${at} must be a non-empty string`)
  return value
}

/**
 * Validate the mounted routes before any request is judged.
 * @param config - the plugin configuration as mounted, after schema parsing.
 * @returns the routes keyed by {@link routeKey}.
 * @throws Error naming the offending field when a key is unknown, a field is missing or out of range, or a route repeats.
 */
export function resolveRoutes(config: unknown): ReadonlyMap<string, ResolvedRoute> {
  if (!isRecord(config)) throw new Error('prompt-usage-guard: config must be an object with routes')
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`prompt-usage-guard: unknown config key ${JSON.stringify(key)}`)
  }
  const listed: unknown = config.routes
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new Error('prompt-usage-guard: routes must list at least one provider/model route')
  }
  const routes = new Map<string, ResolvedRoute>()
  listed.forEach((route: unknown, index) => {
    const at = `prompt-usage-guard: routes[${index}]`
    if (!isRecord(route)) throw new Error(`${at} must be an object`)
    for (const key of Object.keys(route)) {
      if (!ROUTE_KEYS.has(key)) throw new Error(`${at} has unknown key ${JSON.stringify(key)}`)
    }
    const resolved: ResolvedRoute = Object.freeze({
      provider: id(route.provider, `${at}.provider`),
      model: id(route.model, `${at}.model`),
      minToolSchemaRatio: ratio(route.minToolSchemaRatio, `${at}.minToolSchemaRatio`, Number.POSITIVE_INFINITY),
      minEstimateRatio: ratio(route.minEstimateRatio, `${at}.minEstimateRatio`, 1),
    })
    const key = routeKey(resolved.provider, resolved.model)
    if (routes.has(key)) {
      throw new Error(`${at} repeats provider ${JSON.stringify(resolved.provider)} model ${JSON.stringify(resolved.model)}`)
    }
    routes.set(key, resolved)
  })
  return routes
}

/** The measured values behind a reject or near-miss verdict. */
export interface ShortfallMeasurement {
  /** Provider-reported prompt: input plus cache-read plus cache-write tokens. */
  reportedPromptTokens: number
  /** Heuristic tokens of the request's non-deferred tool schemas. */
  toolSchemaTokens: number
  /** Token meter working-context estimate of the request. */
  estimateTokens: number
  /** The reported prompt is below `minToolSchemaRatio` times the tool-schema estimate. */
  belowToolSchemas: boolean
  /** The reported prompt is below `minEstimateRatio` times the working estimate. */
  belowEstimate: boolean
}

/** Pass, reject (both thresholds missed), or near-miss (exactly one missed). */
export type ShortfallVerdict = { kind: 'pass' } | ({ kind: 'reject' | 'near-miss' } & ShortfallMeasurement)

/** Inputs of one verdict, all measured for the same request. */
export interface AssessInput {
  /** Terminal finish reason of the reply. */
  finish: FinishReason
  /** The reply contains tool-call evidence. */
  toolCall: boolean
  /** Latest usage chunk of the reply, if any. */
  usage: TokenUsage | undefined
  /** Heuristic tokens of the request's non-deferred tool schemas. */
  toolSchemaTokens: number
  /** Token meter working-context estimate of the request. */
  estimateTokens: number
  /** Thresholds of the request's route. */
  route: ResolvedRoute
}

/**
 * Judge one finished reply. Only a tool-less `stop` with reported usage is judged;
 * missing or zero usage and missing references always pass.
 * @param input - the reply's finish, tool-call evidence and usage with the request's references and route.
 * @returns the verdict; reject only when the reported prompt misses both thresholds.
 */
export function assess(input: AssessInput): ShortfallVerdict {
  const { finish, toolCall, usage, toolSchemaTokens, estimateTokens, route } = input
  if (finish.kind !== 'stop' || toolCall || usage === undefined) return { kind: 'pass' }
  const reportedPromptTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  if (!(reportedPromptTokens > 0) || !(toolSchemaTokens > 0) || !(estimateTokens > 0)) return { kind: 'pass' }
  const belowToolSchemas = reportedPromptTokens < route.minToolSchemaRatio * toolSchemaTokens
  const belowEstimate = reportedPromptTokens < route.minEstimateRatio * estimateTokens
  if (!belowToolSchemas && !belowEstimate) return { kind: 'pass' }
  return {
    kind: belowToolSchemas && belowEstimate ? 'reject' : 'near-miss',
    reportedPromptTokens, toolSchemaTokens, estimateTokens, belowToolSchemas, belowEstimate,
  }
}
