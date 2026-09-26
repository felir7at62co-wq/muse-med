/**
 * The `feishuSetup` Remote namespace behind the Settings page.
 *
 * The service owns the durable `feishu` switch and the one pending QR scan, and
 * it writes the credential pair into the bridge's own section, where the bridge
 * resolves it over its composed config. It never answers with the stored secret:
 * {@link FeishuSetupStatus} has no field for it, and every failure travels as a
 * bounded code.
 *
 * @module @deepseek-ai/dsh-feishu-settings/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  BRIDGE_SETTINGS_NAMESPACE, BridgeSettingsSchema, FEISHU_SETTINGS_NAMESPACE, FeishuSettingsSchema,
  type FeishuSettings,
} from './settings.ts'
import { FeishuLoginFlow, officialRegisterApp, type RegisterAppPort } from './login.ts'
import { credentialSourceOf, rowStateOf, type FeishuRowProbe } from './status.ts'
import type { FeishuLoginTicket, FeishuSetCredentialsRequest, FeishuSetEnabledRequest, FeishuSetupStatus } from './types.ts'

/** Composition row id of the bundled Feishu bridge. */
export const FEISHU_CHANNEL_ROW_ID = 'feishu-channel'

/** Failure code reported when the bridge's own section cannot be written. */
const BRIDGE_UNAVAILABLE = 'bridge-settings-unavailable'

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
    // The settings service refuses to write an unregistered namespace, so the
    // bridge's section is pre-registered exactly while the bridge cannot run:
    // with the switch off, the gate disables that row for this whole boot.
    if (!this.scope.get().enabled) {
      options.settings.register(BRIDGE_SETTINGS_NAMESPACE, BridgeSettingsSchema, { applies: 'restart' })
    }
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
    const credential = this.credentialView()
    const failure = this.login.failure
    return {
      enabled: stored.enabled,
      row: rowStateOf(stored.enabled, this.probe(credential.override)),
      appId: credential.appId,
      credential: credentialSourceOf(credential.hasSecret, stored.registeredBy),
      writable: true,
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
   * Store a hand-entered pair in the bridge's own section. An empty secret keeps
   * the stored one, so the page never has to send back a value it was never
   * shown. The pair takes effect at the next backend start.
   * @param request - app id plus secret, an empty secret meaning unchanged.
   * @returns the status after the write.
   */
  @Remote('setCredentials')
  async setCredentials(request: FeishuSetCredentialsRequest): Promise<FeishuSetupStatus> {
    await this.storeCredential(request.appId.trim(), request.appSecret, '')
    return await this.status()
  }

  /**
   * Start one QR scan and answer with the ticket to show.
   * @returns the URL, its Host-rendered QR image, and the platform's validity window.
   * @throws FeishuLoginError whose message is the stable failure code.
   */
  @Remote('beginLogin')
  async beginLogin(): Promise<FeishuLoginTicket> {
    return await this.login.begin(this.credentialView().appId)
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
   * @param appId - app id to store.
   * @param appSecret - secret to store; an empty value keeps the stored one.
   * @param registeredBy - scanner's open id, empty for a hand-entered pair.
   * @throws Error with a bounded message when the bridge's section is absent.
   */
  private async storeCredential(appId: string, appSecret: string, registeredBy: string): Promise<void> {
    try {
      await this.provider.update(BRIDGE_SETTINGS_NAMESPACE, {
        appId,
        ...(appSecret.length === 0 ? {} : { appSecret }),
      })
    } catch (error) {
      // The bridge's section is neither pre-registered (switch on) nor composed
      // (bridge absent), so there is nowhere to store the pair; the reason never
      // quotes the pair itself.
      void error
      throw new Error(BRIDGE_UNAVAILABLE)
    }
    await this.scope.update({ registeredBy })
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
