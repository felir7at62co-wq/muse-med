/**
 * Stop one agent-loop response when a streamed JSON object repeats one member
 * name beyond the deployment's explicit limit. This is a local stream failure,
 * not a provider error or a request to recover or replay tools.
 * @module @deepseek-ai/dsh-argument-loop
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAgentLoopRequest, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ArgumentLoopDetector } from './detector.ts'

/** Stable local failure code retained by the existing turn/error contract. */
export const TOOL_ARGUMENT_LOOP = 'TOOL_ARGUMENT_LOOP'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-argument-loop'

/** Activate only with the LLM stream service whose middleware this owns. */
export const inject = ['llm']

/** Deployment policy; the package deliberately supplies no global threshold. */
export interface Config {
  /** Occurrences of one decoded member name within one JSON object that stop a response. */
  repeatedPropertyLimit: number
}

/** Require an explicit threshold in the mounting composition. */
export const Config: z<Config> = z.object({
  repeatedPropertyLimit: z.number().required(),
})

/** One request's detector state; separate tool-call indexes never share keys. */
class ResponseDetector {
  private readonly pending = new Map<number, ArgumentLoopDetector>()
  private readonly closed = new Set<number>()

  constructor(private readonly limit: number) {}

  /** Match canonical first-block-end behavior without counting full arguments twice. */
  observe(chunk: StreamChunk): boolean {
    if (chunk.type === 'tool-call-delta' && !this.closed.has(chunk.index)) {
      let detector = this.pending.get(chunk.index)
      if (detector === undefined) {
        detector = new ArgumentLoopDetector(this.limit)
        this.pending.set(chunk.index, detector)
      }
      return detector.push(chunk.argumentsDelta) !== undefined
    }
    if (chunk.type !== 'block-end' || this.closed.has(chunk.index)) return false
    this.closed.add(chunk.index)
    this.pending.delete(chunk.index)
    // Block-end-only adapters and authoritative full arguments are checked as
    // their own complete prefix, not appended again to accumulated deltas.
    return chunk.block.type === 'tool-call'
      && new ArgumentLoopDetector(this.limit).push(chunk.block.arguments) !== undefined
  }
}

/**
 * Install a request-local stream guard; the consumer owns upstream cancellation
 * and iterator cleanup. No detached work, tool dispatch, or recovery is created.
 * @param ctx - plugin context; disposal removes the middleware registration.
 * @param config - explicit deployment threshold, validated before any request.
 */
export function apply(ctx: Context, config: Config): void {
  const limit = config.repeatedPropertyLimit
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new Error('tool-argument-loop: repeatedPropertyLimit must be an explicit safe integer >= 2')
  }
  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options)) return next()
    return (async function* (): AsyncIterable<StreamChunk> {
      const detector = new ResponseDetector(limit)
      for await (const chunk of next()) {
        const repeated = detector.observe(chunk)
        // Preserve the exact received triggering chunk in assistant/attempt.
        // The loop cannot dispatch tools until the response settles normally.
        yield chunk
        if (repeated) {
          // Throw outside provider finish/error retry semantics: even an
          // explicit provider retryPolicy=always must not replay this response.
          throw new LlmError(
            `Tool arguments repeated one JSON member ${limit} times in the same object. `
            + 'The incomplete response was stopped; earlier completed work is retained. '
            + 'No tool from this response was executed and no automatic recovery was requested.',
            TOOL_ARGUMENT_LOOP,
          )
        }
      }
    })()
  }, { prepend: true })
}
