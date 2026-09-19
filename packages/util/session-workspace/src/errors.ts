/**
 * The error vocabulary plugins share at their boundaries.
 *
 * A code plus a sentence, never a bare `Error`: every caller decides from the code, and the operator reads
 * the sentence. Keeping this in one dependency-free module is what lets a session-awareness helper and a
 * product's domain layer agree on the same vocabulary without either importing the other.
 */

/** Stable failure with a machine-readable code; the message is for the operator, not for branching. */
export class DomainRecordError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'IDENTITY_CONFLICT'
    | 'EXTERNAL_MODIFIED' | 'OUTSIDE_WORKSPACE' | 'UNSUPPORTED_IN_V1' | 'DEPENDENCY_MISSING',
  message: string, readonly currentRevision?: number) {
    super(`${code}: ${message}`)
    this.name = 'DomainRecordError'
  }
}

/**
 * Describe an unrecognised failure without hiding its cause.
 * A masked cause sends the operator after the wrong defect, so the class and a bounded message travel with
 * the fallback sentence.
 * @param error - The caught value.
 * @param fallbackMessage - The owning domain's sentence naming what it could not do.
 * @returns The message to publish.
 */
export function unknownFailureMessage(error: unknown, fallbackMessage: string): string {
  const name = error instanceof Error ? error.name : typeof error
  const detail = error instanceof Error ? error.message : String(error)
  return `${fallbackMessage} [${name}: ${detail.slice(0, 300)}]`
}
