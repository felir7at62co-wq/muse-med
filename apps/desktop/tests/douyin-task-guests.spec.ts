/** Main task windows keep the existing guest isolation and workspace storage policy without Renderer authority. */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { DouyinDesktopRequest } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const electron = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  let serial = 0
  class Contents extends EventEmitter {
    readonly id = ++serial
    url = 'about:blank'
    destroyed = false
    readonly setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => { action: string }) => handler)
    readonly executeJavaScript = vi.fn(async (): Promise<unknown> => false)
    readonly downloadURL = vi.fn()
    readonly send = vi.fn()
    isDestroyed() { return this.destroyed }
    getURL() { return this.url }
    isLoadingMainFrame() { return false }
    async loadURL(url: string) { this.url = url; this.emit('did-start-navigation', {}, url, false, true) }
  }
  class Window extends EventEmitter {
    static readonly windows: Window[] = []
    readonly webContents = new Contents()
    destroyed = false
    constructor(readonly options: BrowserWindowConstructorOptions) { super(); Window.windows.push(this) }
    destroy() { this.destroyed = true; this.webContents.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed') }
  }
  const fromPartition = vi.fn(() => ({
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(), on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn(), onResponseStarted: vi.fn() },
  }))
  return { Window, fromPartition }
})
vi.mock('electron', () => ({ app: { isPackaged: true }, BrowserWindow: electron.Window, session: { fromPartition: electron.fromPartition } }))
const { DesktopDouyinTaskGuests } = await import('../src/douyin-task-guests.ts')
const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')

let root: string
const page = 'https://www.douyin.com/video/7692443246022167851'
function owner() { return Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() }) }
function request(): DouyinDesktopRequest {
  return { type: 'douyin-browser', requestId: randomUUID(), taskId: randomUUID() as never, action: 'prepare',
    sessionId: 'session-a', cwd: root, url: page, maxDownloadBytes: 1024, nativeTimeoutMs: 1000, background: true }
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'task-guest-'))); vi.useFakeTimers() })
afterEach(async () => {
  for (const window of electron.Window.windows.splice(0)) if (!window.destroyed) window.destroy()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers(); vi.clearAllMocks(); rmSync(root, { recursive: true, force: true })
})

it('shares the existing persistent workspace account but never opens or relies on a Sidebar guest', async () => {
  const contents = owner(), browser = new DesktopBrowserGuests(() => 'http://127.0.0.1:1234/')
  const sidebar = browser.acquire(contents as never, `cwd:${root}`, 'session-a', page)
  const pending = browser.download(contents as never, request())
  await vi.advanceTimersByTimeAsync(200)
  expect((await pending).code).toBe('PREPARED')
  const window = electron.Window.windows.at(-1)
  expect(window?.options.show).toBe(false)
  expect(window?.options.focusable).toBe(false)
  expect(window?.options.webPreferences).toMatchObject({ partition: sidebar.partition, backgroundThrottling: false,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    sandbox: true, contextIsolation: true, webSecurity: true, webviewTag: false, disableDialogs: true,
    plugins: false, navigateOnDragDrop: false, allowRunningInsecureContent: false, devTools: false })
  expect(window?.options.webPreferences?.preload).toBeUndefined()
  expect(contents.send).not.toHaveBeenCalled()
  browser.downloads.activeSession(contents as never, 'session-b')
  await browser.release(contents as never, sidebar.lease)
  await vi.advanceTimersByTimeAsync(100)
  expect(window?.destroyed).toBe(false)
  expect(browser.downloads.isActive).toBe(true)
  await browser.downloads.dispose()
  expect(window?.destroyed).toBe(true)
})

it.each(['navigation', 'redirect', 'popup', 'nested', 'login', 'owner', 'renderer'] as const)(
  'denies or releases a private task guest on %s', async (reason) => {
    const released = vi.fn(), contents = owner(), operation = request()
    const manager = new DesktopDouyinTaskGuests(() => 'persist:fixture', url => !url.includes('127.0.0.1'), released)
    const lease = manager.open(contents as never, operation)
    const window = electron.Window.windows.at(-1)
    if (window === undefined) throw new Error('Missing Main-owned task window')
    await vi.advanceTimersByTimeAsync(0)
    expect(lease.taskId).toBe(operation.taskId)
    expect(lease.prepareRequestId).toBe(operation.requestId)
    expect(lease.workspace).toBe(`cwd:${root}`)
    const prevented = { preventDefault: vi.fn(), isMainFrame: true, url: 'http://127.0.0.1:1234/private' }
    if (reason === 'navigation') window.webContents.emit('will-frame-navigate', prevented)
    if (reason === 'redirect') window.webContents.emit('will-redirect', prevented, 'https://evil.example/', false, true)
    if (reason === 'popup') expect(window.webContents.setWindowOpenHandler.mock.calls[0]?.[0]({ url: page })).toEqual({ action: 'deny' })
    if (reason === 'nested') window.webContents.emit('will-attach-webview', prevented)
    if (reason === 'login') window.webContents.emit('login', prevented, {}, {}, vi.fn())
    if (reason === 'owner') contents.emit('destroyed')
    if (reason === 'renderer') contents.emit('render-process-gone')
    if (reason === 'popup' || reason === 'nested') {
      expect(released).not.toHaveBeenCalled()
      if (reason === 'nested') expect(prevented.preventDefault).toHaveBeenCalledOnce()
    } else {
      await vi.advanceTimersByTimeAsync(0)
      expect(released).toHaveBeenCalledOnce()
      expect(window.destroyed).toBe(true)
      if (reason === 'login') expect(released).toHaveBeenCalledWith(lease.lease, 'LOGIN_OR_VERIFICATION_REQUIRED')
    }
    await lease.close()
    expect(window.destroyed).toBe(true)
  },
)

it('closes before a queued initial navigation when the owning task is cancelled immediately', async () => {
  const manager = new DesktopDouyinTaskGuests(() => 'persist:fixture', () => true, vi.fn())
  const lease = manager.open(owner() as never, request())
  await lease.close()
  expect(lease.guest.getURL()).toBe('about:blank')
  expect(lease.guest.isDestroyed()).toBe(true)
})
