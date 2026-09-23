/**
 * The stable failure codes every Jubian call can produce.
 *
 * No provider message, provider body or nested transport cause ever reaches a
 * caller: a tool renders these codes, so a remote error text can never be
 * echoed into a model's context or a log. `INVALID_ARGUMENT` is the one code a
 * caller can act on without a network round trip, so it carries the argument
 * name the caller has to supply — a name this package owns, never remote text.
 */

/** Stable failure categories shared by every Jubian reader. */
export type JubianErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'CONTRACT_CHANGED'
  | 'INVALID_ARGUMENT'
  | 'NETWORK_ERROR'
  | 'BUDGET_EXCEEDED'

const MESSAGES: Record<JubianErrorCode, string> = {
  AUTHENTICATION_REQUIRED: 'Jubian login is unavailable or expired',
  PERMISSION_DENIED: 'Jubian account cannot access this resource',
  RATE_LIMITED: 'Jubian rate limit reached',
  CONTRACT_CHANGED: 'Jubian response did not match the expected envelope',
  INVALID_ARGUMENT: 'Jubian tool call is missing an argument it cannot run without',
  NETWORK_ERROR: 'Jubian request failed',
  BUDGET_EXCEEDED: 'Jubian spend is not covered by the authorization this deployment holds',
}

/** One Jubian failure with a stable code and a local message, optionally including package-authored detail. */
export class JubianError extends Error {
  /** Stable category for callers and tool output. */
  readonly code: JubianErrorCode

  /**
   * @param code - Stable failure category.
   * @param detail - Optional caller-facing detail this package authored, such as the name of a missing
   *   argument. Provider text must never be passed here: a remote message would then reach a model's
   *   context through the error, which is exactly what the codes exist to prevent.
   */
  constructor(code: JubianErrorCode, detail?: string) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]}: ${detail}`)
    this.name = 'JubianError'
    this.code = code
  }
}

/**
 * Translate an HTTP status into the stable code for it.
 *
 * Both 401 and 403 mean "this token cannot be used": the product had two
 * historical behaviours here and this package settles on the stricter one, so a
 * caller never has to tell an expired token from a forbidden one.
 * @param status - Response status.
 * @returns The stable code for a non-2xx response.
 */
export function codeForHttpStatus(status: number): JubianErrorCode {
  if (status === 401 || status === 403) return 'AUTHENTICATION_REQUIRED'
  if (status === 429) return 'RATE_LIMITED'
  return 'NETWORK_ERROR'
}

/**
 * Translate an application envelope `code` into a failure, or null when it is a success code.
 *
 * `PERMISSION_DENIED` exists only here, behind an HTTP 2xx: an application-level
 * refusal is a different fact from a transport-level one, and the transport
 * layer above already claims every HTTP 403.
 * @param code - Numeric `code` field of a parsed envelope.
 * @returns The stable code, or null for the two success codes.
 */
export function failureForEnvelopeCode(code: number): JubianErrorCode | null {
  if (code === 0 || code === 200) return null
  if (code === 401) return 'AUTHENTICATION_REQUIRED'
  if (code === 403) return 'PERMISSION_DENIED'
  if (code === 429) return 'RATE_LIMITED'
  return 'CONTRACT_CHANGED'
}
