/**
 * The one place a reader's rejection gains the structure of the payload it refused.
 *
 * A reader answers `CONTRACT_CHANGED` when the payload it was handed is not the
 * one it promised to read. On its own that sentence names no field and no
 * structure, so an operator sees the same message for a wrong endpoint, a changed
 * remote layout and a caller mistake, and has nothing to act on until they find
 * the opt-in capture switch. Every reader therefore runs its body through
 * {@link readPayload}, which attaches the redacted summary the transport layer
 * also rejects through, so the two layers cannot describe one body differently.
 *
 * A rejection that states its own detail keeps it, with the summary appended once.
 * The detail is the reader's own conclusion ("no catalogue row matches these
 * settings") and the summary is what actually arrived; a diagnosis needs both.
 *
 * @module @deepseek-ai/dsh-jubian-api/reading
 */

import { JubianError, describeRejection, namesCaptureSwitch } from '@deepseek-ai/dsh-jubian'

/**
 * Run one reader over one payload, attaching the reader's name and the payload's
 * redacted structure to any rejection.
 *
 * Only `CONTRACT_CHANGED` is rewritten: every other code already states a cause a
 * payload description would obscure. A detail that already names the capture
 * switch is kept as it stands, so a reader wrapped more than once — directly, or
 * by a reader that calls another — summarises one payload one time.
 * @param reader - The reader's own name, so one message distinguishes which of the endpoint reads failed.
 * @param data - The payload the reader was handed; described only if the reader rejects it.
 * @param read - The reader body, run unchanged.
 * @returns Whatever the reader returned.
 * @throws {JubianError} The reader's own error, a `CONTRACT_CHANGED` detail naming the reader and the summary.
 */
export function readPayload<T>(reader: string, data: unknown, read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (!(error instanceof JubianError) || error.code !== 'CONTRACT_CHANGED') throw error
    if (error.detail !== undefined && namesCaptureSwitch(error.detail)) throw error
    const summary = `${reader} could not read this payload: ${describeRejection(data)}`
    throw new JubianError('CONTRACT_CHANGED',
      error.detail === undefined ? summary : `${error.detail}. ${summary}`)
  }
}
