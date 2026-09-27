/**
 * The `feishuSetup` Remote namespace behind the Settings page.
 *
 * The service owns the durable `feishu` switch and the one pending QR scan, and
 * it writes the credential pair into the bridge's own section, where the bridge
 * resolves it over its composed config. That section is registered by whichever
 * row runs the bridge, and by this product while none does — the switch only
 * says whether the bridge should run, and a composition may run no bridge row
 * at all. It never answers with the stored secret: {@link FeishuSetupStatus} has
 * no field for it, and every failure travels as a bounded code whose details
 * name the reason rather than quoting the settings service's own message.
 *
 * @module @deepseek-ai/dsh-feishu-settings/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  BRIDGE_SETTINGS_NAMESPACE, BridgeSettingsSchema, FEISHU_SETTINGS_NAMESPACE, FeishuSettingsSchema,
  type FeishuSettings,
} from './settings.ts'
import { FeishuLoginError, FeishuLoginFlow, officialRegisterApp, type RegisterAppPort } from './login.ts'
import { credentialSourceOf, rowStateOf, type FeishuRowProbe } from './status.ts'
import type { FeishuLoginTicket, FeishuSetCredentialsRequest, FeishuSetEnabledRequest, FeishuSetupStatus } from './types.ts'

/** Composition row id of the bundled Feishu bridge. */
export const FEISHU_CHANNEL_ROW_ID = 'feishu-channel'

/** The slice of the Cordis Loader this service observes. */
interface FeishuLoaderView {
  /**
   * Entries the Loader currently holds, in Loader order.
   * @returns one iterable of entries.
   */
  entries(): Iterable<{ readonly options: { readonly id?: string; readonly disabled?: boolean | null } }>
}

/** Injectable pieces; the row passes the services it was mounted under. */
export interface FeishuSetupServiceOptions {
  /** Registration call; the official one unless a test substitutes a fake. */
  readonly register?: RegisterAppPort
  /** Settings provider this row was gated on; the row always passes one. */
  readonly settings: SettingsProvider
  /** The composition's Loader, when one is mounted above this row. */
  readonly loader?: FeishuLoaderView
}

/** The bridge's stored section read back without its secret. */
interface BridgeCredentialView {
  /** Stored app id, empty when absent. */
  readonly appId: string
  /** Whether a secret is stored, never the secret itself. */
  readonly hasSecret: boolean
  /** `dsh-lark-bridge.enabled` from the user layer, `undefined` when absent. */
  readonly override: boolean | undefined
}

/**
 * Whether a value is a plain mapping.
 * @param value - candidate.
 * @returns true for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Product-owned Feishu setup: one switch, one registration flow, one credential sink. */
export class FeishuSetupService extends TypertRemoteService {
  static inject = ['settings']

  private readonly provider: SettingsProvider
  private readonly loader: FeishuLoaderView | undefined
  private readonly scope: SettingsScope<FeishuSettings>
  private readonly login: FeishuLoginFlow

  /**
   * @param ctx - Host context owning this service.
   * @param options - the settings provider and Loader the row resolved, plus an
   *   injectable registration call.
   */
  constructor(ctx: Context, options: FeishuSetupServiceOptions) {
    super(ctx, 'feishuSetup')
    this.provider = options.settings
    this.loader = options.loader
    this.scope = options.settings.register(FEISHU_SETTINGS_NAMESPACE, FeishuSettingsSchema, { applies: 'restart' })
    this.login = new FeishuLoginFlow({
      register: options.register ?? officialRegisterApp,
      onRegistered: async (registration) => {
        await this.storeCredential(registration.appId, registration.appSecret, registration.registeredBy ?? '')
      },
    })
  }

  /**
   * Read the stored switch, the effective row state, and any pending scan.
   * @returns the status the page renders.
   */
  @Remote('status')
  async status(): Promise<FeishuSetupStatus> {
    const stored = this.scope.get()
    this.ensureBridgeSection()
    const credential = this.credentialView()
    const failure = this.login.failure
    return {
      enabled: stored.enabled,
      row: rowStateOf(stored.enabled, this.probe(credential.override)),
      appId: credential.appId,
      credential: credentialSourceOf(credential.hasSecret, stored.registeredBy),
      writable: this.provider.writable,
      login: this.login.ticket ?? null,
      ...(failure === undefined ? {} : { lastError: failure }),
    }
  }

