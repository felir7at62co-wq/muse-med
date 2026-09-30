/** Desktop tunnel capability implemented by the pinned Muse bridge provider. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one desktop installation, retained across restarts. */
export type MuseDesktopDeviceId = Branded<'muse-desktop-device-id'>

/** Observed state of the authenticated desktop control connection. */
export type MuseDesktopConnectionState = 'connecting' | 'online' | 'offline' | 'rejected'

/** Account-authenticated control connection and private loopback target. */
export interface MuseDesktopTunnelOptions {
  readonly serverUrl: string
  readonly headers: Readonly<Record<string, string>>
  readonly localPort: number
  readonly loopbackCookie: string
  readonly deviceId: MuseDesktopDeviceId
  readonly chunkBytes: number
  readonly ackTimeoutMs: number
  readonly reconnectMaxIntervalMs: number
  readonly onState: (state: MuseDesktopConnectionState) => void
}

/** Connection lifetime; stopping closes observers without cancelling agent turns. */
export interface MuseDesktopTunnel {
  /** Connect and enable automatic reconnection until stopped. */
  start(): Promise<void>
  /** Close connections and await all local proxy requests and timers. */
  stop(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    museDesktopBridge: MuseDesktopBridge
  }
}

/** Provider factory for an account-bound desktop, using the existing Host authority. */
export abstract class MuseDesktopBridge extends Service {
  /** @param ctx - Host context owning this provider. */
  constructor(ctx: Context) {
    super(ctx, 'museDesktopBridge')
  }

  /**
   * Create a stopped tunnel. Neither account cookies nor loopback cookies appear in URLs.
   * @param options - Verified account and local Host connection settings.
   * @returns Tunnel whose owner must await stop during account changes and disposal.
   */
  abstract createTunnel(options: MuseDesktopTunnelOptions): MuseDesktopTunnel
}
