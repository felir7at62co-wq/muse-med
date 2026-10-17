/** Authenticated Remote methods for MUSE account setup in Desktop Settings. */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MuseAccountController, MuseAccountInputError } from './account.ts'
import { MuseGatewayError } from './gateway.ts'
import type { MuseBrowserLogin } from './browser-login.ts'
import type { MuseBrowserLoginAttempt, MuseBrowserLoginId, MuseBrowserLoginResult } from './types.ts'
import { MuseAsrClient, type MuseAsrJob, type MuseAsrPurpose } from './asr.ts'
import type { MuseModels } from './models.ts'
import { MuseFeedbackError, type MuseFeedbackClient } from './feedback.ts'
import type { MuseFeedbackRequest, MuseFeedbackReceipt } from './types.ts'
import type { MuseDesktopRemote } from './desktop-remote.ts'
import { MuseVoiceSlotError, type MuseVoiceSlotRequest, type MuseVoiceSlotsClient } from './voice-slots.ts'
import type { MuseAccountLoginRequest, MuseAccountLoginResult, MuseAccountStatus, MuseAccountStatusRequest } from './types.ts'

/** Account operations implemented by the product-home controller. */
type AccountOperations = Pick<MuseAccountController, 'status' | 'login' | 'logout'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Private account service; voice coordination is Host-only. */
    museAccount: MuseAccountService
  }
}

/** The controller passed by the mounted product plugin. */
export interface MuseAccountServiceOptions {
  readonly controller: AccountOperations
  readonly browserLogin?: Pick<MuseBrowserLogin, 'start' | 'check' | 'cancel'>
  readonly asr?: MuseAsrClient
  readonly models?: Pick<MuseModels, 'refresh'>
  readonly feedback?: Pick<MuseFeedbackClient, 'submit'>
  readonly remote?: Pick<MuseDesktopRemote, 'refresh' | 'pause'>
  readonly voiceSlots?: Pick<MuseVoiceSlotsClient, 'request'>
}

/** MUSE account Remote namespace. The Connection carrier authenticates every call. */
export class MuseAccountService extends TypertRemoteService {
  private readonly logger: Context['logger']
  private readonly controller: AccountOperations
  private readonly browserLogin: MuseAccountServiceOptions['browserLogin']
  private readonly asr: MuseAsrClient | undefined
  private readonly models: Pick<MuseModels, 'refresh'> | undefined
  private readonly feedbackClient: Pick<MuseFeedbackClient, 'submit'> | undefined
  private readonly remote: Pick<MuseDesktopRemote, 'refresh' | 'pause'> | undefined
  private readonly voiceSlots: Pick<MuseVoiceSlotsClient, 'request'> | undefined

  /**
   * @param ctx - Host context owning the service.
   * @param options - Product-home account operations.
   */
  constructor(ctx: Context, options: MuseAccountServiceOptions) {
    super(ctx, 'museAccount')
    this.logger = ctx.logger
    this.controller = options.controller
    this.browserLogin = options.browserLogin
    this.asr = options.asr
    this.models = options.models
    this.feedbackClient = options.feedback
    this.remote = options.remote
    this.voiceSlots = options.voiceSlots
  }

  /**
   * Coordinate a voice registration through the current private Muse account.
   * This Host-only method is deliberately absent from the renderer's Remote interface.
   * @param request - Exact original operation and project/person/life-period identifiers.
   * @param jubianToken - Private provider token for project-access verification.
   * @returns Wire response validated by the Jubian registration consumer.
   */
  async requestVoiceSlot(request: MuseVoiceSlotRequest, jubianToken: string): Promise<unknown> {
    if (!this.voiceSlots) throw new MuseVoiceSlotError('not-configured')
    return await this.voiceSlots.request(request, jubianToken)
  }

  /**
   * Submit one explicitly authored remark to the signed-in Muse account's inbox.
   * @param request - Target, category, note and optional related-excerpt choice.
   * @returns A confirmed durable inbox receipt, without a cookie or transcript.
   */
  @Remote('feedback')
  async feedback(request: MuseFeedbackRequest): Promise<MuseFeedbackReceipt> {
    try {
      if (!this.feedbackClient) throw new MuseFeedbackError('unavailable')
      return await this.feedbackClient.submit(request)
    } catch (error) {
      const code = error instanceof MuseFeedbackError ? error.code : 'unavailable'
      throw new RemoteError(`muse-feedback/${code}`, `MUSE feedback: ${code}`, {})
    }
  }