  /**
   * Store the product switch. The row's entry-level `disabled` is recomputed by
   * the desktop composition at the next backend start, and a write to `false`
   * also withdraws a pending scan.
   * @param request - the requested switch value.
   * @returns the status after the write.
   */
  @Remote('setEnabled')
  async setEnabled(request: FeishuSetEnabledRequest): Promise<FeishuSetupStatus> {
    await this.scope.update({ enabled: request.enabled === true })
    if (request.enabled !== true) this.login.cancel()
    return await this.status()
  }

  /**
   * Store a hand-entered pair in the bridge's own section. An empty secret
   * keeps a stored one, so the page never has to send back a value it was never
   * shown; with nothing stored yet it is refused. The pair takes effect at the
   * next backend start.
   * @param request - app id plus secret, the secret required while none is stored.
   * @returns the status after the write.
   * @throws RemoteError when no section can receive the pair, or the request carries no secret.
   */
  @Remote('setCredentials')
  async setCredentials(request: FeishuSetCredentialsRequest): Promise<FeishuSetupStatus> {
    await this.storeCredential(request.appId.trim(), request.appSecret, '')
    return await this.status()
  }

  /**
   * Start one QR scan and answer with the ticket to show.
   * @returns the URL, its Host-rendered QR image, and the platform's validity window.
   * @throws RemoteError whose details carry the platform's bounded failure code.
   */
  @Remote('beginLogin')
  async beginLogin(): Promise<FeishuLoginTicket> {
    this.ensureBridgeSection()
    try {
      return await this.login.begin(this.credentialView().appId)
    } catch (error) {
      if (!(error instanceof FeishuLoginError)) throw error
      // The code is the platform's, already narrowed to `[A-Za-z0-9_.-]{1,64}`
      // by the flow, so it can carry no request material.
      this.ctx.logger.warn('feishu-settings: the platform registration failed (%s)', error.code)
      throw new RemoteError(
        'feishu/login-failed',
        `the platform's app registration failed (${error.code})`,
        { code: error.code },
        { cause: error },
      )
    }
  }

  /**
   * Withdraw the pending scan.
   * @returns the status after the withdrawal.
   */
  @Remote('cancelLogin')
  async cancelLogin(): Promise<FeishuSetupStatus> {
    this.login.cancel()
    return await this.status()
  }

  /**
   * Forget the stored pair and turn the switch off. The pair lives only in the
   * bridge's own section, so this is the one removal path.
   * @returns the status after the write.
   */
  @Remote('forget')
  async forget(): Promise<FeishuSetupStatus> {
    this.login.cancel()
    if (this.provider.describe().some(entry => entry.ns === BRIDGE_SETTINGS_NAMESPACE)) {
      await this.provider.mutate(BRIDGE_SETTINGS_NAMESPACE, [
        { op: 'unset', path: ['appId'] },
        { op: 'unset', path: ['appSecret'] },
      ])
    }
    await this.scope.update({ enabled: false, registeredBy: '' })
    return await this.status()
  }

