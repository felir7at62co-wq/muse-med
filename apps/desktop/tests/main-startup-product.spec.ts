// Product-owned Desktop startup cases: product home and media environment, window identity, the
// plugin window's IPC surface including the profile reset channel, the prepared-profile invariant,
// guarded shell publications, and the native recovery actions. The Electron shell lifecycle suite
// kept from upstream lives in `main-startup.spec.ts`.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { MessageBoxOptions } from 'electron'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { en } from '../src/locale.ts'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const { tmpdir } = await import('node:os')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const paths = await import('node:path')
  // The shell reads its own package.json from the application path; keep it in the OS temp directory
  // so a test run never writes into the repository.
  const appRoot = mkdtempSync(paths.join(tmpdir(), 'dsh-desktop-test-app-'))
  writeFileSync(paths.join(appRoot, 'package.json'), '{"name":"dsh-desktop-test","version":"1.0.0"}\n')
  writeFileSync(paths.join(appRoot, 'muse-product.json'), '{"version":"1.0.0-beta.1"}\n')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  const hosts: FakeHost[] = []
  const mutations: unknown[] = []
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const handlers = new Map<string, (event: { senderFrame: { url: string } }, ...args: unknown[]) => unknown>()
  let pluginsEnabled = false
  let resets = 0
  let managerConstructions = 0
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let errorPublished = deferred()
  let dialogShown = deferred()
  let quitCompleted = deferred()
  let welcomeState = { loggedIn: false, hasApiKey: true, writable: true, localePreference: null as string | null }
  let updatePublish: ((state: { phase: string; percent?: number }) => unknown) | undefined
  class FakeWindow extends EventEmitter {
    destroyed = false
    contentsDestroyed = false
    readonly urls: string[] = []
    readonly shown = deferred()
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 1,
      mainFrame: { url: '' },
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      insertCSS: vi.fn(async () => 'inserted'),
      removeInsertedCSS: vi.fn(async () => {}),
      setIgnoreMenuShortcuts: vi.fn(),
      sendInputEvent: vi.fn(),
      focus: vi.fn(),
      isFocused: () => true,
      getZoomFactor: () => 1,
      getURL: () => this.urls.at(-1) ?? '',
      isDestroyed: () => this.contentsDestroyed,
      send: vi.fn((channel: string, state: { phase?: string }) => {
        if (this.contentsDestroyed || this.destroyed) throw new TypeError('Object has been destroyed')
        if (channel === 'dsh-desktop:backend-state' && state.phase === 'error') errorPublished.resolve()
      }),
    })
    readonly show = vi.fn(() => { this.visible = true; this.shown.resolve() })
    readonly showInactive = vi.fn(() => { this.visible = true; this.shown.resolve() })
    readonly setSize = vi.fn()
    readonly setTitle = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    visible = true
    readonly hide = vi.fn(() => { this.visible = false })
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 820 }))
    readonly isVisible = vi.fn(() => this.visible)
    readonly isFullScreen = vi.fn(() => false)
    readonly setFullScreen = vi.fn()
    readonly setBounds = vi.fn()
    readonly setMinimumSize = vi.fn()
    readonly setBackgroundColor = vi.fn()
    readonly setTitleBarOverlay = vi.fn()
    readonly setVibrancy = vi.fn()
    readonly moveTop = vi.fn()
    constructor(readonly options: { show: boolean } & Record<string, unknown>) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    async loadURL(url: string) {
      this.urls.push(url)
      this.webContents.mainFrame.url = url
    }
    async loadFile(file: string) { this.urls.push(file) }
    static getAllWindows() { return windows.filter(window => !window.destroyed) }
    destroy() { this.destroyed = true; this.emit('closed') }
    close() {
      const event = { preventDefault: vi.fn() }
      this.emit('close', event)
      if (event.preventDefault.mock.calls.length === 0) this.destroy()
    }
  }
  class FakeHost {
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    readonly inspectQuit = vi.fn(async () => ({ activeTasks: false, scheduledTasks: false }))
    readonly start = vi.fn(async () => {
      hostStarted.resolve()
      await this.ready.promise
      return { url: 'http://127.0.0.1:9/', injections: [] }
    })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    constructor(
      readonly node: string, readonly runtime: string, readonly profile: string,
      readonly inspectPort?: number, readonly environment?: NodeJS.ProcessEnv,
      readonly onFailure?: (error: Error) => void, readonly primaryRuntime?: string,
    ) { hosts.push(this) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en-US',
    getVersion: () => '1.0.0',
    getAppPath: () => appRoot,
    getPath: (name: string) => `${tmpdir()}/dsh-desktop-test-logs/${name}`,
    setAppLogsPath: vi.fn(),
    // The shell claims the product's Electron identity before it reads any path,
    // so the double has to answer the calls that carries.
    setName: vi.fn(),
    setPath: vi.fn(),
    commandLine: { hasSwitch: () => false },
    getPreferredSystemLanguages: () => ['en-US'],
    requestSingleInstanceLock: () => true,
    focus: vi.fn(),
    setAboutPanelOptions: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(() => true),
    exit: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) quitCompleted.resolve()
    }),
  })
  const disableAllPlugins = vi.fn(async () => {
    pluginsEnabled = false
    return 'desktop-test-profile/cordis.patch.yml.bak-1'
  })
  return {
    windows, hosts, mutations, listeners, handlers, app, appRoot, FakeWindow, FakeHost, disableAllPlugins,
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
    openExternal: vi.fn(async () => {}),
    clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
    nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
    nativeTheme: { shouldUseDarkColors: false, themeSource: 'system' },
    net: { fetch: vi.fn(async () => new Response('', { status: 200 })) },
    powerMonitor: new EventEmitter(),
    session: {
      defaultSession: {
        cookies: { get: vi.fn(async () => []) },
        webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        closeAllConnections: vi.fn(async () => {}),
      },
    },
    catalog: vi.fn(async () => ({ bundled: [], plugins: [] })),
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    assertProfileRuntime: vi.fn(),
    canRecoverProfile: vi.fn(() => true),
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted },
    get errorPublished() { return errorPublished }, get dialogShown() { return dialogShown },
    get quitCompleted() { return quitCompleted },
    nextHostStart() { hostStarted = deferred(); return hostStarted.promise },
    noteReset() { resets += 1 },
    get resets() { return resets },
    countManager() { managerConstructions += 1 },
    get managerConstructions() { return managerConstructions },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    get welcomeState() { return welcomeState },
    set welcomeState(value: { loggedIn: boolean; hasApiKey: boolean; writable: boolean; localePreference: string | null }) {
      welcomeState = value
    },
    set updatePublish(value: (state: { phase: string; percent?: number }) => unknown) { updatePublish = value },
    get updatePublish(): (state: { phase: string; percent?: number }) => unknown {
      if (updatePublish === undefined) throw new Error('desktop update coordinator was not constructed')
      return updatePublish
    },
    reset() {
      windows.length = 0; hosts.length = 0; mutations.length = 0
      listeners.clear(); handlers.clear(); app.removeAllListeners()
      app.isPackaged = true
      pluginsEnabled = false
      resets = 0
      managerConstructions = 0
      welcomeState = { loggedIn: false, hasApiKey: true, writable: true, localePreference: null }
      updatePublish = undefined
      preparing = deferred(); prepared = deferred(); hostStarted = deferred()
      errorPublished = deferred(); dialogShown = deferred(); quitCompleted = deferred()
    },
  }
})

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  clipboard: harness.clipboard,
  dialog: harness.dialog,
  ipcMain: {
    handle: (channel: string, handler: (event: { senderFrame: { url: string } }, ...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler)
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      harness.listeners.set(channel, listener)
    },
    removeHandler: vi.fn(),
  },
  Menu: harness.menu,
  nativeImage: harness.nativeImage,
  nativeTheme: harness.nativeTheme,
  net: harness.net,
  powerMonitor: harness.powerMonitor,
  session: harness.session,
  shell: { openExternal: harness.openExternal },
  Tray: class {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly setImage = vi.fn()
    readonly popUpContextMenu = vi.fn()
    readonly destroy = vi.fn()
    on = vi.fn()
    relabel = vi.fn()
  },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))
