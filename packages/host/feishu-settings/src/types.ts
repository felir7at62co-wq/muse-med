/**
 * Remote view types of the Feishu settings page.
 *
 * Every field here is safe to serialize to the browser: the app secret has no
 * field to travel in, and failures carry a stable code instead of a platform
 * message, so a diagnostic can never quote stored credentials.
 *
 * @module @deepseek-ai/dsh-feishu-settings/types
 */

/** How the bundled bridge row stands right now. */
export type FeishuRowState =
  /** The product switch is off; the Loader never starts the row. */
  | 'disabled'
  /** The switch is on, but this backend composed the row before that write. */
  | 'restart-pending'
  /** The row is composed enabled and no plugin-level key overrides it. */
  | 'active'
  /** The bridge's own settings section stores `enabled: false`, which wins. */
  | 'overridden'
  /** This composition has no bridge row at all. */
  | 'unavailable'

/** Where the stored credentials came from. */
export type FeishuCredentialSource =
  /** Nothing stored. */
  | 'none'
  /** `appId`/`appSecret` were entered by hand. */
  | 'manual'
  /** A completed QR scan wrote them. */
  | 'registered'

/** One scannable registration ticket. */
export interface FeishuLoginTicket {
  /** URL the platform wants scanned. */
  readonly url: string
  /** `data:image/svg+xml;base64,…` rendering of that URL, made on the Host. */
  readonly qrDataUrl: string
  /** Seconds the platform keeps this code valid. */
  readonly expiresInSeconds: number
}

/** What the page reads on every refresh. */
export interface FeishuSetupStatus {
  /** Stored product switch. */
  readonly enabled: boolean
  /** Effective state of the bridge row in this running composition. */
  readonly row: FeishuRowState
  /** Stored `appId`, safe to display. */
  readonly appId: string
  /** Where the stored credential pair came from. */
  readonly credential: FeishuCredentialSource
  /** Whether this deployment can write the namespace at all. */
  readonly writable: boolean
  /** The pending scan, when one is waiting for a phone. */
  readonly login: FeishuLoginTicket | null
  /** Stable code of the last scan failure, never a platform message. */
  readonly lastError?: string
}

/** One switch write. */
export interface FeishuSetEnabledRequest {
  /** The requested value of the product switch. */
  readonly enabled: boolean
}

/** One hand-entered credential pair. */
export interface FeishuSetCredentialsRequest {
  /** App id to store. */
  readonly appId: string
  /** App secret to store; an empty value keeps the stored one. */
  readonly appSecret: string
}
