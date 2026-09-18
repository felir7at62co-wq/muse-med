/**
 * The five stable failure codes every Jubian call can produce.
 *
 * No provider message, provider body or nested transport cause ever reaches a
 * caller: a tool renders these codes, so a remote error text can never be
 * echoed into a model's context or a log.
 */

/** Stable failure categories shared by every Jubian reader. */
export type JubianErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'CONTRACT_CHANGED'
  | 'NETWORK_ERROR'

const MESSAGES: Record<JubianErrorCode, string> = {
  AUTHENTICATION_REQUIRED: 'Jubian login is unavailable or expired',
  PERMISSION_DENIED: 'Jubian account cannot access this resource',
  RATE_LIMITED: 'Jubian rate limit reached',
  CONTRACT_CHANGED: 'Jubian response did not match the expected envelope',
  NETWORK_ERROR: 'Jubian request failed',
}

/** One Jubian failure, carrying only its stable code. */
export class JubianError extends Error {
  /** Stable category for callers and tool output. */
  readonly code: JubianErrorCode

  /**
   * @param code - Stable failure category.
   */
  constructor(code: JubianErrorCode) {
    super(MESSAGES[code])
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
