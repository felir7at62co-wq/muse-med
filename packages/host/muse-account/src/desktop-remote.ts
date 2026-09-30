/** Lifetime of the desktop's account-authenticated connection. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { MuseDesktopBridge, MuseDesktopConnectionState, MuseDesktopDeviceId, MuseDesktopTunnel } from './desktop-bridge.ts'
import { readMuseSession } from './session.ts'

/** Product-resolved files, provider and authenticated loopback access. */
export interface MuseDesktopRemoteOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly deviceFile: string
  readonly bridge: Pick<MuseDesktopBridge, 'createTunnel'>
  readonly localAuthorization: () => Promise<{ readonly port: number; readonly cookie: string }>
  readonly chunkBytes: number
  readonly ackTimeoutMs: number
  readonly reconnectMaxIntervalMs: number
  readonly onState?: (state: MuseDesktopConnectionState) => void
}

/** Serialized connection owner shared by startup refresh and account changes. */
export class MuseDesktopRemote {
  private queue: Promise<void> = Promise.resolve()
  private current: { readonly revision: string; readonly tunnel: MuseDesktopTunnel } | undefined
  private pausedRevision: string | undefined
  private closed = false

  /** @param options - Account files and private Host authentication operation. */
  constructor(private readonly options: MuseDesktopRemoteOptions) {}

  /** Observe the latest stored account and update the owned desktop connection. */
  async refresh(): Promise<void> {
    await this.serialize(async () => {
      if (this.closed) return
      const session = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
      if (session?.revision === this.current?.revision && this.current !== undefined) return
      await this.detach()
      if (session === null || session.revision === this.pausedRevision) return
      const deviceId = await deviceIdentity(this.options.deviceFile)
      const authorization = await this.options.localAuthorization()
      const latest = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
      // eslint-disable-next-line typescript/no-unnecessary-condition -- dispose can run while local authorization is awaited.
      if (this.closed || latest?.revision !== session.revision) return
      const serverUrl = new URL('/api/desktop/connect', this.options.baseUrl)
      serverUrl.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      const tunnel = this.options.bridge.createTunnel({
        serverUrl: serverUrl.href,
        headers: { cookie: session.cookie, origin: this.options.baseUrl },
        localPort: authorization.port,
        loopbackCookie: authorization.cookie,
        deviceId,
        chunkBytes: this.options.chunkBytes,
        ackTimeoutMs: this.options.ackTimeoutMs,
        reconnectMaxIntervalMs: this.options.reconnectMaxIntervalMs,
        onState: (state) => { if (this.current?.tunnel === tunnel) this.options.onState?.(state) },
      })
      this.current = { revision: session.revision, tunnel }
      // Reconnection belongs to the provider; an unavailable network cannot delay sign-in.
      void tunnel.start().catch((error: unknown) => {
        // The provider reports connection failures through onState and owns retries.
        void error
      })
    })
  }

  /** Detach the current account before a logout request. */
  async pause(): Promise<void> {
    await this.serialize(async () => {
      this.pausedRevision = (await readMuseSession(this.options.sessionFile, this.options.baseUrl))?.revision
      await this.detach()
    })
  }

  /** Stop and await all connections without stopping agent work. */
  async dispose(): Promise<void> {
    this.closed = true
    await this.serialize(async () => { await this.detach() })
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation)
    this.queue = next.catch((error: unknown) => {
      // This observer keeps later account operations usable; the caller receives next's rejection.
      void error
    })
    return next
  }

  private async detach(): Promise<void> {
    const previous = this.current
    this.current = undefined
    if (previous !== undefined) await previous.tunnel.stop()
  }
}

/** Retain a private installation UUID; account credentials are stored separately. */
async function deviceIdentity(file: string): Promise<MuseDesktopDeviceId> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  return await withFileLock(file, async () => {
    let text: string
    try { text = await readFile(file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const id = randomUUID() as MuseDesktopDeviceId
      await writeFileAtomic(file, JSON.stringify({ version: 1, id }) + '\n', { mode: 0o600, dirMode: 0o700 })
      return id
    }
    const record: unknown = JSON.parse(text)
    if (typeof record !== 'object' || record === null || Array.isArray(record)) throw Error('muse-account: invalid desktop identity')
    const fields = record as Record<string, unknown>
    if (fields.version !== 1 || typeof fields.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(fields.id)) {
      throw Error('muse-account: invalid desktop identity')
    }
    return fields.id as MuseDesktopDeviceId
  })
}
