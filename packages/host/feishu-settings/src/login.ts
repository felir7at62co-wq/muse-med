/**
 * QR app registration behind one scannable ticket.
 *
 * One flow owns at most one pending scan: starting a new one withdraws the
 * previous, and every failure is reduced to a stable code, because a platform
 * diagnostic could quote request material and this section stores a secret.
 *
 * @module @deepseek-ai/dsh-feishu-settings/login
 */

import { registerApp, type QRCodeInfo, type RegisterAppOptions, type RegisterAppResult } from '@larksuite/channel'
import { qrSvgDataUrl } from './qr.ts'
import type { FeishuLoginTicket } from './types.ts'

/** Caller tag carried on the QR URL, so the platform attributes the app. */
const REGISTRATION_SOURCE = 'muse-med'

/** App-creation page pre-fill; the platform's base template already grants what the bot needs. */
const REGISTRATION_PRESET = { name: 'muse-med', desc: 'muse-med 桌面助手' } as const

/** How long the flow waits for the platform to report a URL. */
const DEFAULT_QR_TIMEOUT_MS = 20_000

/** Registration request the platform's call accepts. */
export type RegisterAppRequest = RegisterAppOptions

/** What a completed scan yields, and the URL report that precedes it. */
export type { QRCodeInfo, RegisterAppResult }

/** The registration call; tests substitute a fake, so no request leaves the process. */
export type RegisterAppPort = (request: RegisterAppRequest) => Promise<RegisterAppResult>

/** The official call, re-exported by `@larksuite/channel` from the platform SDK. */
export const officialRegisterApp: RegisterAppPort = request => registerApp(request)

/** One completed scan. */
export interface FeishuRegistration {
  /** Registered app id. */
  readonly appId: string
  /** Registered app secret. */
  readonly appSecret: string
  /** Open id of the user who scanned, when the platform reported one. */
  readonly registeredBy?: string
}

/** A scan failure reduced to its stable code. */
export class FeishuLoginError extends Error {
  /**
   * @param code - stable failure code; never platform text.
   */
  constructor(readonly code: string) {
    super(code)
    this.name = 'FeishuLoginError'
  }
}

/** Callbacks and timing of one login flow. */
export interface FeishuLoginOptions {
  /** Registration call, official in production and a fake in tests. */
  readonly register: RegisterAppPort
  /** Writes the credentials a completed scan produced. */
  readonly onRegistered: (registration: FeishuRegistration) => Promise<void>
  /** Records a failure code for the page. */
  readonly onFailed?: (code: string) => void
  /** How long to wait for the URL before giving up. */
  readonly qrTimeoutMs?: number
}

/** One pending scan, and the wire that withdraws it. */
interface PendingLogin {
  readonly controller: AbortController
  ticket?: FeishuLoginTicket
}

/**
 * Narrow any thrown value to a bounded code.
 * @param error - whatever the platform call threw.
 * @returns a short code, or `registration-failed` for anything unbounded.
 */
function codeOf(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(code) ? code : 'registration-failed'
}

/** The live QR registration session of one plugin row. */
export class FeishuLoginFlow {
  #pending: PendingLogin | undefined
  #failure: string | undefined

  /**
   * @param options - registration call, credential sink, and timing.
   */
  constructor(private readonly options: FeishuLoginOptions) {}

  /** The ticket a page should show, when a scan is waiting. */
  get ticket(): FeishuLoginTicket | undefined {
    return this.#pending?.ticket
  }

  /** Stable code of the last failure, cleared by the next {@link begin}. */
  get failure(): string | undefined {
    return this.#failure
  }

  /**
   * Start one scan, withdrawing any pending one first.
   * @param appId - existing app to authorize instead of creating one.
   * @returns the ticket to show, once the platform reported its URL.
   * @throws FeishuLoginError when no URL arrives in time or the call fails first.
   */
  async begin(appId?: string): Promise<FeishuLoginTicket> {
    this.cancel()
    this.#failure = undefined
    const entry: PendingLogin = { controller: new AbortController() }
    this.#pending = entry
    let settle: (ticket: FeishuLoginTicket) => void = () => {}
    let fail: (error: Error) => void = () => {}
    const ready = new Promise<FeishuLoginTicket>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    const call = this.options.register({
      source: REGISTRATION_SOURCE,
      ...(appId === undefined || appId.length === 0 ? {} : { appId }),
      appPreset: REGISTRATION_PRESET,
      signal: entry.controller.signal,
      onQRCodeReady: (info) => {
        const ticket: FeishuLoginTicket = {
          url: info.url,
          qrDataUrl: qrSvgDataUrl(info.url),
          expiresInSeconds: info.expireIn,
        }
        entry.ticket = ticket
        settle(ticket)
      },
    })
    void this.#settle(call, entry, fail)
    const timer = setTimeout(() => fail(new FeishuLoginError('no-qr')), this.options.qrTimeoutMs ?? DEFAULT_QR_TIMEOUT_MS)
    try {
      return await ready
    } catch (error) {
      this.#withdraw(entry)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** Withdraw the pending scan, if any. */
  cancel(): void {
    const pending = this.#pending
    if (pending === undefined) return
    this.#pending = undefined
    pending.controller.abort()
  }

  /**
   * Finish one registration call off the request path.
   * @param call - the platform call this flow started.
   * @param entry - the pending scan that call belongs to.
   * @param failRequest - answers a {@link begin} that is still waiting for a ticket.
   */
  async #settle(
    call: Promise<RegisterAppResult>,
    entry: PendingLogin,
    failRequest: (error: Error) => void,
  ): Promise<void> {
    try {
      const result = await call
      if (this.#pending !== entry) return
      this.#pending = undefined
      await this.options.onRegistered({
        appId: result.client_id,
        appSecret: result.client_secret,
        ...(result.user_info?.open_id === undefined ? {} : { registeredBy: result.user_info.open_id }),
      })
    } catch (error) {
      if (this.#pending !== entry) return
      this.#pending = undefined
      const code = codeOf(error)
      this.#failure = code
      this.options.onFailed?.(code)
      // A scan that never showed a ticket fails its own `begin`; one that did
      // only records the code, because the page already holds the URL.
      if (entry.ticket === undefined) failRequest(new FeishuLoginError(code))
    }
  }

  /**
   * Withdraw one specific scan without touching a newer one.
   * @param entry - the pending scan to withdraw.
   */
  #withdraw(entry: PendingLogin): void {
    if (this.#pending === entry) this.#pending = undefined
    entry.controller.abort()
  }
}
