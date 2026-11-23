/** Fixed Muse model diagnostics exclude supplier-controlled text from durable streams. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'

const messages = {
  AUTH: 'Upstream authentication failed. Please contact the Muse administrator.',
  QUOTA: 'Upstream quota exhausted. Please contact the Muse administrator.',
  RATE_LIMIT: 'Upstream rate limit exceeded. Please retry later.',
  CONTEXT_WINDOW_EXCEEDED: 'Upstream context window exceeded. Please reduce the request context.',
  INVALID_REQUEST: 'Upstream rejected the model request. Please check the model parameters.',
  CONTENT_FILTER: 'Upstream content safety refused this request. Repeating the same request will not resolve the refusal.',
  SERVER: 'Upstream model service failed. Please retry later.',
  TIMEOUT: 'Upstream model request timed out. Please retry later.',
  TRANSPORT: 'Upstream model connection interrupted. Please retry later.',
  STREAM_CLOSED: 'Upstream model stream ended before completion. Please retry later.',
  EMPTY_RESPONSE: 'Upstream model returned no content. Please retry later.',
  INVALID_TOOL_ARGUMENTS: 'Upstream model returned invalid tool arguments. No tool from this reply ran; please retry.',
  MALFORMED_RESPONSE: 'Upstream model returned a malformed response. No tool from this reply ran; please retry.',
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
  MODEL_ACCESS_UNCERTAIN: 'Muse model access could not be confirmed. Please retry later or contact the Muse administrator.',
  MODEL_ACCESS_CHECK_FAILED: 'Muse model access check failed during the request. Check account access before continuing; do not automatically repeat the interrupted request.',
  MODEL_REQUEST_DEADLINE: 'Muse model request reached its access deadline. Check its result before continuing; do not automatically repeat the interrupted request.',
  PI_AI_ERROR: 'Upstream model ended with an unclassified error. Check provider diagnostics before repeating the request.',
  UNKNOWN: 'Muse model request failed. Please retry or contact the Muse administrator.',
} as const

type FixedCode = keyof typeof messages

/**
 * Content-free facts about a failure that the fixed diagnostics report as `UNKNOWN`.
 * Supplier text, reply text, tool arguments, headers and credentials are never included.
 */
export interface UnknownMuseModelFailure {
  /** `thrown` for a value thrown by the adapter stream; `finish` for an in-band error or aborted finish. */
  readonly source: 'thrown' | 'finish'
  /** `name` of a thrown Error, or `typeof` another thrown value; absent for a finish. */
  readonly errorClass?: string
  /** The original code when it is an upper-snake identifier, such as `ECONNRESET` or an unlisted Harness code. */
  readonly code?: string
  /**
   * A thrown value's message: its first line, cut at the first quotation mark because parser and
   * validation messages quote the rejected input, with opaque runs of 24 or more token characters
   * replaced, and at most 160 characters. Absent for a thrown non-Error value and for a finish,
   * whose message is supplier text.
   */
  readonly message?: string
}

const DIAGNOSTIC_MESSAGE_MAX_CHARS = 160
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/u
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u

function fixedCode(code: string): FixedCode {
  return Object.hasOwn(messages, code) ? code as FixedCode : 'UNKNOWN'
}

function safeFailure(failure: LlmFailure, code: FixedCode): LlmFailure {
  return { code, message: messages[code],
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs }),
    ...(code === 'IMAGE_OFFLOAD_REQUIRED' && failure.offloadImages !== undefined ? { offloadImages: failure.offloadImages } : {}),
  }
}

function diagnosticMessage(text: string): string {
  const end = text.search(/[\r\n]/u)
  const line = end === -1 ? text : text.slice(0, end)
  const quote = line.search(/["'`]/u)
  const unquoted = (quote === -1 ? line : `${line.slice(0, quote)}…`).replace(/[A-Za-z0-9+/_=-]{24,}/gu, '…')
  return unquoted.length <= DIAGNOSTIC_MESSAGE_MAX_CHARS ? unquoted : `${unquoted.slice(0, DIAGNOSTIC_MESSAGE_MAX_CHARS - 1)}…`
}

function knownCode(value: unknown): { code: string } | Record<string, never> {
  return typeof value === 'string' && CODE.test(value) ? { code: value } : {}
}

function thrownFailure(error: unknown): UnknownMuseModelFailure {
  if (!(error instanceof Error)) return { source: 'thrown', errorClass: typeof error }
  const code: unknown = Reflect.get(error, 'code')
  return { source: 'thrown', errorClass: IDENTIFIER.test(error.name) ? error.name : 'Error',
    ...knownCode(code), message: diagnosticMessage(error.message) }
}

function notify(report: (failure: UnknownMuseModelFailure) => void, describe: () => UnknownMuseModelFailure): void {
  // Description reads thrown-value properties; neither it nor the sink may replace the model outcome.
  try { report(describe()) }
  catch (_diagnosticFailure) { /* The fixed UNKNOWN failure is still delivered to the caller. */ }
}

/**
 * Keep model output intact while replacing failed and cancelled supplier diagnostics.
 * @param source - Deferred stream creation, including synchronous adapter failures.
 * @param report - Receives content-free facts each time a failure becomes `UNKNOWN`; its own failure is ignored.
 * @returns Stream with fixed error text and routing facts; thrown failures carry no upstream cause or request ID.
 */
export async function* safeMuseModelStream(
  source: () => AsyncIterable<StreamChunk>,
  report: (failure: UnknownMuseModelFailure) => void,
): AsyncGenerator<StreamChunk> {
  try {
    for await (const chunk of source()) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        const original = chunk.reason.failure.code
        const code = fixedCode(original)
        if (code === 'UNKNOWN') notify(report, () => ({ source: 'finish', ...knownCode(original) }))
        yield { ...chunk, reason: { ...chunk.reason, failure: safeFailure(chunk.reason.failure, code) } }
      } else yield chunk
    }
  } catch (error) {
    const failure: LlmFailure = error instanceof LlmError ? error.failure : { code: 'UNKNOWN', message: '' }
    const code = fixedCode(failure.code)
    if (code === 'UNKNOWN') notify(report, () => thrownFailure(error))
    throw LlmError.fromFailure(safeFailure(failure, code))
  }
}
