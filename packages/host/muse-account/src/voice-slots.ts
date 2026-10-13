/** Host-only shared voice registration requests using the current Muse session. */
import { readMuseSession } from './session.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque reservation identity issued only by the shared registration server. */
export type MuseVoiceLeaseId = Branded<'MuseVoiceLeaseId'>

/** One original registration operation against a project/person/life-period slot. */
export interface MuseVoiceSlotRequest {
  readonly action: 'acquire' | 'start' | 'complete' | 'abandon' | 'read'
  readonly script_id: number
  readonly character_id: string
  readonly voice_period_id: string
  readonly operation_key: string
  readonly lease_id?: MuseVoiceLeaseId
  readonly asset_id?: number
}

/** Fixed client failures never contain credentials, provider text or request data. */
export class MuseVoiceSlotError extends Error {
  /** @param code - Local failure category suitable for tool diagnostics. */
  constructor(readonly code: 'sign-in-required' | 'account-changed' | 'network' | 'unavailable' | 'not-configured' | 'rejected' | 'response-invalid') {
    super(`Muse voice registration coordination: ${code}`)
  }
}

/** Product-home account settings; voice requests use the configured account timeout. */
export interface MuseVoiceSlotsOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
}

// The shared-slot wire protocol carries one bounded record, never an inventory or media bytes.
const MAX_REPLY_BYTES = 16 * 1024

async function readReply(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new MuseVoiceSlotError('response-invalid')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_REPLY_BYTES) throw new MuseVoiceSlotError('response-invalid')
      chunks.push(chunk.value)
    }
  } catch (error) {
    try { await reader.cancel() }
    catch (_error) { /* A disconnected stream can reject cancellation; retain the read failure. */ }
    throw error instanceof MuseVoiceSlotError ? error : new MuseVoiceSlotError('network')
  } finally { reader.releaseLock() }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) }
  catch (_error) { throw new MuseVoiceSlotError('response-invalid') }
}

/** Private transport only; the requesting tool validates the server's returned slot fields. */
export class MuseVoiceSlotsClient {
  /** @param options - Current origin, private session location and request deadline. */
  constructor(private readonly options: MuseVoiceSlotsOptions) {}

  /**
   * Perform one coordination request without redirects, retries or credential exposure.
   * @param request - Original operation and exact project/person/period identifiers.
   * @param jubianToken - Private provider token used by the server to verify project access.
   * @returns Parsed wire data for the consumer to validate; no raw response text escapes.
   */
  async request(request: MuseVoiceSlotRequest, jubianToken: string): Promise<unknown> {
    const session = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    if (session === null) throw new MuseVoiceSlotError('sign-in-required')
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(new URL('/api/jubian/voice-slots', this.options.baseUrl), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        headers: { cookie: session.cookie, origin: this.options.baseUrl, 'x-jubian-token': jubianToken,
          'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(request),
      })
    } catch (_error) { throw new MuseVoiceSlotError('network') }
    try {
      if (response.status === 303 || response.status === 401) throw new MuseVoiceSlotError('sign-in-required')
      if ([404, 405].includes(response.status)) throw new MuseVoiceSlotError('not-configured')
      if (response.status === 503) throw new MuseVoiceSlotError('unavailable')
      if (!response.ok) throw new MuseVoiceSlotError('rejected')
      const value = await readReply(response)
      const current = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
      if (current?.revision !== session.revision) throw new MuseVoiceSlotError('account-changed')
      return value
    } finally {
      if (!response.bodyUsed) {
        try { await response.body?.cancel() }
        catch (_error) { /* Unread rejected bodies may disconnect; retain the bounded request failure. */ }
      }
    }
  }
}
