/**
 * Chat Completions transport completion, independent of HTTP connection closure.
 * @module dsh-llm-pi-ai/completions-response
 */

/** Recognizes one complete SSE data event without buffering provider payloads. */
class DoneEventScanner {
  private line = ''
  private firstLine = true
  private skipLineFeed = false
  private dataIsDone: boolean | undefined

  /** Return the byte offset after a complete terminal event, if present. */
  scan(bytes: Uint8Array): number | undefined {
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]
      if (this.skipLineFeed && byte === 10) {
        this.skipLineFeed = false
        continue
      }
      this.skipLineFeed = byte === 13
      if (byte !== 10 && byte !== 13) {
        // Only the sentinel prefix matters; ordinary JSON lines can be arbitrarily long.
        // Three extra bytes accommodate a UTF-8 BOM on the first line.
        if (this.line.length < 16) this.line += String.fromCharCode(byte!)
        continue
      }
      const line = this.firstLine ? this.line.replace(/^\xEF\xBB\xBF/, '') : this.line
      this.firstLine = false
      this.line = ''
      if (line === '') {
        if (this.dataIsDone === true) {
          return index + (byte === 13 && bytes[index + 1] === 10 ? 2 : 1)
        }
        this.dataIsDone = undefined
      } else if (line === 'data' || line.startsWith('data:')) {
        // Multiple data fields join with a newline, so none can be an exact [DONE].
        this.dataIsDone = this.dataIsDone === undefined
          && (line === 'data: [DONE]' || line === 'data:[DONE]')
      }
    }
    return undefined
  }
}

/**
 * Close a successful Chat Completions SSE body at its complete `[DONE]` event.
 * Bytes through that event, response status, and headers are preserved. Finishing
 * the transform cancels the upstream body without aborting the SDK's request signal.
 * Non-SSE and unsuccessful responses pass through unchanged.
 * @param response - Provider response owned by the current model request.
 * @returns A response whose body ends at protocol completion or the original EOF.
 */
export function completeCompletionsResponse(response: Response): Response {
  if (!response.ok || response.body === null
    || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream') {
    return response
  }
  const scanner = new DoneEventScanner()
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      const end = scanner.scan(bytes)
      controller.enqueue(end === undefined ? bytes : bytes.subarray(0, end))
      if (end !== undefined) controller.terminate()
    },
  }))
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
