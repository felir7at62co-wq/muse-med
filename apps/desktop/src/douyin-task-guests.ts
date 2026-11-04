/** Main-owned Douyin task guests share workspace login storage without accepting Renderer reservations. */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { app, BrowserWindow, type WebContents, type WebPreferences } from 'electron'
import type { DesktopBrowserLeaseId, DouyinDesktopRequest, DouyinTaskId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DouyinGuest } from './douyin-downloads.ts'
import { douyinStorageNavigation } from './douyin-storage.ts'

/** A private task reservation never enters the Renderer-facing Sidebar lease roster. */
export interface DouyinTaskGuest extends DouyinGuest {
  readonly taskId: DouyinTaskId
  readonly prepareRequestId: string
  /** @returns Completion after the owned hidden window and its navigation have settled. */
  close(): Promise<void>
  /** @returns Whether a rendered login or verification gate requires the user; never submits a challenge. */
  needsUserAction(): Promise<boolean>
}

/**
 * Apply the same fixed isolation policy to Sidebar and task documents.
 * @param partition - Main-selected workspace storage account.
 * @returns Preferences without preload, Node integration or nested guests.
 */
export function isolatedBrowserPreferences(partition: string): WebPreferences {
  return { partition, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true, devTools: !app.isPackaged }
}

// Only rendered dialogs and explicit challenge containers count; ordinary page login links do not.
const USER_ACTION_PROBE = `(() => {
  const visible = element => { const box=element.getBoundingClientRect(); const style=getComputedStyle(element);
    return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none'; };
  const selectors=['[data-e2e="login-modal"]','[data-e2e="login-dialog"]','#captcha_container','.captcha_verify_container',
    '[role="dialog"][class*="login"]','[role="dialog"][class*="verify"]','[role="dialog"][class*="captcha"]'];
  return selectors.some(selector=>Array.from(document.querySelectorAll(selector)).some(visible));
})()`

/** Creates hidden windows only for authenticated Host requests admitted by the native download controller. */
export class DesktopDouyinTaskGuests {
  /**
   * @param partition - Main-owned storage resolver.
   * @param allowedNavigation - Existing application navigation policy.
   * @param released - Revokes the matching native task.
   */
  constructor(
    private readonly partition: (workspace: string, url: string) => string,
    private readonly allowedNavigation: (url: string) => boolean,
    private readonly released: (lease: DesktopBrowserLeaseId, code: string) => void,
  ) {}

  /**
   * Reserve a task guest independently from selected chats and Sidebar attachment events.
   * @param owner - Authenticated application window, retained as the task's lifecycle owner.
   * @param request - Validated private Host prepare request.
   * @returns Main-issued task identity and an awaited window disposer.
   */
  open(owner: WebContents, request: DouyinDesktopRequest): DouyinTaskGuest {
    if (owner.isDestroyed() || request.background !== true || request.action !== 'prepare') throw new Error('Invalid background task owner')
    const workspace = `cwd:${realpathSync(request.cwd)}`
    const partition = this.partition(workspace, request.url)
    const window = new BrowserWindow({ show: false, width: 1200, height: 800, focusable: false, skipTaskbar: true,
      webPreferences: { ...isolatedBrowserPreferences(partition), backgroundThrottling: false } })
    const guest = window.webContents
    const lease = randomUUID() as DesktopBrowserLeaseId
    let closing: Promise<void> | undefined
    const isClosing = (): boolean => closing !== undefined
    let navigation: Promise<void> = Promise.resolve()
    let notified = false
    const notify = (code: string): void => { if (!notified) { notified = true; this.released(lease, code) } }
    const close = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
      owner.removeListener('destroyed', ownerLost)
      owner.removeListener('render-process-gone', ownerLost)
      owner.removeListener('did-start-navigation', ownerNavigation)
      if (!guest.isDestroyed()) {
        const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
        window.destroy()
        await destroyed
      }
      await navigation
    })
    const ownerLost = (): void => { notify('OWNER_LOST'); void close() }
    const ownerNavigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (mainFrame && !inPlace) ownerLost()
    }
    owner.once('destroyed', ownerLost)
    owner.on('render-process-gone', ownerLost)
    owner.on('did-start-navigation', ownerNavigation)
    guest.once('destroyed', () => { notify('LEASE_RELEASED'); void close() })
    guest.on('render-process-gone', () => { notify('LEASE_RELEASED'); void close() })
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    const admit = (url: string): boolean => this.allowedNavigation(url) && douyinStorageNavigation(url)
    guest.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && !admit(event.url)) { event.preventDefault(); notify('NAVIGATION_REJECTED'); void close() }
    })
    guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !admit(url)) { event.preventDefault(); notify('NAVIGATION_REJECTED'); void close() }
    })
    guest.on('will-attach-webview', (event) => { event.preventDefault() })
    guest.on('login', (event, _details, _authInfo, callback) => {
      event.preventDefault(); callback(); notify('LOGIN_OR_VERIFICATION_REQUIRED'); void close()
    })
    navigation = Promise.resolve().then(async () => {
      if (guest.isDestroyed() || isClosing()) return
      try { await guest.loadURL(request.url) }
      catch (_error) { if (!isClosing()) { notify('BROWSER_NAVIGATION_FAILED'); void close() } }
    })
    return { lease, owner, guest, workspace, sessionId: request.sessionId, taskId: request.taskId,
      prepareRequestId: request.requestId, close,
      needsUserAction: async () => {
        if (guest.isDestroyed() || guest.isLoadingMainFrame()) return false
        const url = new URL(guest.getURL())
        if (/\/(?:passport|login|verify|captcha)(?:\/|$)/.test(url.pathname)) return true
        const value: unknown = await guest.executeJavaScript(USER_ACTION_PROBE)
        return value === true
      } }
  }
}