// Crash-report persistence has its own spec; here it must resolve inside microtasks so the native
// recovery dialog never outlives the test that opened it.
vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  pruneCrashReports: vi.fn(async () => {}),
  writeCrashReport: vi.fn(async () => 'desktop-test-logs/crash-test.log'),
}))
// The Windows tray acknowledgement is covered by its own spec; window close hides immediately here.
vi.mock('../src/background-notice.ts', () => ({
  DesktopBackgroundNotice: class {
    readonly close = vi.fn((hide: () => void) => { hide() })
    readonly dispose = vi.fn()
  },
}))
vi.mock('../src/welcome-backend.ts', () => ({
  connectDesktopWelcome: async () => ({
    read: async () => harness.welcomeState,
    readLocalePreference: async () => null,
    analyticsEnabled: async () => false,
    save: async () => ({ ok: true }),
    account: {
      watch: () => () => {},
      state: async () => ({ status: 'signed-out', attempt: null }),
      start: async () => { throw new Error('desktop welcome: sign-in is unavailable in this spec') },
      cancel: async () => undefined,
    },
  }),
}))
vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: 'desktop-test-profile' }) }))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    constructor() { harness.countManager() }
    readonly applyRelease = harness.applyRelease
    readonly assertProfileRuntime = harness.assertProfileRuntime
    readonly disableAllPlugins = harness.disableAllPlugins
    canRecoverProfile = harness.canRecoverProfile
    async mutate(mutation: unknown, hooks: { beforeChange(): Promise<void>; afterChange(): Promise<void> }) {
      harness.mutations.push(mutation)
      await hooks.beforeChange()
      harness.pluginsEnabled = false
      await hooks.afterChange()
    }
    async resetConfiguration(hooks: { beforeChange(): Promise<void>; afterChange(): Promise<void> }) {
      harness.noteReset()
      await this.mutate(undefined, hooks)
    }
  },
}))
vi.mock('../src/plugin-catalog.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/plugin-catalog.ts')>(),
  desktopPluginCatalog: harness.catalog,
}))
vi.mock('../src/host-process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/host-process.ts')>(),
  DesktopHostProcess: harness.FakeHost,
}))
vi.mock('../src/web-document.ts', () => ({
  serveWebDocument: vi.fn(async () => new Response('<html></html>', { status: 200 })),
  authenticateWebHost: vi.fn(async () => 'session=test'),
  forwardWebRequest: vi.fn(async () => new Response('', { status: 200 })),
}))
vi.mock('../src/update-coordinator.ts', () => ({
  DesktopUpdateCoordinator: class {
    state: { phase: string; version?: string } = { phase: 'idle' }
    constructor(publish: (state: { phase: string; percent?: number }) => unknown) { harness.updatePublish = publish }
    readonly check = vi.fn(async () => this.state)
    readonly download = vi.fn(async (version: string) => ({ phase: 'ready', version }))
    readonly install = vi.fn(async (version: string) => {
      this.state = { phase: 'ready', version }
      return this.state
    })
    readonly dispose = vi.fn()
  },
}))

