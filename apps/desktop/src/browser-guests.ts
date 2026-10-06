/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type {
  DesktopBrowserLeaseId,
  DesktopBrowserOpenRequest,
  DesktopBrowserReservation,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'
import { DesktopDouyinDownloads } from './douyin-downloads.ts'
import { DesktopDouyinData } from './douyin-data.ts'
import type { DouyinDesktopRequest, DouyinDesktopResult, DouyinDesktopDataRequest, DouyinDesktopDataResult } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { douyinStorageNavigation, douyinStoragePartition } from './douyin-storage.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
  readonly workspace: string
  readonly sessionId: string | undefined
  readonly douyin: boolean
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  readonly downloads = new DesktopDouyinDownloads((owner, sessionId, url) => {
    owner.send(DESKTOP_IPC.browserDownloadPage, { sessionId, url })
  })
  readonly observations = new DesktopDouyinData((owner, sessionId, url) => {
    owner.send(DESKTOP_IPC.browserDownloadPage, { sessionId, url })
  }, () => this.downloads.isActive)

  /** @param owner - authenticated application. @param request - validated Host operation. @returns task answer. */
  download(owner: WebContents, request: DouyinDesktopRequest): Promise<DouyinDesktopResult> {
    if (request.action === 'prepare' && this.observations.isActive) return Promise.resolve({
      type: 'douyin-browser-result', requestId: request.requestId, code: 'BUSY',
    })
    return this.downloads.request(owner, request)
  }

  /**
   * @param owner - Authenticated application.
   * @param request - Validated data operation.
   * @returns Sanitized exact-work page facts.
   */
  data(owner: WebContents, request: DouyinDesktopDataRequest): Promise<DouyinDesktopDataResult> {
    return this.observations.request(owner, request)
  }

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined) {}

  /**
   * Reserve one guest; official Douyin tabs retain workspace login across restarts.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @param sessionId - owning Session identity.
   * @param initialUrl - requested first page; only official video pages select persistent storage.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(
    owner: WebContents,
    workspace: unknown,
    sessionId?: unknown,
    initialUrl?: unknown,
  ): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256))
      throw new Error('Invalid browser Session')
    if (initialUrl !== undefined && (typeof initialUrl !== 'string' || initialUrl.length > 8192))
      throw new Error('Invalid initial browser URL')
    const persistent = douyinStoragePartition(workspace, initialUrl)
    const storageKey = persistent ?? workspace
    let partition = this.partitions.get(storageKey)
    if (partition === undefined) {
      partition = persistent ?? `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(storageKey, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, {
      owner,
      partition,
      attached: false,
      workspace,
      sessionId,
      douyin: persistent !== undefined,
    })
    return { lease, partition }
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    this.downloads.released(key)
    this.observations.released(key)
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => {
        guest.once('destroyed', resolve)
      })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id =
        typeof params.src === 'string' && params.src.startsWith('about:blank#')
          ? params.src.slice('about:blank#'.length)
          : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        plugins: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        this.downloads.attached({ lease: id, owner, guest, workspace: lease.workspace, sessionId: lease.sessionId })
        this.observations.attached({ lease: id, owner, guest, workspace: lease.workspace, sessionId: lease.sessionId })
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => {
          this.downloads.released(id)
          this.observations.released(id)
          lease.releaseInput?.()
          this.leases.delete(id)
        })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (
          attachedLease !== undefined &&
          lease?.guest === guest &&
          lease.owner === owner &&
          !owner.isDestroyed() &&
          postBody === undefined &&
          this.allowedNavigation(url)
        ) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (
          event.isMainFrame &&
          (!this.allowedNavigation(event.url) || (lease?.douyin && !douyinStorageNavigation(event.url)))
        )
          event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (mainFrame && (!this.allowedNavigation(url) || (lease?.douyin && !douyinStorageNavigation(url))))
          event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => {
        event.preventDefault()
      })
      guest.on('login', (event, _details, _authInfo, callback) => {
        event.preventDefault()
        callback()
      })
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner)
          void this.release(owner, id).catch((error: unknown) => {
            console.error(error)
          })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => {
      callback({})
    })
    browserSession.on('will-download', (event, item, guest) => {
      if (!this.downloads.accept(item, guest)) event.preventDefault()
    })
    browserSession.webRequest.onResponseStarted((details) => {
      this.downloads.response(details)
    })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      const denied = network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol)
      if (denied) {
        callback({ cancel: true })
        return
      }
      void this.downloads.blocksRequest(details.url, details.webContentsId).then(
        (cancel) => {
          callback({ cancel })
        },
        () => {
          callback({ cancel: true })
        },
      )
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username === '' &&
      url.password === '' &&
      !this.isApplicationHost(url)
    )
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return (
      url.port === host.port &&
      (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  }
}