  /**
   * Submit audio through the current MUSE account; Host callers retain the job ID.
   * @param file - Local audio created from the authorized media.
   * @param id - Persisted idempotency UUID.
   * @param sha256 - SHA-256 digest of the audio.
   * @param language - Recognition language.
   * @param purpose - Receipt-bound use; omit only for a legacy receipt without a purpose.
   * @param signal - Cancellation of the local upload, without cancelling an accepted gateway task.
   * @returns Account-scoped task status without session or provider credentials.
   */
  async submitAudio(file: string, id: string, sha256: string, language: 'zh' | 'auto', purpose?: MuseAsrPurpose, signal?: AbortSignal): Promise<MuseAsrJob> {
    if (!this.asr) throw new Error('MUSE cloud transcription is unavailable in this Host')
    return await this.asr.submit(file, id, sha256, language, purpose, signal)
  }

  /**
   * Query a previously submitted transcription without making another paid submission.
   * @param id - Persisted idempotency UUID.
   * @param signal - Cancellation of this status request.
   * @returns Task state and timed segments when complete.
   */
  async audioStatus(id: string, signal?: AbortSignal): Promise<MuseAsrJob> {
    if (!this.asr) throw new Error('MUSE cloud transcription is unavailable in this Host')
    return await this.asr.get(id, signal)
  }

  /**
   * Read the stored identity or confirm it with the gateway.
   * @param request - Whether to verify the cookie online.
   * @returns A browser-safe status without a cookie.
   */
  @Remote('status')
  async status(request: MuseAccountStatusRequest): Promise<MuseAccountStatus> {
    try {
      const status = await this.controller.status(request)
      await this.refreshConsumers('status')
      return status
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Sign in using UI-submitted credentials; registration requires an explicit choice.
   * @param request - Username, password and registration choice.
   * @returns The confirmed account identity and actual outcome, without credentials; post-login refresh failures do not replace it.
   */
  @Remote('login')
  async login(request: MuseAccountLoginRequest): Promise<MuseAccountLoginResult> {
    try {
      await this.browserLogin?.cancel()
      const result = await this.controller.login(request)
      await this.refreshConsumers('login')
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
      await this.browserLogin?.cancel()
      await this.remote?.pause()
      const status = await this.controller.logout()
      await this.models?.refresh()
      return status
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  private async refreshConsumers(phase: 'status' | 'login'): Promise<void> {
    const context = phase === 'status'
      ? 'while reading account status; the saved account state remains authoritative.'
      : 'after login; the saved account remains signed in.'
    try { await this.remote?.refresh() }
    catch (error) { this.logger.warn(`Muse desktop connection refresh failed ${context}`, error) }
    try { await this.models?.refresh() }
    catch (error) { this.logger.warn(`Muse model catalog refresh failed ${context}`, error) }
  }

  /**
   * Start browser approval for this Desktop Host.
   * @returns A browser approval URL and matching code, without its redemption secret.
   */
  @Remote('startBrowserLogin')
  async startBrowserLogin(): Promise<MuseBrowserLoginAttempt> {
    try {
      if (this.browserLogin === undefined) throw new MuseGatewayError('gateway-unavailable')
      return await this.browserLogin.start()
    } catch (error) { throw remoteFailure(error) }
  }

  /**
   * Complete an approved login and refresh account consumers.
   * @param id - Attempt owned by this Host.
   * @returns Pending or terminal browser-safe state after local session persistence.
   */
  @Remote('checkBrowserLogin')
  async checkBrowserLogin(id: MuseBrowserLoginId): Promise<MuseBrowserLoginResult> {
    try {
      if (this.browserLogin === undefined) throw new MuseGatewayError('gateway-unavailable')
      const result = await this.browserLogin.check(id)
      if (result.state === 'signed-in') await this.refreshConsumers('login')
      return result
    } catch (error) { throw remoteFailure(error) }
  }

  /**
   * Cancel an unredeemed approval and read the account after any already-running commit settles.
   * @param id - Exact attempt to cancel.
   * @returns Current local account state.
   */
  @Remote('cancelBrowserLogin')
  async cancelBrowserLogin(id: MuseBrowserLoginId): Promise<MuseAccountStatus> {
    try {
      await this.browserLogin?.cancel(id)
      return await this.controller.status()
    } catch (error) { throw remoteFailure(error) }
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
