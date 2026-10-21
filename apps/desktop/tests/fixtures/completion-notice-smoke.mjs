// @ts-check
/** Real Electron window lifecycle with only the operating-system notification device replaced. */
import { app, BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

const [controllerPath, localePath, userData] = process.argv.slice(2)
if (controllerPath === undefined || localePath === undefined || userData === undefined) {
  throw new Error('expected <built-completion-notice.js> <built-locale.js> <userDataDir>')
}
app.setPath('userData', userData)
app.setAppLogsPath(`${userData}/logs`)
const timeoutMs = 10_000

/** @param {unknown} condition @param {string} message */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** @param {BrowserWindow} window */
function windowFacts(window) {
  const focused = BrowserWindow.getFocusedWindow()
  return window.isDestroyed() ? { id: window.id, destroyed: true } : {
    id: window.id, destroyed: false, minimized: window.isMinimized(), visible: window.isVisible(),
    isFocused: window.isFocused(), focusedWindowId: focused?.id ?? null, focusedIsTarget: focused === window,
  }
}

/** @param {BrowserWindow} window */
function foregroundWindow(window) {
  return BrowserWindow.getFocusedWindow() === window && !window.isDestroyed()
    && window.isVisible() && !window.isMinimized()
}

/**
 * @param {BrowserWindow} window
 * @param {() => void} change
 * @param {() => boolean} matches
 * @param {string} name
 * @param {() => unknown} [diagnostics]
 * @returns {Promise<void>}
 */
function windowState(window, change, matches, name, diagnostics = () => undefined) {
  return new Promise((resolve, reject) => {
    /** @type {{ event: string, state: ReturnType<typeof windowFacts> }[]} */
    const observed = []
    /** @param {Error} [error] */
    const finish = error => {
      clearTimeout(deadline)
      for (const event of events) window.off(event, changed)
      app.off('browser-window-focus', changed)
      app.off('browser-window-blur', changed)
      if (error) reject(error)
      else resolve()
    }
    const changed = () => {
      observed.push({ event: 'observation', state: windowFacts(window) })
      if (matches()) finish()
    }
    const events = /** @type {const} */ (['focus', 'blur', 'show', 'hide', 'minimize', 'restore'])
    const deadline = setTimeout(() => finish(new Error(`window did not reach ${name}; ${JSON.stringify({
      state: windowFacts(window), observed, details: diagnostics(),
    })}`)), timeoutMs)
    for (const event of events) window.on(event, changed)
    app.on('browser-window-focus', changed)
    app.on('browser-window-blur', changed)
    try {
      observed.push({ event: 'before-change', state: windowFacts(window) })
      change()
      observed.push({ event: 'after-change', state: windowFacts(window) })
      changed()
    }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}

/** @param {Electron.WebContents} contents @returns {Promise<void>} */
function reload(contents) {
  return new Promise((resolve, reject) => {
    /** @param {Error} [error] */
    const finish = error => {
      clearTimeout(deadline)
      contents.off('did-finish-load', loaded)
      contents.off('did-fail-load', failed)
      if (error) reject(error)
      else resolve()
    }
    const loaded = () => finish()
    /** @type {(event: Electron.Event, code: number, description: string, url: string, mainFrame: boolean) => void} */
    const failed = (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) finish(new Error(`reload failed: ${description} (${code})`))
    }
    const deadline = setTimeout(() => finish(new Error('reloaded document did not finish loading')), timeoutMs)
    contents.on('did-finish-load', loaded)
    contents.on('did-fail-load', failed)
    try { contents.reload() }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}

/** @param {BrowserWindow} window @returns {Promise<void>} */
function destroy(window) {
  if (window.isDestroyed()) return Promise.resolve()
  return new Promise(resolve => {
    window.once('closed', () => resolve())
    window.destroy()
  })
}

/** @extends {EventEmitter<{ click: [], close: [] }>} */
class NativeNotice extends EventEmitter {
  shown = 0
  closed = 0
  /** @param {Electron.NotificationConstructorOptions} options */
  constructor(options) { super(); this.options = options }
  show() { this.shown++ }
  close() { this.closed++; this.emit('close') }
}

async function run() {
  /** @type {typeof import('../../lib/types/completion-notice.js')} */
  const { DesktopCompletionNotice } = await import(pathToFileURL(controllerPath).href)
  /** @type {typeof import('../../lib/types/locale.js')} */
  const { resolveDesktopLocale } = await import(pathToFileURL(localePath).href)
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
  const other = new BrowserWindow({ show: false, width: 320, height: 240,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
  /** @type {NativeNotice[]} */
  const notices = []
  let returned = 0
  const focusListeners = app.listenerCount('browser-window-focus')
  const closeListeners = window.listenerCount('closed')
  const navigationListeners = window.webContents.listenerCount('did-start-navigation')
  /** @type {{ event: string, at: number, state: ReturnType<typeof windowFacts>, returned: number, eventWindowId?: number }[]} */
  const lifecycle = []
  /** @param {string} event @param {BrowserWindow} [eventWindow] */
  const record = (event, eventWindow) => {
    lifecycle.push({ event, at: performance.now(), state: windowFacts(window), returned,
      ...(eventWindow === undefined ? {} : { eventWindowId: eventWindow.id }) })
  }
  const diagnosticEvents = /** @type {const} */ (['focus', 'blur', 'show', 'hide', 'minimize', 'restore'])
  const diagnosticListeners = diagnosticEvents.map(event => ({ event, listener: () => { record(`window-${event}`) } }))
  for (const { event, listener } of diagnosticListeners) window.on(event, listener)
  /** @type {(event: Electron.Event, focused: BrowserWindow) => void} */
  const focused = (_event, focusedWindow) => { record('app-focus', focusedWindow) }
  /** @type {(event: Electron.Event, blurred: BrowserWindow) => void} */
  const blurred = (_event, blurredWindow) => { record('app-blur', blurredWindow) }
  app.on('browser-window-focus', focused)
  app.on('browser-window-blur', blurred)
  const detachDiagnostics = () => {
    for (const { event, listener } of diagnosticListeners) window.off(event, listener)
    app.off('browser-window-focus', focused)
    app.off('browser-window-blur', blurred)
  }
  /** @type {import('../../lib/types/completion-notice.js').CompletionNoticeNative} */
  const native = {
    isSupported: () => true,
    isForeground: () => {
      const focusedWindow = BrowserWindow.getFocusedWindow()
      return focusedWindow !== null && !focusedWindow.isDestroyed()
        && focusedWindow.isVisible() && !focusedWindow.isMinimized()
    },
    create(options) {
      const notification = new NativeNotice(options)
      notices.push(notification)
      return notification
    },
    onFocus(listener) {
      app.on('browser-window-focus', listener)
      return () => { app.off('browser-window-focus', listener) }
    },
  }
  const controller = new DesktopCompletionNotice(() => resolveDesktopLocale('en'), () => {
    returned++
    record('activation-callback')
    if (window.isMinimized()) {
      record('before-restore')
      window.restore()
      record('after-restore')
    }
    record('before-show')
    window.show()
    record('after-show')
    record('before-focus')
    window.focus()
    record('after-focus')
  }, native)
  const states = ['evidence=built-controller-real-electron-windows-fake-os-notification']
  const document = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><title>Completion notice smoke</title></head><body>Isolated completion notice test</body></html>')
  const foreground = () => windowState(window, () => { window.show(); window.focus() },
    () => foregroundWindow(window), 'foreground')
  const hidden = () => windowState(window, () => window.hide(),
    () => !window.isVisible() && BrowserWindow.getFocusedWindow() === null, 'hidden background')
  const inactive = () => windowState(window, () => window.showInactive(),
    () => window.isVisible() && BrowserWindow.getFocusedWindow() === null, 'visible inactive background')
  const latest = () => {
    const notice = notices.at(-1)
    if (!notice) throw new Error('expected a native notification')
    check(notice.shown === 1, 'notification was not shown exactly once')
    check(notice.options.title === 'Work completed' && notice.options.body === 'Return to Muse to view the result.'
      && notice.options.silent === true, 'notification did not use silent locale-owned copy')
    return notice
  }
  const roundTrip = () => window.webContents.executeJavaScript('document.readyState', false)
  try {
    await window.loadURL(document)
    await other.loadURL(document)
    await foreground()
    controller.show(window)
    check(notices.length === 0, `foreground completion created a notification; ${JSON.stringify({
      target: windowFacts(window), isForeground: native.isForeground(),
    })}`)
    states.push('foreground=not-notified')
    await windowState(other, () => { other.show(); other.focus() },
      () => foregroundWindow(other), 'another Muse window focused')
    controller.show(window)
    check(notices.length === 0, `another focused Muse window allowed a notification; ${JSON.stringify({
      target: windowFacts(other), isForeground: native.isForeground(),
    })}`)
    states.push('other-window-focused=not-notified')
    await windowState(other, () => { other.hide(); window.hide() },
      () => !other.isVisible() && !window.isVisible() && BrowserWindow.getFocusedWindow() === null, 'all windows hidden')

    await inactive()
    controller.show(window)
    latest()
    await roundTrip()
    check(window.isVisible() && BrowserWindow.getFocusedWindow() === null && returned === 0, 'inactive completion focused its window')
    states.push('visible-inactive=silent-without-focus')

    await hidden()
    controller.show(window)
    const hiddenNotice = latest()
    await roundTrip()
    check(!window.isVisible() && BrowserWindow.getFocusedWindow() === null && returned === 0, 'hidden completion showed its window')
    states.push('hidden=silent-without-show')
    await windowState(window, () => { hiddenNotice.emit('click') },
      () => foregroundWindow(window), 'hidden notification activation')
    check(returned === 1 && hiddenNotice.closed === 1, 'hidden notification did not return exactly once')
    states.push('hidden-click=returned-to-muse')

    if (process.platform === 'linux') {
      states.push('minimized=skipped-linux-window-manager')
    } else {
      await windowState(window, () => window.minimize(),
        () => window.isMinimized(), 'minimized background')
      controller.show(window)
      const minimizedNotice = latest()
      await roundTrip()
      check(window.isMinimized() && !window.isVisible() && returned === 1, 'completion restored a minimized window')
      states.push('minimized=silent-without-restore')
      await windowState(window, () => { minimizedNotice.emit('click') },
        () => foregroundWindow(window), 'minimized notification activation',
        () => ({ returned, notice: { shown: minimizedNotice.shown, closed: minimizedNotice.closed,
          clickListeners: minimizedNotice.listenerCount('click'), failedListeners: minimizedNotice.listenerCount('failed') }, lifecycle }))
      check(returned === 2, 'minimized notification did not return exactly once')
      states.push('minimized-click=restored-and-focused')
    }

    await hidden()
    controller.show(window)
    const replaced = latest()
    const staleClick = replaced.listeners('click')[0]
    if (!staleClick) throw new Error('replacement notice has no click callback')
    controller.show(window)
    const replacement = latest()
    const beforeClick = returned
    staleClick()
    check(replaced.closed === 1 && replaced.eventNames().length === 0 && replacement.closed === 0
      && returned === beforeClick, 'replacement retained an old activation callback')
    states.push('replacement=one-owner-stale-click-ignored')
    replacement.emit('close')
    check(replacement.closed === 0, 'toast expiry removed its notification-center activation')
    await windowState(window, () => { replacement.emit('click') },
      () => foregroundWindow(window), 'notification-center activation')
    replacement.emit('click')
    check(returned === beforeClick + 1 && replacement.closed === 1, 'notification-center click did not return exactly once')
    states.push('notification-center=click-returns-once')

    await hidden()
    controller.show(window)
    const navigating = latest()
    const oldClick = navigating.listeners('click')[0]
    if (!oldClick) throw new Error('reload notice has no click callback')
    const created = notices.length
    const beforeReload = returned
    await reload(window.webContents)
    await roundTrip()
    oldClick()
    check(navigating.closed === 1 && notices.length === created && returned === beforeReload,
      'reload retained or replayed the old completion')
    states.push('reload=cleared-without-replay')

    controller.show(window)
    const disposed = latest()
    const lateClick = disposed.listeners('click')[0]
    if (!lateClick) throw new Error('disposed notice has no click callback')
    const beforeDispose = notices.length
    controller.dispose()
    controller.dispose()
    controller.show(window)
    lateClick()
    await roundTrip()
    check(disposed.closed === 1 && notices.length === beforeDispose && returned === beforeReload,
      'disposed controller accepted a completion or late click')
    states.push('disposed=no-notice-or-callback')
    detachDiagnostics()
    check(app.listenerCount('browser-window-focus') === focusListeners
      && window.listenerCount('closed') === closeListeners
      && window.webContents.listenerCount('did-start-navigation') === navigationListeners
      && notices.every(notice => notice.eventNames().length === 0), 'controller left owned listeners attached')
    states.push('cleanup=all-owned-listeners-released')
    await new Promise((resolve, reject) => {
      process.stdout.write(`COMPLETION_NOTICE_RESULT ${JSON.stringify(states)}\n`, error => error ? reject(error) : resolve(undefined))
    })
  } finally {
    controller.dispose()
    detachDiagnostics()
    await destroy(other)
    await destroy(window)
  }
}

run().then(() => { app.quit() }, error => {
  console.error(`COMPLETION_NOTICE_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  app.exit(1)
})
