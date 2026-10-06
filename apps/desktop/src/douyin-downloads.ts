/** One-use native downloads owned by the authenticated Host and one leased guest. */
import type { DownloadItem, WebContents, OnResponseStartedListenerDetails } from 'electron'
import { mkdirSync, lstatSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  DesktopBrowserLeaseId,
  DouyinDesktopRequest,
  DouyinDesktopResult,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { douyinMedia, douyinPage, mediaURLHash, targetVideoId, DOUYIN_PLAYER_PROBE } from './douyin-policy.ts'
import {
  ProviderResponses,
  PROVIDER_PLAYER_PROBE,
  publicMediaAddress,
  type ProviderEvidence,
} from './douyin-provider.ts'

/** Main-owned facts from the browser reservation, never supplied by web content. */
export interface DouyinGuest {
  readonly lease: DesktopBrowserLeaseId
  readonly owner: WebContents
  readonly guest: WebContents
  readonly workspace: string
  readonly sessionId: string | undefined
}

/**
 * @param lease - Main-issued browser reservation.
 * @param owner - Initiating application window.
 * @param sessionId - Selected owning Session.
 * @param cwd - Host-resolved workspace directory.
 * @returns Whether the reservation uses that Session and its canonical storage identity.
 */
export function douyinGuestMatches(lease: DouyinGuest, owner: WebContents, sessionId: string, cwd: string): boolean {
  if (lease.owner !== owner || lease.sessionId !== sessionId) return false
  let workspace: string
  try { workspace = realpathSync(cwd) }
  catch (_error) { return false /* A removed workspace cannot acquire browser ownership. */ }
  return [`cwd:${workspace}`, `session:${sessionId}`].includes(lease.workspace)
}

interface Task {
  request: DouyinDesktopRequest
  owner: WebContents
  phase: 'preparing' | 'ready' | 'observing' | 'downloading' | 'staged'
  lease?: DouyinGuest
  target?: string
  response?: { url: string; status: number } | undefined
  selectedURL?: string
  item?: DownloadItem
  directory?: string
  timer: ReturnType<typeof setTimeout>
  poll: ReturnType<typeof setInterval>
  reply?: ((result: DouyinDesktopResult) => void) | undefined
  checking?: boolean
  completion?: Promise<void>
  providerResponses?: ProviderResponses
  providerAvailable?: boolean
  provider?: ProviderEvidence | undefined
  association?: 'player-exact' | 'provider-detail-verified'
  documentEpoch?: number
  navigation?: (event: Electron.Event, url: string, inPlace: boolean, mainFrame: boolean) => void
  transferResponses?: Map<string, number>
}

/** One native task has a bounded preparation and transfer lifetime. */
const MAX_MS = 120_000

/** @param cwd - session root. @param task - random task ID. @returns private real-directory staging path. */
function stagingDirectory(cwd: string, task: string): string {
  let directory = realpathSync(cwd)
  for (const part of ['source', 'media', 'douyin', `.native-${task}`]) {
    directory = join(directory, part)
    try {
      mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    if (
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink() ||
      realpathSync(directory) !== directory
    )
      throw new Error('Unsafe media directory')
  }
  return directory
}

/** Owns grants and completion; generic browser downloads remain denied. */
export class DesktopDouyinDownloads {
  private task: Task | undefined
  private readonly active = new Map<WebContents, string | undefined>()
  /** Main-to-owning-Host revocation; no renderer can provide this callback. */
  onRevoked?: (taskId: string, code: string) => void

  /** @param guests - main-issued guest roster. @param open - existing Browser UI opener. */
  private readonly cleanups = new Set<Promise<void>>()

  constructor(
    private readonly open: (owner: WebContents, sessionId: string, url: string) => void,
    private readonly addresses?: (host: string) => Promise<readonly string[]>,
  ) {}

  /** @returns Whether a main-issued download task currently owns the native grant. */
  get isActive(): boolean {
    return this.task !== undefined
  }

  /** @param owner - authenticated application window. @param session - selected Session, or absent. */
  activeSession(owner: WebContents, session: unknown): void {
    if (session !== undefined && (typeof session !== 'string' || session.length > 256)) return
    this.active.set(owner, session)
    if (this.task?.owner === owner && this.task.request.sessionId !== session) void this.revoke('SESSION_CHANGED')
  }

  /** @param owner - application window. @param request - validated child request. @returns sanitized result. */
  async request(owner: WebContents, request: DouyinDesktopRequest): Promise<DouyinDesktopResult> {
    const answer = (code: string): DouyinDesktopResult => ({
      type: 'douyin-browser-result',
      requestId: request.requestId,
      code,
    })
    if (request.action === 'release') {
      if (this.matches(owner, request)) await this.revoke('CANCELLED')
      return answer('RELEASED')
    }
    if (this.active.get(owner) !== request.sessionId || owner.isDestroyed()) return answer('SESSION_NOT_VISIBLE')
    if (request.action === 'prepare') {
      if (this.task !== undefined) return answer('BUSY')
      return new Promise((resolveResult) => {
        const task: Task = {
          request,
          owner,
          phase: 'preparing',
          timer: setTimeout(() => {
            void this.revoke(this.task?.phase === 'observing' ? 'UNSUPPORTED_MEDIA_ASSOCIATION' : 'EXPIRED')
          }, MAX_MS),
          poll: setInterval(() => {
            this.tick()
          }, 100),
          reply: resolveResult,
        }
        this.task = task
        try {
          this.open(owner, request.sessionId, request.url)
        } catch (_error) {
          void this.revoke('UI_UNAVAILABLE')
        }
      })
    }
    const task = this.task
    if (!this.matches(owner, request) || task?.phase !== 'ready' || task.target !== request.targetVideoId)
      return answer('GRANT_MISMATCH')
    // Only the owning Host can begin the target-bound tool operation; renderer IPC cannot issue it.
    task.request = request
    task.phase = 'observing'
    task.documentEpoch = 0
    const target = task.target
    if (target === undefined) return answer('GRANT_MISMATCH')
    const guest = task.lease?.guest
    if (guest === undefined) return answer('LEASE_RELEASED')
    task.navigation = (_event, url, inPlace, mainFrame) => {
      if (this.task !== task || !mainFrame || inPlace) return
      task.documentEpoch = (task.documentEpoch ?? 0) + 1
      task.provider = undefined
      task.response = undefined
      task.providerResponses?.newDocument()
      if (task.documentEpoch !== 1 || targetVideoId(url) !== task.target) void this.revoke('DOCUMENT_CHANGED')
    }
    guest.on('did-start-navigation', task.navigation)
    task.providerResponses = new ProviderResponses(
      guest,
      target,
      () => task.documentEpoch ?? 0,
      (source) => {
        if (this.task === task && task.phase === 'observing' && source.documentEpoch === 1) {
          task.provider ??= source
          void this.chooseProvider(task).catch(() => {
            if (this.task === task) void this.revoke('PROVIDER_SOURCE_REJECTED')
          })
        }
      },
      () => {
        if (this.task === task) void this.revoke('PROTECTED_MEDIA')
      },
    )
    return new Promise((resolveResult) => {
      task.reply = resolveResult
      void task.providerResponses
        ?.start()
        .then((available) => {
          task.providerAvailable = available
          if (this.task === task && task.phase === 'observing') guest.reload()
        })
        .catch(() => {
          if (this.task === task) void this.revoke('PROVIDER_SOURCE_UNAVAILABLE')
        })
    })
  }

  private matches(owner: WebContents, request: DouyinDesktopRequest): boolean {
    const task = this.task
    return (
      task !== undefined &&
      task.owner === owner &&
      task.request.taskId === request.taskId &&
      task.request.sessionId === request.sessionId &&
      task.request.cwd === request.cwd &&
      task.request.url === request.url &&
      task.request.maxDownloadBytes === request.maxDownloadBytes
    )
  }

  private tick(): void {
    const task = this.task
    if (task === undefined) return
    if (task.owner.isDestroyed() || this.active.get(task.owner) !== task.request.sessionId) {
      void this.revoke('OWNER_LOST')
      return
    }
    if (task.lease?.guest.isDestroyed()) {
      void this.revoke('LEASE_RELEASED')
      return
    }
    if (task.phase === 'preparing') {
      // Only the new guest opened for this request may be associated by attach().
      if (task.lease === undefined) return
      if (task.lease.guest.isLoadingMainFrame()) return
      const id = targetVideoId(task.lease.guest.getURL())
      if (id === undefined) return
      const expected = targetVideoId(task.request.url)
      if (expected !== undefined && expected !== id) {
        void this.revoke('TARGET_MISMATCH')
        return
      }
      task.target = id
      task.phase = 'ready'
      const reply = task.reply
      task.reply = undefined
      reply?.({ type: 'douyin-browser-result', requestId: task.request.requestId, code: 'PREPARED', targetVideoId: id })
    } else if (
      task.lease?.guest.isDestroyed() ||
      task.lease === undefined ||
      targetVideoId(task.lease.guest.getURL()) !== task.target
    )
      void this.revoke('TARGET_CHANGED')
    else if (task.phase === 'observing') {
      if (task.provider !== undefined)
        void this.chooseProvider(task).catch(() => {
          if (this.task === task) void this.revoke('PROVIDER_SOURCE_REJECTED')
        })
      else if (task.response !== undefined)
        void this.choose(task).catch(() => {
          if (this.task === task) void this.revoke('UNSUPPORTED_MEDIA_ASSOCIATION')
        })
    }
  }

  /** @param lease - new main-owned guest. */
  attached(lease: DouyinGuest): void {
    const task = this.task
    if (
      task?.phase === 'preparing' &&
      task.lease === undefined &&
      douyinGuestMatches(lease, task.owner, task.request.sessionId, task.request.cwd)
    )
      task.lease = lease
  }

  /** @param lease - released guest. */
  released(lease: DesktopBrowserLeaseId): void {
    if (this.task?.lease?.lease === lease) void this.revoke('LEASE_RELEASED')
  }

  /** @param details - ordinary response metadata from the leased session. */
  response(details: OnResponseStartedListenerDetails): void {
    const task = this.task
    if (
      task === undefined ||
      task.lease === undefined ||
      task.lease.guest.id !== details.webContentsId ||
      !douyinMedia(details.url)
    )
      return
    const type =
      Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.[0] ??
      ''
    if (task.phase === 'downloading') {
      if ([200, 206].includes(details.statusCode) && /^video\/mp4(?:;|$)/i.test(type)) {
        task.transferResponses ??= new Map()
        if (task.transferResponses.size < 16) task.transferResponses.set(details.url, details.statusCode)
      } else if (details.url === task.selectedURL || task.item?.getURLChain().includes(details.url))
        void this.revoke([200, 206].includes(details.statusCode)
          ? 'DOWNLOAD_MIME_REJECTED' : `DOWNLOAD_HTTP_${details.statusCode}`)
      return
    }
    if (task.phase !== 'observing' || ![200, 206].includes(details.statusCode) || details.resourceType !== 'media')
      return
    if (!/^video\/mp4(?:;|$)/i.test(type)) return
    task.response = { url: details.url, status: details.statusCode }
    void this.choose(task).catch(() => {
      if (this.task === task) void this.revoke('UNSUPPORTED_MEDIA_ASSOCIATION')
    })
  }

  private isCurrent(task: Task, phase: Task['phase']): boolean {
    return this.task === task && task.phase === phase
  }

  private async choose(task: Task): Promise<void> {
    if (task.checking || task.phase !== 'observing' || task.lease === undefined || task.response === undefined) return
    if (task.lease.guest.isLoadingMainFrame()) return
    task.checking = true
    const observed = task.response
    const epoch = task.documentEpoch
    let player: unknown
    try {
      player = await task.lease.guest.executeJavaScript(DOUYIN_PLAYER_PROBE)
    } finally {
      task.checking = false
    }
    if (!this.isCurrent(task, 'observing') || task.documentEpoch !== epoch) return
    if (typeof player === 'object' && player !== null && 'unsupported' in player) {
      if (player.unsupported !== 'PAGE_METADATA' || task.providerAvailable === false)
        void this.revoke('UNSUPPORTED_MEDIA_ASSOCIATION')
      return
    }
    if (
      typeof player !== 'object' ||
      player === null ||
      !('id' in player) ||
      !('src' in player) ||
      player.id !== task.target ||
      player.src !== observed.url ||
      targetVideoId(task.lease.guest.getURL()) !== task.target
    )
      return
    task.directory = stagingDirectory(task.request.cwd, task.request.taskId)
    task.selectedURL = observed.url
    task.association = 'player-exact'
    task.phase = 'downloading'
    task.providerResponses?.close()
    task.lease.guest.downloadURL(observed.url)
  }

  private async chooseProvider(task: Task): Promise<void> {
    if (task.checking || task.phase !== 'observing' || task.lease === undefined || task.provider === undefined) return
    if (task.lease.guest.isLoadingMainFrame()) return
    task.checking = true
    const source = task.provider,
      epoch = task.documentEpoch
    let failureCode = 'PLAYER_PROBE_UNAVAILABLE'
    try {
      const player: unknown = await task.lease.guest.executeJavaScript(PROVIDER_PLAYER_PROBE)
      if (
        !this.isCurrent(task, 'observing') ||
        task.documentEpoch !== epoch ||
        source.documentEpoch !== epoch ||
        targetVideoId(task.lease.guest.getURL()) !== source.targetVideoId
      )
        return
      if (typeof player !== 'object' || player === null) return
      const facts = player as Record<string, unknown>
      if (facts.protected || facts.sourceSupported === false) {
        void this.revoke('PROTECTED_OR_UNSUPPORTED_MEDIA')
        return
      }
      if (
        facts.sourceSupported !== true ||
        typeof facts.duration !== 'number' ||
        !Number.isFinite(facts.duration) ||
        Math.abs(facts.duration - source.durationMs / 1000) > 0.25
      )
        return
      const url = typeof facts.src === 'string' && source.urls.includes(facts.src) ? facts.src : source.urls[0]
      if (url === undefined) return
      failureCode = 'MEDIA_DNS_UNAVAILABLE'
      if (!(await this.publicHost(url, task.lease.guest))) {
        void this.revoke('PRIVATE_MEDIA_ADDRESS')
        return
      }
      if (
        !this.isCurrent(task, 'observing') ||
        task.documentEpoch !== epoch ||
        this.active.get(task.owner) !== task.request.sessionId ||
        task.lease.guest.isDestroyed() ||
        targetVideoId(task.lease.guest.getURL()) !== source.targetVideoId
      )
        return
      failureCode = 'MEDIA_STAGING_UNAVAILABLE'
      task.directory = stagingDirectory(task.request.cwd, task.request.taskId)
      task.selectedURL = url
      task.association = 'provider-detail-verified'
      task.phase = 'downloading'
      task.providerResponses?.close()
      failureCode = 'NATIVE_DOWNLOAD_UNAVAILABLE'
      task.lease.guest.downloadURL(url)
    } catch (_error) {
      if (this.task === task) void this.revoke(failureCode)
    } finally {
      task.checking = false
    }
  }

  /** @param item - native attempt. @param guest - initiating guest. @returns true only for the exact unused ticket. */
  accept(item: DownloadItem, guest: WebContents): boolean {
    const task = this.task
    const target = task?.target
    if (
      target === undefined ||
      task?.phase !== 'downloading' ||
      task.item !== undefined ||
      task.lease?.guest !== guest ||
      item.getURLChain()[0] !== task.selectedURL ||
      item.getURL() !== item.getURLChain().at(-1) ||
      task.directory === undefined ||
      !this.validChain(item.getURLChain()) ||
      targetVideoId(guest.getURL()) !== task.target
    )
      return false
    if (task.association === 'provider-detail-verified' && !/^video\/mp4(?:;|$)/i.test(item.getMimeType())) {
      void this.revoke('DOWNLOAD_MIME_REJECTED')
      return false
    }
    if (item.getTotalBytes() > task.request.maxDownloadBytes) {
      void this.revoke('SIZE_LIMIT')
      return false
    }
    task.item = item
    const completion = Promise.withResolvers<void>()
    task.completion = completion.promise
    item.setSavePath(join(task.directory, 'video.mp4'))
    item.on('updated', (_event, state) => {
      if (this.task !== task) return
      if (state === 'interrupted' || item.getReceivedBytes() > task.request.maxDownloadBytes || !this.validChain(item.getURLChain()))
        void this.revoke('DOWNLOAD_INTERRUPTED')
    })
    item.once('done', (_event, state) => {
      completion.resolve()
      if (this.task !== task) {
        this.cleanup(task)
        return
      }
      if (
        state !== 'completed' ||
        item.getReceivedBytes() <= 0 ||
        item.getReceivedBytes() > task.request.maxDownloadBytes ||
        (item.getTotalBytes() > 0 && item.getTotalBytes() !== item.getReceivedBytes()) ||
        !this.validChain(item.getURLChain()) ||
        item.getURLChain()[0] !== task.selectedURL ||
        item.getURL() !== item.getURLChain().at(-1) ||
        guest.isDestroyed() ||
        targetVideoId(guest.getURL()) !== task.target ||
        this.active.get(task.owner) !== task.request.sessionId ||
        (task.association === 'provider-detail-verified' && !task.transferResponses?.has(item.getURL()))
      ) {
        void this.revoke('INCOMPLETE_MEDIA')
        return
      }
      task.phase = 'staged'
      const reply = task.reply
      task.reply = undefined
      reply?.({
        type: 'douyin-browser-result',
        requestId: task.request.requestId,
        code: 'STAGED',
        targetVideoId: target,
        path: join(task.directory ?? '', 'video.mp4'),
        evidence: {
          responseStatus:
            task.association === 'provider-detail-verified'
              ? (task.transferResponses?.get(item.getURL()) ?? 0)
              : (task.response?.status ?? 0),
          mediaHost: new URL(task.selectedURL ?? '').hostname,
          mediaUrlHash: mediaURLHash(task.selectedURL ?? ''),
          association: task.association ?? 'player-exact',
          currentSrcMatched: task.association === 'player-exact',
          ...(task.association === 'provider-detail-verified' && task.provider !== undefined
            ? {
              provider: {
                detailResponseStatus: 200,
                detailHost: 'www.douyin.com',
                detailPath: '/aweme/v1/web/aweme/detail/',
                targetVideoId: task.provider.targetVideoId,
                sourceField: task.provider.sourceField,
                durationMs: task.provider.durationMs,
                width: task.provider.width,
                height: task.provider.height,
                documentEpoch: task.provider.documentEpoch,
              },
            }
            : {}),
        },
      })
    })
    return true
  }

  /**
   * @param url - request or redirect.
   * @param guestId - Chromium initiator when present.
   * @returns whether an active native transfer must be denied.
   */
  blocks(url: string, guestId?: number): boolean {
    const task = this.task
    return (
      task?.phase === 'downloading' &&
      (guestId === undefined || guestId === task.lease?.guest.id) &&
      !douyinMedia(url) &&
      !douyinPage(url)
    )
  }

  /**
   * @param url - native request/redirect URL.
   * @param guestId - initiating guest.
   * @returns whether the active transfer must be denied after DNS checks.
   */
  async blocksRequest(url: string, guestId?: number): Promise<boolean> {
    if (this.blocks(url, guestId)) return true
    const task = this.task
    if (
      task?.phase !== 'downloading' ||
      !douyinMedia(url) ||
      (guestId !== undefined && guestId !== task.lease?.guest.id)
    )
      return false
    if (task.lease === undefined) return true
    try {
      if (!(await this.publicHost(url, task.lease.guest))) {
        if (this.task === task) void this.revoke('PRIVATE_MEDIA_ADDRESS')
        return true
      }
    } catch (_error) {
      if (this.task === task) void this.revoke('MEDIA_DNS_UNAVAILABLE')
      return true
    }
    return !this.isCurrent(task, 'downloading')
  }

  private async publicHost(url: string, guest: WebContents): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const addresses = await Promise.race([
        this.addresses === undefined
          ? guest.session.resolveHost(new URL(url).hostname).then(result => result.endpoints.map(v => v.address))
          : this.addresses(new URL(url).hostname),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('DNS timeout'))
          }, 5000)
        }),
      ])
      return addresses.length > 0 && addresses.length <= 32 && addresses.every(publicMediaAddress)
    } finally {
      clearTimeout(timeout)
    }
  }

  private validChain(urls: string[]): boolean {
    return urls.length > 0 && urls.length <= 6 && urls.every(douyinMedia)
  }

  /** Revoke on Host termination; no transfer survives its owning Host. */
  dispose(): Promise<void> {
    this.active.clear()
    const revoked = this.revoke('HOST_DISCONNECTED')
    return Promise.all([...this.cleanups, revoked]).then(() => {})
  }

  private revoke(code: string): Promise<void> {
    const task = this.task
    if (task === undefined) return Promise.resolve()
    this.task = undefined
    try {
      this.onRevoked?.(task.request.taskId, code)
    } catch (_error) {
      /* Revocation cannot be interrupted by the child notification. */
    }
    clearTimeout(task.timer)
    clearInterval(task.poll)
    task.providerResponses?.close()
    if (task.navigation !== undefined && !task.lease?.guest.isDestroyed())
      task.lease?.guest.removeListener('did-start-navigation', task.navigation)
    const reply = task.reply
    task.reply = undefined
    reply?.({ type: 'douyin-browser-result', requestId: task.request.requestId, code })
    if (task.item !== undefined && task.item.getState() === 'progressing') task.item.cancel()
    const cleanup = (task.completion ?? Promise.resolve()).then(() => {
      this.cleanup(task)
    })
    this.cleanups.add(cleanup)
    return cleanup.finally(() => {
      this.cleanups.delete(cleanup)
    })
  }

  private cleanup(task: Task): void {
    if (task.directory === undefined) return
    const directory = task.directory
    if (
      resolve(directory) !== directory ||
      directory !== join(task.request.cwd, 'source', 'media', 'douyin', `.native-${task.request.taskId}`)
    )
      return
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch (_error) {
      /* Task directory cleanup can be retried after native file handles close. */
    }
  }
}
