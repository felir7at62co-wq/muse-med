/**
 * Discard a tool-less agent reply whose provider-reported prompt falls below both
 * the request's tool definitions and its working-context estimate, a sign that the
 * provider answered an incomplete request. Only listed provider/model routes are
 * judged, only a `stop` reply without tool calls, and missing or zero usage always
 * passes, as does a report of zero output tokens for a reply that streamed text.
 * The guard replaces the terminal `stop` with a `PROMPT_USAGE_SHORTFALL`
 * failure; the route's retry policy resends the request only when its
 * `retryableCodes` list that code.
 * @module @deepseek-ai/dsh-prompt-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { estimateToolSchemas } from '@deepseek-ai/dsh-token-meter/estimate'
import { assess, resolveRoutes, routeKey, type RouteConfig, type ShortfallMeasurement } from './assess.ts'

/** Failure code of a discarded reply; documented in the package README. */
const PROMPT_USAGE_SHORTFALL = 'PROMPT_USAGE_SHORTFALL'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'prompt-usage-guard'

/** The stream service it wraps, the live sessions it measures, and the meter that estimates them. */
export const inject = ['llm', 'sessions', 'tokenMeter']

/** Deployment policy; there are no default routes or thresholds. */
export interface Config {
  /** Guarded routes with their own thresholds; mounting the plugin without routes fails at load. */
  routes: RouteConfig[]
}

/** Require every route and threshold explicitly in the mounting composition. */
export const Config: z<Config> = z.object({
  routes: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    minToolSchemaRatio: z.number().required(),
    minEstimateRatio: z.number().required(),
  })).required(),
})

/** Recognize a tool call in any of the three chunk forms adapters emit. */
function isToolCallChunk(chunk: StreamChunk): boolean {
  return chunk.type === 'tool-call-delta'
    || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
}

function measurement(verdict: ShortfallMeasurement): string {
  return `reported ${verdict.reportedPromptTokens} prompt tokens, tool schemas ${verdict.toolSchemaTokens}, working estimate ${verdict.estimateTokens}`
}

/**
 * Install the stream guard. Each guarded request is measured when its stream
 * starts; chunks pass through live, and only a rejected terminal `stop` is
 * withheld, which closes the inner stream before inner listeners complete.
 * After disposal no reply is judged.
 * @param ctx - plugin context; disposal removes the listener.
 * @param config - explicit routes, validated before any request.
 */
export function apply(ctx: Context, config: Config): void {
  const routes = resolveRoutes(Config(config))
  let active = true
  ctx.effect(function* () {
    ctx.on('llm/stream', (options, next) => {
      const route = routes.get(routeKey(options.provider, options.model))
      const sessionId = options.sessionId
      // Marked loop requests are conversation requests; auxiliary calls such as compaction carry no mark.
      if (route === undefined || !isAgentLoopRequest(options) || sessionId === undefined) return next()
      return (async function* (): AsyncIterable<StreamChunk> {
        const session = active ? ctx.sessions.get(sessionId) : undefined
        if (session === undefined) {
          yield* next()
          return
        }
        const toolSchemaTokens = estimateToolSchemas((options.tools ?? []).filter(tool => tool.deferLoading !== true))
        const estimateTokens = ctx.tokenMeter.measureWorkingContext(session).totalTokens
        let usage: TokenUsage | undefined
        let toolCall = false
        let generatedText = false
        let rejected: ShortfallMeasurement | undefined
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = chunk.usage
          else if (isToolCallChunk(chunk)) toolCall = true
          else if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0) generatedText = true
          else if (chunk.type === 'finish' && active) {
            const verdict = assess({ finish: chunk.reason, toolCall, generatedText, usage, toolSchemaTokens, estimateTokens, route })
            if (verdict.kind === 'reject') {
              rejected = verdict
              // Leaving the loop closes the inner stream, so inner listeners never observe a completed stop.
              break
            }
            if (verdict.kind === 'near-miss') {
              ctx.logger.warn(`prompt-usage-guard: kept a reply from provider ${JSON.stringify(route.provider)} model ${JSON.stringify(route.model)} below only the ${verdict.belowToolSchemas ? 'tool-schema' : 'working-estimate'} threshold: ${measurement(verdict)}`)
            }
          }
          yield chunk
        }
        if (rejected === undefined) return
        ctx.logger.warn(`prompt-usage-guard: discarded a reply from provider ${JSON.stringify(route.provider)} model ${JSON.stringify(route.model)}: ${measurement(rejected)}`)
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: PROMPT_USAGE_SHORTFALL,
              message: `The model provider reported ${rejected.reportedPromptTokens} prompt tokens for a request with about `
                + `${rejected.toolSchemaTokens} tokens of tool definitions and about ${rejected.estimateTokens} tokens in total, `
                + 'so it likely received an incomplete request. The reply was discarded.',
            },
          },
        }
      })()
    }, { prepend: true })
    yield () => { active = false }
  }, 'prompt-usage-guard: stop judging replies after disposal')
}
