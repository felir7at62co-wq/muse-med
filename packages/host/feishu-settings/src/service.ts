/**
 * The `feishuSetup` Remote namespace behind the Settings page.
 *
 * The service owns the durable `feishu` switch and the one pending QR scan, and
 * it writes the credential pair into the bridge row's own Config section, where
 * the Loader resolves it for that plugin. That section belongs to the
 * composition entry, so it exists exactly while the composition mounts a bridge
 * row — which is why the shipped patch keeps that row mounted and inert rather
 * than entry-disabled: a disabled row has no Config to write, and the pair a
 * scan produces is exactly what an operator stores before the bridge ever runs.
 * It never answers with the stored secret: {@link FeishuSetupStatus} has no
 * field for it, every failure travels as a bounded code whose details name the
 * reason rather than quoting the settings service's own message, and the
 * section is read through the service's redacted view, which reports only
 * whether the secret is set.
 *
 * @module @deepseek-ai/dsh-feishu-settings/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SettingsDescriptor, SettingsForms } from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { FEISHU_CHANNEL_ROW_ID, FEISHU_SETTINGS_NAMESPACE } from './settings.ts'
import { FeishuLoginError, FeishuLoginFlow, officialRegisterApp, type RegisterAppPort } from './login.ts'
import { credentialSourceOf, rowStateOf, type FeishuRowProbe } from './status.ts'
import type { FeishuLoginTicket, FeishuSetCredentialsRequest, FeishuSetEnabledRequest, FeishuSetupStatus } from './types.ts'

/** Key of the secret inside the bridge row's section. */
const APP_SECRET_KEY = 'appSecret'

/** The slice of the Cordis Loader this service observes. */
interface FeishuLoaderView {
  /**
   * Entries the Loader currently holds, in Loader order.
   * @returns one iterable of entries with their live Config, when mounted.
   */
  entries(): Iterable<{
    readonly options: { readonly id?: string }
    readonly fiber?: { readonly config?: unknown } | undefined
  }>
}

/** Injectable pieces; the row passes the services it was mounted under. */
export interface FeishuSetupServiceOptions {
  /** Registration call; the official one unless a test substitutes a fake. */
  readonly register?: RegisterAppPort
  /** Live product switch this row's own Config carries. */
  readonly enabled: () => boolean
  /** The settings service every section write goes through. */
  readonly settings: SettingsForms
  /** The composition's Loader, when one is mounted above this row. */
  readonly loader?: FeishuLoaderView
}

/** The bridge's stored section read back without its secret. */
interface BridgeCredentialView {
  /** Stored app id, empty when absent. */
  readonly appId: string
  /** Stored scanner open id, empty when the pair was entered by hand. */
  readonly registeredBy: string
  /** Whether the section holds a secret right now, never the secret itself. */
  readonly hasSecret: boolean
}

/**
 * Whether a value is a plain mapping.
 * @param value - candidate.
 * @returns true for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the value fields of one redacted section, and whether its secret is set.
 * @param section - the bridge row's descriptor, or undefined when this composition has none.
 * @returns the fields the page may see.
 */
function credentialViewOf(section: SettingsDescriptor | undefined): BridgeCredentialView {
  const user = isRecord(section?.user) ? section.user : {}
  const appId = user['appId']
  const registeredBy = user['registeredBy']
  return {
    appId: typeof appId === 'string' ? appId : '',
    registeredBy: typeof registeredBy === 'string' ? registeredBy : '',
    hasSecret: section?.secrets?.some(secret => secret.path.join('.') === APP_SECRET_KEY && secret.set) === true,
  }
}

/** Product-owned Feishu setup: one switch, one registration flow, one credential sink. */
export class FeishuSetupService extends TypertRemoteService {
  static inject = ['settings']

  private readonly settings: SettingsForms
  private readonly loader: FeishuLoaderView | undefined
  private readonly switch: () => boolean
  private readonly login: FeishuLoginFlow

