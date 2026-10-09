/** Fixed Muse model diagnostics exclude supplier-controlled text from durable streams. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'

const messages = {
  AUTH: 'Upstream authentication failed. Please contact the Muse administrator.',
  QUOTA: 'Upstream quota exhausted. Please contact the Muse administrator.',
  RATE_LIMIT: 'Upstream rate limit exceeded. Please retry later.',
  CONTEXT_WINDOW_EXCEEDED: 'Upstream context window exceeded. Please reduce the request context.',
  INVALID_REQUEST: 'Upstream rejected the model request. Please check the model parameters.',
  SERVER: 'Upstream model service failed. Please retry later.',
  TIMEOUT: 'Upstream model request timed out. Please retry later.',
  TRANSPORT: 'Upstream model connection interrupted. Please retry later.',
  STREAM_CLOSED: 'Upstream model stream ended before completion. Please retry later.',
  EMPTY_RESPONSE: 'Upstream model returned no content. Please retry later.',
  ABORTED: 'Muse model request cancelled.',
  MISSING_CREDENTIAL: 'Please sign in to Muse and refresh the model list.',
  INVALID_CREDENTIAL: 'Muse model credential is invalid. Please contact the administrator.',
  INVALID_CONFIG: 'Muse model configuration is invalid. Please check the model settings.',
  UNKNOWN_MODEL: 'Muse model is unavailable. Please refresh the model list.',
  NO_ADAPTER: 'Muse model provider is unavailable. Please refresh the model list.',
  UNSUPPORTED_OPTION: 'Muse model does not support a requested option.',
  UNSUPPORTED_CONTENT: 'Muse model does not support the supplied content.',
  INVALID_REPLAY_STATE: 'Muse model history cannot be replayed. Please select a compatible model.',
  IMAGE_OFFLOAD_REQUIRED: 'Muse model request requires image offloading.',
  PI_AI_ERROR: 'Upstream model request failed. Please retry or contact the Muse administrator.',
  UNKNOWN: 'Muse model request failed. Please retry or contact the Muse administrator.',
} as const

function safeFailure(failure: LlmFailure): LlmFailure {
  const code = Object.hasOwn(messages, failure.code) ? failure.code as keyof typeof messages : 'UNKNOWN'
  return { code, message: messages[code],
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs }),
    ...(code === 'IMAGE_OFFLOAD_REQUIRED' && failure.offloadImages !== undefined ? { offloadImages: failure.offloadImages } : {}),
  }
}

/**
 * Keep model output intact while replacing failed and cancelled supplier diagnostics.
 * @param source - Deferred stream creation, including synchronous adapter failures.
 * @returns Stream with fixed error text and routing facts; thrown failures carry no upstream cause or request ID.
 */
export async function* safeMuseModelStream(source: () => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
  try {
    for await (const chunk of source()) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        yield { ...chunk, reason: { ...chunk.reason, failure: safeFailure(chunk.reason.failure) } }
      } else yield chunk
    }
  } catch (error) {
    const failure = safeFailure(error instanceof LlmError ? error.failure : { code: 'UNKNOWN', message: '' })
    throw new LlmError(failure.message, failure.code, failure)
  }
}
