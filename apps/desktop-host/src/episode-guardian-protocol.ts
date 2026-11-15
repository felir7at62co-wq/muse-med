/** One bounded request, one bounded reply, and early EOF cancellation. */
import type { Readable } from 'node:stream'
import type { ExecutionIdentity, GuardianResult } from './episode-guardian-fence.ts'

/** One physical execution admitted by the Host. */
export interface GuardianRequest {
  readonly version: 1
  readonly kind: 'run'
  readonly identity: ExecutionIdentity
}

/** Result bound to the exact request identity. */
export interface GuardianReply {
  readonly version: 1
  readonly kind: 'result'
  readonly identity: ExecutionIdentity
  readonly result: GuardianResult
}

/** Parser adapters strictly validate all JSON fields and bounded UUID/hash strings. */
export interface GuardianParsers {
  /** Decode one complete request frame.
   * @param value - JSON-decoded worker input.
   * @returns The validated request. */
  parseRequest(this: void, value: unknown): GuardianRequest
  /** Decode one complete reply frame.
   * @param value - JSON-decoded child output.
   * @returns The validated reply. */
  parseReply(this: void, value: unknown): GuardianReply
}

/**
 * Attach this synchronously at plugin apply, before descriptor I/O or gate waits.
 * The listener stays attached after the request; Host pipe EOF cancels media.
 * No appExit is requested until the owning task drains or preserves unknown.
 * @param input - Host-owned stdin pipe.
 * @param maxBytes - Complete request frame byte limit.
 * @param parse - Strict request decoder.
 * @returns The request, lifetime signal and listener disposal.
 */
export function bindGuardianInput(input: Readable, maxBytes: number, parse: (value: unknown) => GuardianRequest): {
  readonly signal: AbortSignal
  readonly request: Promise<GuardianRequest>
  cancel(): void
  dispose(): void
} {
  const controller = new AbortController()
  let pending = Buffer.alloc(0)
  let received = false
  let resolveRequest!: (value: GuardianRequest) => void
  let rejectRequest!: (error: Error) => void
  const request = new Promise<GuardianRequest>((resolve, reject) => {
    resolveRequest = resolve; rejectRequest = reject
  })
  // Attach a rejection consumer before resume; the caller still awaits request.
  void request.catch((_invalidRequest: unknown) => { /* The worker task still awaits request. */ })
  const cancel = (): void => {
    controller.abort()
    if (!received) rejectRequest(new Error('episode guardian: Host disconnected before a request'))
  }
  const fail = (message: string): void => {
    controller.abort(); rejectRequest(new Error(message))
  }
  const onData = (chunk: Buffer): void => {
    if (controller.signal.aborted) return
    if (received) { fail('episode guardian: more than one request'); return }
    if (pending.length + chunk.length > maxBytes) { fail('episode guardian: request exceeds limit'); return }
    pending = Buffer.concat([pending, chunk])
    const newline = pending.indexOf(10)
    if (newline < 0) return
    if (newline !== pending.length - 1) { fail('episode guardian: extra request bytes'); return }
    try {
      const value: unknown = JSON.parse(pending.subarray(0, newline).toString('utf8'))
      const parsed = parse(value)
      received = true; pending = Buffer.alloc(0); resolveRequest(parsed)
    } catch (_invalidRequest) { fail('episode guardian: invalid request') }
  }
  const onError = (): void => { fail('episode guardian: stdin failed') }
  input.once('end', cancel)
  input.once('close', cancel)
  input.once('error', onError)
  input.on('data', onData)
  if (input.readableEnded || input.destroyed) cancel()
  input.resume()
  return { signal: controller.signal, request, cancel, dispose: () => {
    input.off('end', cancel); input.off('close', cancel); input.off('error', onError); input.off('data', onData)
    input.pause()
  } }
}

/**
 * Drain stdout even after a violation, keeping only one capped frame in memory.
 * Invalid/unexpected output never becomes an execution result.
 * @param input - Guardian stdout pipe.
 * @param maxBytes - Complete reply byte limit.
 * @param parse - Strict reply decoder.
 * @returns The single validated reply after normal stream end.
 */
export function collectGuardianReply(input: Readable, maxBytes: number, parse: (value: unknown) => GuardianReply): Promise<GuardianReply> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    let failed = false
    const fail = (): void => {
      failed = true; bytes = Buffer.alloc(0)
      reject(new Error('episode guardian: invalid or oversized reply'))
    }
    input.on('data', (chunk: Buffer) => {
      if (failed) return
      if (bytes.length + chunk.length > maxBytes) { fail(); return }
      bytes = Buffer.concat([bytes, chunk])
    })
    input.once('error', fail)
    input.once('close', () => { if (!input.readableEnded) fail() })
    if (input.destroyed && !input.readableEnded) fail()
    input.once('end', () => {
      if (failed) return
      try {
        const newline = bytes.indexOf(10)
        if (newline < 0 || newline !== bytes.length - 1) { fail(); return }
        const value: unknown = JSON.parse(bytes.subarray(0, newline).toString('utf8'))
        resolve(parse(value))
      } catch (_invalidReply) { fail() }
    })
  })
}

/** Retain a byte-bounded diagnostic tail without line buffering.
 * @param input - Guardian stderr pipe.
 * @param maxBytes - Retained tail byte limit.
 * @returns A reader for the current tail. */
export function collectGuardianDiagnostic(input: Readable, maxBytes: number): () => string {
  let tail = Buffer.alloc(0)
  input.on('data', (chunk: Buffer) => {
    const retained = chunk.length >= maxBytes ? chunk.subarray(chunk.length - maxBytes) : Buffer.concat([tail, chunk])
    tail = Buffer.from(retained.subarray(Math.max(0, retained.length - maxBytes)))
  })
  input.on('error', () => { /* The child close/result reports transport failure. */ })
  return () => tail.toString('utf8')
}