  /**
   * @param ctx - Host context owning this service.
   * @param options - the live switch, the settings service, the Loader the row
   *   resolved, plus an injectable registration call.
   */
  constructor(ctx: Context, options: FeishuSetupServiceOptions) {
    super(ctx, 'feishuSetup')
    this.settings = options.settings
    this.loader = options.loader
    this.switch = options.enabled
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
  status(): Promise<FeishuSetupStatus> {
    return Promise.resolve().then(() => {
      const enabled = this.switch()
      const credential = credentialViewOf(this.section())
      const failure = this.login.failure
      return {
        enabled,
        row: rowStateOf(enabled, this.probe()),
        appId: credential.appId,
        credential: credentialSourceOf(credential.hasSecret, credential.registeredBy),
        // The page can only store a pair while this composition holds the bridge
        // row: a row this profile does not compose has no section to write.
        writable: this.section() !== undefined,
        login: this.login.ticket ?? null,
        ...(failure === undefined ? {} : { lastError: failure }),
      }
    })
  }

  /**
   * Store the product switch. The bridge row's own activation key is recomputed
   * by the desktop composition at the next backend start, and a write to `false`
   * also withdraws a pending scan.
   * @param request - the requested switch value.
   * @returns the status after the write.
   */
  @Remote('setEnabled')
  async setEnabled(request: FeishuSetEnabledRequest): Promise<FeishuSetupStatus> {
    await this.settings.update(FEISHU_SETTINGS_NAMESPACE, { enabled: request.enabled })
    if (!request.enabled) this.login.cancel()
    return await this.status()
  }

  /**
   * Store a hand-entered pair in the bridge row's section. An empty secret
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
    try {
      return await this.login.begin(credentialViewOf(this.section()).appId)
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
    if (this.section() !== undefined) {
      await this.settings.mutate(FEISHU_CHANNEL_ROW_ID, [
        { op: 'unset', path: ['appId'] },
        { op: 'unset', path: [APP_SECRET_KEY] },
        { op: 'unset', path: ['registeredBy'] },
      ])
    }
    await this.settings.update(FEISHU_SETTINGS_NAMESPACE, { enabled: false })
    return await this.status()
  }

  /**
   * Write the pair into the bridge row's section and record who scanned it.
   * A different app or scanner withdraws prior sender and session bindings.
   *
   * The section belongs to the composition entry, so a composition that mounts
   * no bridge row has nowhere to put the pair and says so; every other refusal
   * is the settings service's own exception — whose message quotes the entry and
   * path it wrote, and which a schema rejection can fill with the value it
   * refused — and goes to the host log instead of the page.
   * @param appId - app id to store.
   * @param appSecret - secret to store; an empty value keeps a stored one.
   * @param registeredBy - scanner's open id, empty for a hand-entered pair.
   * @throws RemoteError when no section can receive the pair, when nothing is
   *   stored and the request carries no secret, or when the write is refused.
   */
  private async storeCredential(appId: string, appSecret: string, registeredBy: string): Promise<void> {
    const section = this.section()
    if (section === undefined) {
      throw new RemoteError(
        'feishu/credentials-unwritable',
        `this composition mounts no "${FEISHU_CHANNEL_ROW_ID}" row to own the credential section`,
        { reason: 'section-unregistered' },
      )
    }
    if (appSecret.length === 0 && !credentialViewOf(section).hasSecret) {
      throw new RemoteError(
        'feishu/secret-required',
        'no app secret is stored, so this write has to carry one',
        {},
      )
    }
    try {
      await this.settings.update(FEISHU_CHANNEL_ROW_ID, {
        appId,
        ...(appSecret.length === 0 ? {} : { [APP_SECRET_KEY]: appSecret }),
        registeredBy,
        ...(credentialViewOf(section).appId !== appId || credentialViewOf(section).registeredBy !== registeredBy
          ? { allowFrom: [], activeSessionId: '' } : {}),
      })
    } catch (error) {
      this.ctx.logger.error('feishu-settings: storing the app credentials in "%s" was refused', FEISHU_CHANNEL_ROW_ID)
      this.ctx.logger.error(error)
      throw new RemoteError(
        'feishu/credentials-unwritable',
        `the settings service refused the write to "${FEISHU_CHANNEL_ROW_ID}"`,
        { reason: 'write-rejected' },
        { cause: error },
      )
    }
  }

  /**
   * Read the bridge row's section through the settings service's redacted view,
   * which never materializes its secret.
   * @returns the descriptor, or undefined when this composition has no such row.
   */
  private section(): SettingsDescriptor | undefined {
    return this.settings.describe({ redactSecrets: true }).find(entry => entry.ns === FEISHU_CHANNEL_ROW_ID)
  }

  /**
   * Observe this composition's bridge row.
   * @returns the probe {@link rowStateOf} reduces.
   */
  private probe(): FeishuRowProbe {
    const entry = [...this.loader?.entries() ?? []].find(candidate => candidate.options.id === FEISHU_CHANNEL_ROW_ID)
    const config = entry?.fiber?.config
    const enabled = isRecord(config) ? config['enabled'] : undefined
    return {
      composed: entry !== undefined,
      bridgeEnabled: typeof enabled === 'boolean' ? enabled : undefined,
    }
  }
}