type FakeWindowInstance = (typeof harness.windows)[number]
type MenuTemplateItem = { accelerator?: string; click?: () => void; submenu?: MenuTemplateItem[] }

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  return handler({ senderFrame: { url: 'dsh-app://shell/plugin-manager.html' } }, ...args)
}

/** Answer the native recovery dialog with one of its buttons. */
function answerRecovery(response: number): void {
  harness.dialog.showMessageBox.mockImplementation((options: { title?: string }) => {
    if (options.title === en.startupFailed) harness.dialogShown.resolve()
    return Promise.resolve({ response, checkboxChecked: false })
  })
}

/** Let the merged startup settle across the awaits that follow one resolved Host readiness. */
async function flushMicrotasks(): Promise<void> {
  for (let pass = 0; pass < 32; pass += 1) await Promise.resolve()
}

/** Prepare the profile, start the single Host, and wait for the first visible workspace window. */
async function reachWorkspace(): Promise<FakeWindowInstance> {
  await harness.preparing.promise
  harness.prepared.resolve()
  await harness.hostStarted.promise
  const window = harness.windows[0]!
  harness.hosts[0]!.ready.resolve()
  await window.shown.promise
  return window
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  harness.reset()
  // The native recovery dialog stays open until the test chooses an action; every other dialog
  // (quit confirmation, update prompts) answers as cancelled.
  harness.dialog.showMessageBox.mockReset()
  harness.dialog.showMessageBox.mockImplementation((options: { title?: string }) => {
    if (options.title !== en.startupFailed) return Promise.resolve({ response: 1, checkboxChecked: false })
    harness.dialogShown.resolve()
    return new Promise(() => {})
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_CLIENT_COMMIT_HASH', 'abcdef0')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', 'test-primary-runtime')
  vi.stubGlobal('process', { ...process, resourcesPath: 'desktop-test-resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_HOME', 'upstream-dsh-home')
  vi.stubEnv('MUSE_MED_HOME', undefined)
  for (const name of ['PATH', 'Path', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'MUSE_HOME',
    'DSH_FFMPEG_PATH', 'DSH_FFPROBE_PATH', 'FFMPEG_PATH', 'FFPROBE_PATH', 'MUSE_WHISPER_MODEL_DIR', 'MUSE_BGM_RUNTIME_DIR', 'MUSE_FONTS_DIR', 'MUSE_FONT_FAMILY']) {
    vi.stubEnv(name, process.env[name])
  }
})

afterAll(() => { rmSync(harness.appRoot, { recursive: true, force: true }) })

afterEach(async () => {
  harness.prepared.resolve()
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  harness.app.quit()
  // The quit decides asynchronously; a Host that starts meanwhile must still be released.
  await vi.advanceTimersByTimeAsync(0)
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  await harness.quitCompleted.promise
  vi.restoreAllMocks()
  harness.canRecoverProfile.mockReturnValue(true)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop main startup', () => {
  it('exposes catalog reads only to desktop-owned shell documents', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const catalog = harness.handlers.get('dsh-desktop:plugins-catalog')
    expect(catalog).toBeTypeOf('function')
    expect(() => catalog!({ senderFrame: { url: 'dsh-app://app/index.html' } })).toThrow(/rejected IPC/u)
    expect(() => catalog!({ senderFrame: { url: 'https://example.org/plugin-manager.html' } })).toThrow(/rejected IPC/u)
    const sender = { senderFrame: { url: 'dsh-app://shell/plugin-manager.html' } }
    expect(() => catalog!(sender, 'true')).toThrow(/must be a boolean/u)
    expect(harness.catalog).not.toHaveBeenCalled()
    await expect(catalog!(sender, false)).resolves.toEqual({ bundled: [], plugins: [], canInstall: true })
    expect(harness.catalog).toHaveBeenCalledWith(join(harness.appRoot, 'dsh'), 'desktop-test-profile', false)
  })

  it('lets development browse the catalog but still rejects package mutations', async () => {
    harness.app.isPackaged = false
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const sender = { senderFrame: { url: 'dsh-app://shell/plugin-manager.html' } }
    await expect(harness.handlers.get(DESKTOP_IPC.pluginsCatalog)!(sender, false))
      .resolves.toEqual({ bundled: [], plugins: [], canInstall: false })
    await expect(harness.handlers.get(DESKTOP_IPC.pluginsAdd)!(sender, 'safe-plugin'))
      .rejects.toThrow(/require a packaged application/u)
  })

  it('routes every plugin package channel to the profile mutation it names', async () => {
    await import('../src/main.ts')
    await reachWorkspace()
    const sender = { senderFrame: { url: 'dsh-app://shell/plugin-manager.html' } }
    // Every package change stops the Host, rewrites the profile, and starts the Host again, so each
    // call settles only after the replacement child reported readiness.
    const call = async (channel: string, ...args: unknown[]): Promise<void> => {
      const stopped = harness.hosts.at(-1)!
      const started = harness.nextHostStart()
      const pending = Promise.resolve(harness.handlers.get(channel)!(sender, ...args))
      await stopped.stopping.promise
      stopped.exited.resolve()
      await started
      harness.hosts.at(-1)!.ready.resolve()
      await pending
    }
    await call(DESKTOP_IPC.pluginsAdd, 'safe-plugin@1.2.3')
    await call(DESKTOP_IPC.pluginsRemove, 'safe-plugin')
    await call(DESKTOP_IPC.pluginsUpdate, 'safe-plugin', '1.3.0')
    await call(DESKTOP_IPC.pluginsToggle, 'safe-plugin', false)
    await call(DESKTOP_IPC.pluginsDisableAll)
    expect(harness.mutations).toEqual([
      { type: 'plugin-add', spec: 'safe-plugin@1.2.3' },
      { type: 'plugin-remove', name: 'safe-plugin' },
      { type: 'plugin-update', name: 'safe-plugin', version: '1.3.0' },
      { type: 'plugin-toggle', name: 'safe-plugin', enabled: false },
      { type: 'plugins-disable-all' },
    ])
    expect(harness.hosts.length).toBeGreaterThan(1)
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('opens repository links only from the plugin popup and denies arbitrary protocols', async () => {
    // The application menu carries the plugin-window entry where the platform has a menu bar; on
    // Windows the same entry is asserted in the caption menu by `main-startup.spec.ts`.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await import('../src/main.ts')
    await harness.preparing.promise
    const pluginItem = harness.menu.buildFromTemplate.mock.calls
      .flatMap(call => (call[0] as MenuTemplateItem[]))
      .flatMap(item => item.submenu ?? [])
      .find(item => item.accelerator === 'CmdOrCtrl+,')
    expect(pluginItem).toBeDefined()
    pluginItem!.click!()
    const popup = harness.windows.at(-1)!
    const handler = popup.webContents.setWindowOpenHandler.mock.calls.at(-1)?.[0] as (details: { url: string }) => { action: string }
    expect(handler({ url: 'file:///C:/Windows' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'https://github.com@evil.test/a/b' })).toEqual({ action: 'deny' })
    expect(harness.openExternal).not.toHaveBeenCalled()
    expect(handler({ url: 'https://github.com/owner/repo' })).toEqual({ action: 'deny' })
    expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/owner/repo')
    popup.urls.push('dsh-app://app/index.html')
    handler({ url: 'https://github.com/owner/repo' })
    expect(harness.openExternal).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, '', '  '])('isolates product data from inherited DSH_HOME with override %s', async (override) => {
    vi.stubEnv('MUSE_MED_HOME', override)
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(process.env.DSH_HOME).toBe(join(homedir(), '.muse'))
    expect(process.env.MUSE_HOME).toBe(join(homedir(), '.muse'))
  })

  it('makes packaged Windows media tools available without a local ASR model', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', resourcesPath: 'desktop-test-resources' })
    vi.stubEnv('PATH', 'system-tools')
    vi.stubEnv('PYTHONHOME', 'external-python')
    vi.stubEnv('PYTHONPATH', 'external-modules')
    vi.stubEnv('PYTHONDONTWRITEBYTECODE', '0')
    await import('../src/main.ts')
    await harness.preparing.promise
    const media = join('desktop-test-resources', 'runtime', 'media')
    expect(process.env.PATH).toBe([join(media, 'python'), join(media, 'ffmpeg', 'bin'), 'system-tools'].join(delimiter))
    expect(process.env.DSH_FFMPEG_PATH).toBe(join(media, 'ffmpeg', 'bin', 'ffmpeg.exe'))
    expect(process.env.DSH_FFPROBE_PATH).toBe(join(media, 'ffmpeg', 'bin', 'ffprobe.exe'))
    expect(process.env.FFMPEG_PATH).toBe(process.env.DSH_FFMPEG_PATH)
    expect(process.env.FFPROBE_PATH).toBe(process.env.DSH_FFPROBE_PATH)
    expect(process.env.MUSE_WHISPER_MODEL_DIR).toBeUndefined()
    expect(process.env.MUSE_BGM_RUNTIME_DIR).toBe(join(media, 'bgm'))
    expect(process.env.PYTHONHOME).toBeUndefined()
    expect(process.env.PYTHONPATH).toBeUndefined()
    expect(process.env.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(process.env.MUSE_FONTS_DIR).toBe(join(media, 'fonts'))
    expect(process.env.MUSE_FONT_FAMILY).toBe('Noto Sans CJK SC')
    expect(scrubbedParentEnv()).toMatchObject({ MUSE_FONTS_DIR: join(media, 'fonts'), MUSE_FONT_FAMILY: 'Noto Sans CJK SC' })
  })

  it('passes the explicit product home to the backend environment', async () => {
    vi.stubEnv('MUSE_MED_HOME', 'muse test home')
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(process.env.DSH_HOME).toBe(resolve('muse test home'))
    expect(process.env.MUSE_HOME).toBe(resolve('muse test home'))
  })

  it.each(['win32', 'darwin'] as const)('uses the %s Muse window artwork without changing renderer security', async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows[0]?.options).toMatchObject({
      title: 'Muse',
      icon: join(harness.appRoot, 'renderer', platform === 'win32' ? 'window-icon.png' : 'icon.png'),
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    })
  })

  it('exits through native recovery when the main window cannot be constructed', async () => {
    vi.spyOn(harness.app, 'getLocale').mockImplementationOnce(() => { throw new Error('locale unavailable') })
    answerRecovery(0)
    await import('../src/main.ts')
    await harness.quitCompleted.promise
    expect(harness.windows).toHaveLength(0)
    const options = harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions
    expect(options.detail).toContain('locale unavailable')
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'locale unavailable' }))
    // Exiting through the dialog is the only path left once no window exists to navigate.
    expect(harness.app.relaunch).not.toHaveBeenCalled()
  })

  it('withholds profile recovery after application resources fail to load', async () => {
    harness.canRecoverProfile.mockReturnValue(false)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.reject(new Error('runtime resources missing'))
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', profileRecovery: false })
    // The window keeps the application document: recovery is the native dialog, not an in-window page.
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    await expect(Promise.resolve(invoke(DESKTOP_IPC.configurationReset))).rejects.toThrow(en.startupReinstallAdvice)
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('runtime resources missing')
  })

  it('reports a crashed startup renderer once and relaunches only through the recovery choice', async () => {
    answerRecovery(1)
    await import('../src/main.ts')
    const window = await reachWorkspace()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('Desktop renderer exited: crashed')
    const quitting = harness.quitCompleted.promise
    const host = harness.hosts[0]!
    await host.stopping.promise
    host.exited.resolve()
    await quitting
    // The crashed window keeps its document; recovery relaunches the application instead of swapping the page.
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.windows).toHaveLength(1)
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
  })

  it('disables every plugin through native recovery before relaunching after a load failure', async () => {
    harness.pluginsEnabled = true
    answerRecovery(2)
    await import('../src/main.ts')
    const window = await reachWorkspace()
    const host = harness.hosts[0]!
    const quitting = harness.quitCompleted.promise
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    await host.stopping.promise
    host.exited.resolve()
    await quitting
    const options = harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions
    expect(options.buttons).toEqual([en.exitApplication, en.restartApplication, en.disableThirdPartyPlugins,
      en.resetConfiguration])
    expect(options.detail).toContain('preload unavailable')
    expect(harness.disableAllPlugins).toHaveBeenCalledOnce()
    expect(harness.pluginsEnabled).toBe(false)
    expect(console.info).toHaveBeenCalledWith('Desktop profile recovery completed:', {
      profilePatchBackup: 'desktop-test-profile/cordis.patch.yml.bak-1', homePatch: 'unchanged',
    })
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('resets the profile from the native recovery dialog through the channel implementation', async () => {
    answerRecovery(3)
    await import('../src/main.ts')
    const window = await reachWorkspace()
    const host = harness.hosts[0]!
    const quitting = harness.quitCompleted.promise
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    await host.stopping.promise
    host.exited.resolve()
    await quitting
    const options = harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions
    expect(options.buttons).toContain(en.resetConfiguration)
    expect(options.detail).toContain(en.startupConfigurationAdvice)
    expect(harness.resets).toBe(1)
    // The dialog runs the application's own reset rather than the private manager the plugin action builds.
    expect(harness.managerConstructions).toBe(1)
    expect(harness.disableAllPlugins).not.toHaveBeenCalled()
    // The profile write settled before the relaunch that retries startup.
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('resets the profile through the shell channel after a load failure', async () => {
    await import('../src/main.ts')
    const window = await reachWorkspace()
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    const stopped = harness.hosts[0]!
    const started = harness.nextHostStart()
    const reset = Promise.resolve(invoke(DESKTOP_IPC.configurationReset))
    await stopped.stopping.promise
    stopped.exited.resolve()
    await started
    harness.hosts[1]!.ready.resolve()
    await reset
    expect(harness.resets).toBe(1)
    expect(harness.pluginsEnabled).toBe(false)
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('allows a full profile reset for an unclassified startup failure', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.exited.resolve()
    harness.hosts[0]!.ready.reject(new Error('Unknown startup failure'))
    await harness.errorPublished.promise
    const stopped = harness.hosts[0]!
    const started = harness.nextHostStart()
    const reset = Promise.resolve(invoke(DESKTOP_IPC.configurationReset))
    await stopped.stopping.promise
    await started
    harness.hosts[1]!.ready.resolve()
    await reset
    expect(harness.resets).toBe(1)
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('keeps the application document and offers reinstall advice through the native recovery dialog', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    await harness.dialogShown.promise
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('secondary failure'))
    await flushMicrotasks()
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    const options = harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions
    expect(options.detail).toContain('preload unavailable')
    expect(options.detail).not.toContain('secondary failure')
    expect(options.detail).toContain(en.startupReinstallAdvice)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.windows).toHaveLength(1)
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('offers plugin recovery and disables plugins before restarting in the same window', async () => {
    harness.pluginsEnabled = true
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.exited.resolve()
    harness.hosts[0]!.ready.reject(new Error('Plugin initialization failed'))
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', profileRecovery: true })
    const nextStarted = harness.nextHostStart()
    const recovery = Promise.resolve(invoke(DESKTOP_IPC.pluginsDisableAll))
    await nextStarted
    expect(harness.pluginsEnabled).toBe(false)
    harness.hosts[1]!.ready.resolve()
    await recovery
    expect(harness.windows).toHaveLength(1)
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('waits for Host exit before the application restart quit completes', async () => {
    await import('../src/main.ts')
    const window = await reachWorkspace()
    const host = harness.hosts[0]!
    let quitCompleted = false
    void harness.quitCompleted.promise.then(() => { quitCompleted = true })
    const restart = Promise.resolve(invoke(DESKTOP_IPC.applicationRestart))
    await host.stopping.promise
    await restart
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
    await flushMicrotasks()
    // The relaunch is scheduled, but the process stays alive until the Host has exited.
    expect(quitCompleted).toBe(false)
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('prepares the profile offscreen and starts one actual Host before the first visible window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(1)
    const window = harness.windows[0]!
    expect(window.options.show).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.hosts).toHaveLength(0)
    const retry = invoke(DESKTOP_IPC.backendRetry)
    const secondRetry = invoke(DESKTOP_IPC.backendRetry)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    harness.hosts[0]!.ready.resolve()
    await Promise.all([retry, secondRetry, window.shown.promise])
    // Concurrent retries join one preparation and one Host.
    expect(harness.applyRelease).toHaveBeenCalledTimes(1)
    expect(harness.hosts[0]!.start).toHaveBeenCalledTimes(1)
    expect(harness.hosts[0]).toMatchObject({
      node: process.execPath,
      runtime: join(harness.appRoot, 'dsh'),
      primaryRuntime: join('desktop-test-resources', 'runtime', 'primary-runtime'),
      profile: 'desktop-test-profile',
    })
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('starts the unpackaged Host from the application development directory', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_DSH_DIR', undefined)
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(process.env.DSH_HOME).toBe('upstream-dsh-home')
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const project = join(harness.appRoot, '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({
      node: process.execPath, runtime: project, profile: project, primaryRuntime: 'test-primary-runtime',
    })
    // The merged startup prepares the profile before spawning, packaged or not.
    expect(harness.applyRelease).toHaveBeenCalledOnce()
    // The runtime assertion belongs to packaged profiles, whose state must match the bundled runtime.
    expect(harness.assertProfileRuntime).not.toHaveBeenCalled()
    harness.hosts[0]!.ready.resolve()
    await harness.windows[0]!.shown.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('asserts the prepared profile runtime after preparation and before the Host starts', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    // Profile preparation is still pending, so the assertion has nothing to read yet.
    expect(harness.assertProfileRuntime).not.toHaveBeenCalled()
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.assertProfileRuntime).toHaveBeenCalledWith('desktop-test-profile')
    expect(harness.assertProfileRuntime).toHaveBeenCalledOnce()
    const [release] = harness.applyRelease.mock.invocationCallOrder
    const [asserted] = harness.assertProfileRuntime.mock.invocationCallOrder
    const [started] = harness.hosts[0]!.start.mock.invocationCallOrder
    expect(release).toBeLessThan(asserted!)
    // The Host is spawned only after the prepared profile proved it belongs to this runtime.
    expect(asserted).toBeLessThan(started!)
  })

  it('refuses the Host spawn when the prepared profile belongs to another runtime', async () => {
    harness.assertProfileRuntime.mockImplementation(() => {
      throw new Error('desktop project: profile does not match this application runtime')
    })
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.errorPublished.promise
    expect(harness.hosts).toHaveLength(0)
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({
      phase: 'error', message: 'desktop project: profile does not match this application runtime',
    })
    harness.assertProfileRuntime.mockImplementation(() => {})
  })

  it('keeps startup errors and a successful retry in the same window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const first = harness.hosts[0]!
    const failedRetry = expect(Promise.resolve(invoke(DESKTOP_IPC.backendRetry))).rejects.toThrow('plugin composition failed')
    first.exited.resolve()
    first.ready.reject(new Error('plugin composition failed'))
    await harness.errorPublished.promise
    await failedRetry
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({
      phase: 'error', message: 'plugin composition failed', profileRecovery: true,
    })
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    const nextStarted = harness.nextHostStart()
    const retry = Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    await nextStarted
    expect(harness.hosts).toHaveLength(2)
    harness.hosts[1]!.ready.resolve()
    await retry
    expect(harness.windows).toHaveLength(1)
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('skips destroyed windows for update and backend publications while live windows still receive them', async () => {
    await import('../src/main.ts')
    await reachWorkspace()
    const publish = harness.updatePublish
    const closing = harness.windows[0]!
    closing.destroyed = true
    closing.webContents.send.mockClear()
    const live = new harness.FakeWindow({ show: true })
    expect(publish({ phase: 'idle' })).toEqual({ phase: 'idle' })
    expect(live.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.updatesState, { phase: 'idle' })
    // A live window that cannot accept the state still surfaces its failure.
    live.webContents.send.mockImplementationOnce(() => { throw new Error('invalid update payload') })
    expect(() => publish({ phase: 'idle' })).toThrow('invalid update payload')
    live.webContents.send.mockClear()
    const stopped = harness.hosts.at(-1)!
    const started = harness.nextHostStart()
    const mutation = Promise.resolve(invoke(DESKTOP_IPC.pluginsToggle, 'safe-plugin', false))
    await stopped.stopping.promise
    stopped.exited.resolve()
    await started
    harness.hosts.at(-1)!.ready.resolve()
    await mutation
    expect(closing.webContents.send).not.toHaveBeenCalled()
    expect(live.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.backendState, { phase: 'ready' })
  })

  it('skips a window whose WebContents is gone while other windows receive backend state', async () => {
    await import('../src/main.ts')
    await reachWorkspace()
    // Let the startup publication finish before adding a window that is already being torn down.
    await flushMicrotasks()
    const closing = new harness.FakeWindow({ show: false })
    closing.contentsDestroyed = true
    const live = new harness.FakeWindow({ show: true })
    const stopped = harness.hosts.at(-1)!
    const started = harness.nextHostStart()
    const mutation = Promise.resolve(invoke(DESKTOP_IPC.pluginsToggle, 'safe-plugin', false))
    await stopped.stopping.promise
    stopped.exited.resolve()
    await started
    harness.hosts.at(-1)!.ready.resolve()
    await mutation
    // The send would have thrown: the destroyed contents never receive the publication.
    expect(closing.webContents.send).not.toHaveBeenCalled()
    expect(live.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.backendState, { phase: 'ready' })
  })

  it('keeps update state without notifying renderer windows on either update channel after quit begins', async () => {
    await import('../src/main.ts')
    const window = await reachWorkspace()
    const publish = harness.updatePublish
    const host = harness.hosts[0]!
    const quitting = harness.quitCompleted.promise
    harness.app.quit()
    await host.stopping.promise
    host.exited.resolve()
    await quitting
    window.webContents.send.mockClear()
    expect(publish({ phase: 'idle' })).toEqual({ phase: 'idle' })
    // Every shell publication stops with the quit, including the update presentation.
    expect(window.webContents.send).not.toHaveBeenCalledWith(DESKTOP_IPC.updatesState, expect.anything())
    expect(window.webContents.send).not.toHaveBeenCalledWith(DESKTOP_IPC.updatesPresentation, expect.anything())
    expect(window.webContents.send).not.toHaveBeenCalledWith(DESKTOP_IPC.backendState, expect.anything())
  })

  it('publishes no update presentation to a window whose WebContents is gone', async () => {
    await import('../src/main.ts')
    const window = await reachWorkspace()
    const publish = harness.updatePublish
    window.contentsDestroyed = true
    window.webContents.send.mockClear()
    // The presentation send would have thrown on destroyed WebContents.
    expect(publish({ phase: 'downloading', percent: 10 })).toEqual({ phase: 'downloading', percent: 10 })
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('waits for a pending child to exit on quit without late window navigation', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const window = harness.windows[0]!
    const host = harness.hosts[0]!
    host.stop.mockImplementation(() => { host.stopping.resolve(); return host.exited.promise })
    window.close()
    harness.app.quit()
    await host.stopping.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(1)
    host.ready.resolve()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(host.stop).toHaveBeenCalledTimes(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.windows).toHaveLength(1)
  })
})
