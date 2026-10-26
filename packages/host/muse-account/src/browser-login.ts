/** Browser-approved Desktop login. Redemption secrets stay in the Host until completion or cancellation. */
import { MuseGatewayError, createMuseAccountGateway, museGatewayOrigin } from './gateway.ts'
import { writeMuseSession } from './session.ts'
import type { MuseBrowserLoginAttempt, MuseBrowserLoginId, MuseBrowserLoginResult } from './types.ts'

interface PendingLogin {
  readonly attempt: MuseBrowserLoginAttempt
  readonly secret: string
}

/** Product origin, private storage and bounded account-request lifetime. */
export interface MuseBrowserLoginOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
}

/** One Host-owned attempt; serialization prevents a cancelled or older login from replacing a later login. */
export class MuseBrowserLogin {
  private pending: PendingLogin | undefined
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private readonly origin: string

  constructor(private readonly options: MuseBrowserLoginOptions) {
    this.origin = museGatewayOrigin(options.baseUrl)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async post(action: string, fields: Record<string, string>): Promise<Response> {
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(new URL('/api/desktop-login/' + action, this.origin), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        headers: { origin: this.origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
      })
    } catch {
      throw new MuseGatewayError('gateway-unavailable')
    }
    if (response.status === 429) throw new MuseGatewayError('rate-limited')
    if (response.status !== 410 && !response.ok) throw new MuseGatewayError('gateway-rejected')
    return response
  }

  /**
   * Start or reopen this Host's current browser approval.
   * @returns Exact Muse approval or Feishu entry URL, matching code, expiry and polling interval; never the redemption secret.
   */
  start(): Promise<MuseBrowserLoginAttempt> {
    return this.serial(async () => {
      if (this.closed) throw new MuseGatewayError('gateway-unavailable')
      if (this.pending !== undefined && this.pending.attempt.expiresAt > Date.now()) return this.pending.attempt
      const response = await this.post('start', { provider: 'feishu' })
      let value: unknown
      try { value = await response.json() } catch { throw new MuseGatewayError('gateway-rejected') }
      if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/u.test(value.id) || !('secret' in value) || typeof value.secret !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/u.test(value.secret) || !('code' in value) || typeof value.code !== 'string'
        || !/^[A-F0-9]{8}$/u.test(value.code) || !('expiresAt' in value) || typeof value.expiresAt !== 'number'
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()
        || !('pollIntervalMs' in value) || typeof value.pollIntervalMs !== 'number'
        || !Number.isSafeInteger(value.pollIntervalMs) || value.pollIntervalMs < 1000 || value.pollIntervalMs > 60_000
        || !('authorizeUrl' in value) || (value.authorizeUrl !== this.origin + '/desktop-login?attempt=' + value.id
          && value.authorizeUrl !== this.origin + '/auth/feishu/start?desktop_login=' + value.id)) {
        throw new MuseGatewayError('gateway-rejected')
      }
      const attempt: MuseBrowserLoginAttempt = {
        id: value.id as MuseBrowserLoginId, authorizeUrl: value.authorizeUrl, code: value.code,
        expiresAt: value.expiresAt, pollIntervalMs: value.pollIntervalMs,
      }
      this.pending = { attempt, secret: value.secret }
      return attempt
    })
  }

  /**
   * Check one approval and persist its separately issued Desktop session after gateway verification.
   * @param id - The exact attempt returned by start.
   * @returns Pending or terminal state; a signed-in result contains identity only.
   */
  check(id: MuseBrowserLoginId): Promise<MuseBrowserLoginResult> {
    return this.serial(async () => {
      const pending = this.pending
      if (this.closed || pending === undefined || pending.attempt.id !== id) return { state: 'expired' }
      const response = await this.post('check', { id, secret: pending.secret })
      if (response.status === 410) { this.pending = undefined; return { state: 'expired' } }
      let value: unknown
      try { value = await response.json() } catch { throw new MuseGatewayError('gateway-rejected') }
      if (typeof value !== 'object' || value === null || !('state' in value)) throw new MuseGatewayError('gateway-rejected')
      if (value.state === 'pending') return { state: 'pending' }
      this.pending = undefined
      if (value.state === 'cancelled') return { state: 'cancelled' }
      if (value.state !== 'signed-in') throw new MuseGatewayError('gateway-rejected')
      const cookie = response.headers.getSetCookie().find(header => header.startsWith('__Host-muse='))?.split(';', 1)[0]
      if (cookie === undefined || !/^__Host-muse=[A-Za-z0-9_-]+$/u.test(cookie)) throw new MuseGatewayError('gateway-rejected')
      const gateway = createMuseAccountGateway(this.origin, this.options.requestTimeoutMs, this.options.fetcher)
      const identity = await gateway.identity(cookie)
      try {
        await writeMuseSession(this.options.sessionFile, {
          username: identity.username,
          ...(identity.environment === undefined ? {} : { environment: identity.environment }),
          ...(identity.workspaceLabel === undefined ? {} : { workspaceLabel: identity.workspaceLabel }),
          cookie, baseUrl: this.origin,
        })
      } catch (error) {
        await gateway.signOut(cookie).catch(() => undefined)
        throw error
      }
      return { state: 'signed-in', status: { state: 'signed-in', verified: true, ...identity } }
    })
  }

  /**
   * Forget an unredeemed attempt. An already-running commit settles before cancellation returns.
   * @param id - Optional exact attempt; omission cancels whichever attempt this Host owns.
   */
  cancel(id?: MuseBrowserLoginId): Promise<void> {
    return this.serial(async () => {
      const pending = this.pending
      if (pending === undefined || (id !== undefined && pending.attempt.id !== id)) return
      this.pending = undefined
      try { await this.post('cancel', { id: pending.attempt.id, secret: pending.secret }) }
      catch (_error) { /* The secret is discarded locally; an unavailable gateway expires its unredeemed attempt. */ }
    })
  }

  /** Stop new attempts and collect outstanding requests before plugin disposal completes. */
  async dispose(): Promise<void> {
    this.closed = true
    await this.cancel()
  }
}
