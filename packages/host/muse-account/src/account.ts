/** Account operations shared by the Desktop Remote service and status-only MCP child. */

import { clearMuseSessionIfUnchanged, readMuseSession, writeMuseSession } from './session.ts'
import { MuseGatewayError, type MuseAccountGateway, type MuseAccountIdentity } from './gateway.ts'
import type { MuseAccountLoginRequest, MuseAccountLoginResult, MuseAccountStatus, MuseAccountStatusRequest } from './types.ts'

/** Invalid credential fields supplied over the authenticated Remote request. */
export class MuseAccountInputError extends Error {
  /** Stable code returned to the Settings client for invalid fields. */
  readonly code = 'invalid-input'

  constructor() {
    super('MUSE account login fields are invalid')
  }
}

/** Dependencies resolved by the product, without a password or cookie in config. */
export interface MuseAccountControllerOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly gateway: MuseAccountGateway
}

/** One signed-in status projected from a confirmed or locally stored identity. */
function signedIn(identity: MuseAccountIdentity, verified: boolean): Extract<MuseAccountStatus, { readonly state: 'signed-in' }> {
  return {
    state: 'signed-in',
    username: identity.username,
    verified,
    ...(identity.environment === undefined ? {} : { environment: identity.environment }),
    ...(identity.workspaceLabel === undefined ? {} : { workspaceLabel: identity.workspaceLabel }),
  }
}

/** Product-home MUSE account controller. No method returns a password or cookie. */
export class MuseAccountController {
  constructor(private readonly options: MuseAccountControllerOptions) {}

  /**
   * Read local identity or verify the saved cookie with the gateway.
   * @param request - Whether to make a network request.
   * @returns Account identity, or signed-out after absence or a confirmed rejection.
   */
  async status(request: MuseAccountStatusRequest = {}): Promise<MuseAccountStatus> {
    const stored = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    if (stored === null) return { state: 'signed-out' }
    if (request.verify !== true) return signedIn(stored, false)
    try {
      const identity = await this.options.gateway.identity(stored.cookie)
      const current = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
      return current?.revision === stored.revision ? signedIn(identity, true) : await this.status()
    } catch (error) {
      if (error instanceof MuseGatewayError && error.code === 'invalid-credentials') {
        await clearMuseSessionIfUnchanged(this.options.sessionFile, stored)
        return await this.status()
      }
      throw error
    }
  }

  /**
   * Sign in and, only on explicit request, register an unknown username.
   * @param request - UI-submitted username, password and registration choice.
   * @returns Confirmed identity and which action succeeded.
   */
  async login(request: MuseAccountLoginRequest): Promise<MuseAccountLoginResult> {
    if (typeof request?.username !== 'string' || typeof request.password !== 'string'
      || typeof request.registerIfMissing !== 'boolean'
      || request.username.length < 2 || request.username.length > 32
      || request.password.length < 1 || request.password.length > 128) {
      throw new MuseAccountInputError()
    }
    let cookie: string
    let outcome: MuseAccountLoginResult['outcome'] = 'signed-in'
    try {
      cookie = await this.options.gateway.signIn(request.username, request.password)
    } catch (error) {
      if (!(error instanceof MuseGatewayError) || error.code !== 'invalid-credentials' || !request.registerIfMissing) throw error
      try {
        cookie = await this.options.gateway.register(request.username, request.password)
        outcome = 'registered'
      } catch (registrationError) {
        if (registrationError instanceof MuseGatewayError && registrationError.code === 'username-taken') throw error
        throw registrationError
      }
    }
    const identity = await this.options.gateway.identity(cookie)
    await writeMuseSession(this.options.sessionFile, { ...identity, cookie, baseUrl: this.options.baseUrl })
    return { outcome, status: signedIn(identity, true) }
  }

  /**
   * End the saved gateway session, then forget it locally.
   * @returns Signed-out status; a failed gateway call leaves the local session for retry.
   */
  async logout(): Promise<MuseAccountStatus> {
    const stored = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    if (stored === null) return { state: 'signed-out' }
    await this.options.gateway.signOut(stored.cookie)
    await clearMuseSessionIfUnchanged(this.options.sessionFile, stored)
    return await this.status()
  }
}