  /**
   * Write the pair into the bridge's own section and record who scanned it.
   *
   * The section is whichever owner this composition gave it: the bridge row
   * when it runs, this product otherwise. Every refusal is reported as a
   * bounded reason, and the settings service's own exception — whose message
   * quotes the section and path it wrote, and which a schema rejection can fill
   * with the value it refused — goes to the host log instead of the page.
   * @param appId - app id to store.
   * @param appSecret - secret to store; an empty value keeps a stored one.
   * @param registeredBy - scanner's open id, empty for a hand-entered pair.
   * @throws RemoteError when no section can receive the pair, when nothing is
   *   stored and the request carries no secret, or when the write is refused.
   */
  private async storeCredential(appId: string, appSecret: string, registeredBy: string): Promise<void> {
    if (!this.ensureBridgeSection()) {
      throw new RemoteError(
        'feishu/credentials-unwritable',
        `no row registered the "${BRIDGE_SETTINGS_NAMESPACE}" settings section in this composition`,
        { reason: 'section-unregistered' },
      )
    }
    if (!this.provider.writable) {
      throw new RemoteError(
        'feishu/credentials-unwritable',
        `the settings provider refuses writes to "${BRIDGE_SETTINGS_NAMESPACE}" in this process`,
        { reason: 'provider-read-only' },
      )
    }
    if (appSecret.length === 0 && !this.credentialView().hasSecret) {
      throw new RemoteError(
        'feishu/secret-required',
        'no app secret is stored, so this write has to carry one',
        {},
      )
    }
    try {
      await this.provider.update(BRIDGE_SETTINGS_NAMESPACE, {
        appId,
        ...(appSecret.length === 0 ? {} : { appSecret }),
      })
    } catch (error) {
      this.ctx.logger.error('feishu-settings: storing the app credentials in "%s" was refused', BRIDGE_SETTINGS_NAMESPACE)
      this.ctx.logger.error(error)
      throw new RemoteError(
        'feishu/credentials-unwritable',
        `the settings service refused the write to "${BRIDGE_SETTINGS_NAMESPACE}"`,
        { reason: 'write-rejected' },
        { cause: error },
      )
    }
    await this.scope.update({ registeredBy })
  }

  /**
   * Give the bridge's own section an owner while no other row owns it.
   *
   * The section belongs to whichever row runs the bridge: that row registers
   * the namespace with its own schema and resolves the stored pair over its
   * entry config — taking the name from a running bridge would fail that
   * bridge's own registration and leave it on entry config alone. The settings
   * service refuses to write an unregistered namespace, and a composition whose
   * bridge row never mounts (the Web profile's gate keeps it disabled until an
   * operator turns it on) has no other registrant, so this product takes the
   * name when it is free at the moment the page reads or writes. A composition
   * that does run the bridge registers it while the Loader settles, which is
   * before the Web server answers any page call.
   * @returns whether the section has an owner once this call returns.
   */
  private ensureBridgeSection(): boolean {
    if (this.hasBridgeSection()) return true
    try {
      this.provider.register(BRIDGE_SETTINGS_NAMESPACE, BridgeSettingsSchema, { applies: 'restart' })
    } catch (error) {
      // The name was taken between the check and the call: the section still
      // has an owner, just not one that took this registration.
      this.ctx.logger.error('feishu-settings: could not register the "%s" settings section', BRIDGE_SETTINGS_NAMESPACE)
      this.ctx.logger.error(error)
    }
    return this.hasBridgeSection()
  }

  /** Whether any row currently owns the bridge's settings section. */
  private hasBridgeSection(): boolean {
    return this.provider.describe().some(entry => entry.ns === BRIDGE_SETTINGS_NAMESPACE)
  }

  /**
   * Read the bridge's stored section without ever materializing its secret.
   * @returns the app id, whether a secret is stored, and any `enabled` override.
   */
  private credentialView(): BridgeCredentialView {
    const descriptor = this.provider.describe().find(entry => entry.ns === BRIDGE_SETTINGS_NAMESPACE)
    const user = isRecord(descriptor?.user) ? descriptor.user : {}
    const secret = user['appSecret']
    const override = user['enabled']
    return {
      appId: typeof user['appId'] === 'string' ? user['appId'] : '',
      hasSecret: typeof secret === 'string' && secret.length > 0,
      override: typeof override === 'boolean' ? override : undefined,
    }
  }

  /**
   * Observe this composition's bridge row.
   * @param override - `dsh-lark-bridge.enabled` read from the stored user layer.
   * @returns the probe {@link rowStateOf} reduces.
   */
  private probe(override: boolean | undefined): FeishuRowProbe {
    const entry = [...this.loader?.entries() ?? []].find(candidate => candidate.options.id === FEISHU_CHANNEL_ROW_ID)
    return { entryDisabled: entry?.options.disabled ?? undefined, bridgeOverride: override }
  }
}
