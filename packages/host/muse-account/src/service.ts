/** Authenticated Remote methods for MUSE account setup in Desktop Settings. */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MuseAccountController, MuseAccountInputError } from './account.ts'
import { MuseGatewayError } from './gateway.ts'
import { MuseAsrClient, type MuseAsrJob } from './asr.ts'
import type { MuseModels } from './models.ts'
import type { MuseDesktopRemote } from './desktop-remote.ts'
import type { MuseAccountLoginRequest, MuseAccountLoginResult, MuseAccountStatus, MuseAccountStatusRequest } from './types.ts'

/** Account operations implemented by the product-home controller. */
type AccountOperations = Pick<MuseAccountController, 'status' | 'login' | 'logout'>

/** The controller passed by the mounted product plugin. */
export interface MuseAccountServiceOptions {
  readonly controller: AccountOperations
  readonly asr?: MuseAsrClient
  readonly models?: Pick<MuseModels, 'refresh'>
  readonly remote?: Pick<MuseDesktopRemote, 'refresh' | 'pause'>
}

/** MUSE account Remote namespace. The Connection carrier authenticates every call. */
export class MuseAccountService extends TypertRemoteService {
  private readonly controller: AccountOperations
  private readonly asr: MuseAsrClient | undefined
  private readonly models: Pick<MuseModels, 'refresh'> | undefined
  private readonly remote: Pick<MuseDesktopRemote, 'refresh' | 'pause'> | undefined

  /**
   * @param ctx - Host context owning the service.
   * @param options - Product-home account operations.
   */
  constructor(ctx: Context, options: MuseAccountServiceOptions) {
    super(ctx, 'museAccount')
    this.controller = options.controller
    this.asr = options.asr
    this.models = options.models
    this.remote = options.remote
  }

  /**
   * Submit audio through the current MUSE account; Host callers retain the job ID.
   * @param file - Local audio created from the authorized media.
   * @param id - Persisted idempotency UUID.
   * @param sha256 - SHA-256 digest of the audio.
   * @param language - Recognition language.
   * @returns Account-scoped task status without session or provider credentials.
   */
  async submitAudio(file: string, id: string, sha256: string, language: 'zh' | 'auto'): Promise<MuseAsrJob> {
    if (!this.asr) throw new Error('MUSE cloud transcription is unavailable in this Host')
    return await this.asr.submit(file, id, sha256, language)
  }

  /**
   * Query a previously submitted transcription without making another paid submission.
   * @param id - Persisted idempotency UUID.
   * @returns Task state and timed segments when complete.
   */
  async audioStatus(id: string): Promise<MuseAsrJob> {
    if (!this.asr) throw new Error('MUSE cloud transcription is unavailable in this Host')
    return await this.asr.get(id)
  }

  /**
   * Read the stored identity or confirm it with the gateway.
   * @param request - Whether to verify the cookie online.
   * @returns A browser-safe status without a cookie.
   */
  @Remote('status')
  async status(request: MuseAccountStatusRequest): Promise<MuseAccountStatus> {
    try {
      await this.models?.refresh()
      await this.remote?.refresh()
      return await this.controller.status(request)
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Sign in using UI-submitted credentials; registration requires an explicit choice.
   * @param request - Username, password and registration choice.
   * @returns The confirmed account identity and actual outcome, without credentials.
   */
  @Remote('login')
  async login(request: MuseAccountLoginRequest): Promise<MuseAccountLoginResult> {
    try {
      const result = await this.controller.login(request)
      await this.remote?.refresh()
      await this.models?.refresh()
      return result
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * End and forget the current account session.
   * @returns Signed-out status after the gateway accepts the logout.
   */
  @Remote('logout')
  async logout(): Promise<MuseAccountStatus> {
    try {
      await this.remote?.pause()
      const status = await this.controller.logout()
      await this.models?.refresh()
      return status
    } catch (error) {
      throw remoteFailure(error)
    }
  }
}

/** Bound all failure text so an upstream response or file error cannot quote a secret. */
function remoteFailure(error: unknown): RemoteError {
  if (error instanceof MuseAccountInputError) {
    return new RemoteError('muse-account/invalid-input', 'MUSE account fields are invalid', {})
  }
  if (error instanceof MuseGatewayError) {
    switch (error.code) {
      case 'invalid-credentials':
      case 'username-taken':
        return new RemoteError('muse-account/invalid-credentials', 'MUSE username or password was rejected', {})
      case 'rate-limited':
        return new RemoteError('muse-account/rate-limited', 'MUSE account requests are temporarily limited', {})
      case 'registration-disabled':
        return new RemoteError('muse-account/registration-disabled', 'MUSE registration is unavailable', {})
      case 'gateway-unavailable':
        return new RemoteError('muse-account/gateway-unavailable', 'MUSE account gateway is unavailable', {})
      case 'gateway-rejected':
        return new RemoteError('muse-account/gateway-rejected', 'MUSE account gateway rejected the request', {})
    }
  }
  return new RemoteError('muse-account/storage-failed', 'MUSE account session could not be read or updated', {})
}
