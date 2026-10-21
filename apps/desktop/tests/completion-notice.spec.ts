import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopCompletionNotice, type CompletionNoticeNative } from '../src/completion-notice.ts'
import { resolveDesktopLocale, type DesktopLocale } from '../src/locale.ts'

function platform() {
  const notices: Notice[] = []
  const windows: Window[] = []
  const state = { constructorError: undefined as Error | undefined, showError: undefined as Error | undefined }
  class Notice extends EventEmitter<{ click: []; close: []; failed: [event: Electron.Event, error: string] }> {
    show = vi.fn(() => {
      if (state.showError) throw state.showError
    })
    close = vi.fn()
    constructor(readonly options: Electron.NotificationConstructorOptions) {
      super()
      if (state.constructorError) throw state.constructorError
      notices.push(this)
    }
  }
  class Window extends EventEmitter<{ closed: []; blur: [] }> {
    destroyed = false
    minimized = false
    visible = true
    isDestroyed = vi.fn(() => this.destroyed)
    isMinimized = vi.fn(() => this.minimized)
    isVisible = vi.fn(() => this.visible)
    focus = vi.fn()
    show = vi.fn()
    restore = vi.fn()
    webContents = Object.assign(new EventEmitter<{
      'did-start-navigation': [event: Electron.Event, url: string, inPlace: boolean, mainFrame: boolean]
    }>(), { destroyed: false, isDestroyed() { return this.destroyed } })
    constructor() { super(); windows.push(this) }
  }
  const app = new EventEmitter<{ 'browser-window-focus': [event?: Electron.Event, window?: Window] }>()
  const getFocusedWindow = vi.fn<() => Window | null>(() => null)
  const adapter = {
    isSupported: vi.fn(() => true),
    isForeground: vi.fn(() => getFocusedWindow() !== null),
    create: vi.fn((options: Electron.NotificationConstructorOptions) => new Notice(options)),
    onFocus(listener: () => void) {
      app.on('browser-window-focus', listener)
      return () => { app.off('browser-window-focus', listener) }
    },
  } satisfies CompletionNoticeNative
  return { Window, notices, windows, state, app, getFocusedWindow, adapter }
}

const owners: DesktopCompletionNotice[] = []
const platforms: ReturnType<typeof platform>[] = []
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => {
  try {
    for (const owner of owners.splice(0)) owner.dispose()
    for (const native of platforms.splice(0)) {
      expect(native.app.listenerCount('browser-window-focus')).toBe(0)
      for (const window of native.windows) {
        expect(window.listenerCount('closed')).toBe(0)
        expect(window.webContents.listenerCount('did-start-navigation')).toBe(0)
      }
      for (const notice of native.notices) expect(notice.eventNames()).toEqual([])
    }
  } finally { vi.restoreAllMocks() }
})

function setup(locale = 'zh') {
  const native = platform()
  platforms.push(native)
  const window = new native.Window()
  const returned = vi.fn()
  let language = resolveDesktopLocale(locale)
  const notice = new DesktopCompletionNotice(() => language, returned, native.adapter)
  owners.push(notice)
  return {
    native, window, implementation: window, returned, notice,
    latest: () => native.notices.at(-1)!,
    locale: (value: DesktopLocale) => { language = value },
  }
}

describe('background work completion notices', () => {
  it.each(['visible', 'minimized', 'hidden'])('shows one silent notice for a %s background window without focusing it', (mode) => {
    const f = setup()
    f.implementation.minimized = mode === 'minimized'
    f.implementation.visible = mode !== 'hidden'
    f.notice.show(f.window)
    expect(f.native.notices).toHaveLength(1)
    expect(f.latest().options).toEqual({ title: '工作已完成', body: '点击返回 Muse 查看结果。', silent: true })
    expect(f.latest().show).toHaveBeenCalledOnce()
    expect(f.returned).not.toHaveBeenCalled()
    expect(f.implementation.focus).not.toHaveBeenCalled()
    expect(f.implementation.show).not.toHaveBeenCalled()
    expect(f.implementation.restore).not.toHaveBeenCalled()
  })

  it.each(['primary', 'another'])('does not notify when the %s Muse window is focused or replay after blur', (focused) => {
    const f = setup()
    const other = new f.native.Window()
    f.native.getFocusedWindow.mockReturnValue(focused === 'primary' ? f.implementation : other)
    f.notice.show(f.window)
    f.native.getFocusedWindow.mockReturnValue(null)
    other.emit('blur')
    f.window.emit('blur')
    expect(f.native.notices).toHaveLength(0)
    expect(f.returned).not.toHaveBeenCalled()
  })

  it('reads the current language for each new completion', () => {
    const f = setup()
    f.notice.show(f.window)
    const old = f.latest()
    f.locale(resolveDesktopLocale('en'))
    f.notice.show(f.window)
    expect(old.close).toHaveBeenCalledOnce()
    expect(f.latest().options).toEqual({ title: 'Work completed', body: 'Return to Muse to view the result.', silent: true })
  })

  it('returns on a single click after detaching and closing the notice', () => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    const click = notification.listeners('click')[0]!
    f.returned.mockImplementation(() => {
      expect(notification.eventNames()).toEqual([])
      expect(notification.close).toHaveBeenCalledOnce()
      expect(f.implementation.listenerCount('closed')).toBe(0)
    })
    notification.emit('click')
    click()
    notification.emit('click')
    expect(f.returned).toHaveBeenCalledOnce()
    expect(notification.close).toHaveBeenCalledOnce()
  })

  it('replaces the old notice and ignores its captured click and failure callbacks', () => {
    const f = setup()
    f.notice.show(f.window)
    const old = f.latest()
    const click = old.listeners('click')[0]!
    const failed = old.listeners('failed')[0]!
    f.notice.show(f.window)
    const current = f.latest()
    click()
    failed(new Event('failed'), 'late rejection')
    expect(f.returned).not.toHaveBeenCalled()
    expect(old.close).toHaveBeenCalledOnce()
    expect(current.close).not.toHaveBeenCalled()
    expect(f.implementation.listenerCount('closed')).toBe(1)
    expect(f.implementation.webContents.listenerCount('did-start-navigation')).toBe(1)
    expect(console.warn).not.toHaveBeenCalled()
    current.emit('click')
    expect(f.returned).toHaveBeenCalledOnce()
  })

  it.each(['closed', 'navigation'] as const)('ignores an already queued owner %s callback after replacement', (event) => {
    const f = setup()
    f.notice.show(f.window)
    const old = f.latest()
    const closed = f.window.listeners('closed')[0]!
    const navigation = f.window.webContents.listeners('did-start-navigation')[0]!
    const queued = event === 'closed' ? closed : () => {
      navigation(new Event('navigation'), 'muse://app/previous-document', false, true)
    }
    f.notice.show(f.window)
    const current = f.latest()
    queued()
    expect(old.close).toHaveBeenCalledOnce()
    expect(current.close).not.toHaveBeenCalled()
    expect(f.returned).not.toHaveBeenCalled()
    expect(f.window.listenerCount('closed')).toBe(1)
    expect(f.window.webContents.listenerCount('did-start-navigation')).toBe(1)
    current.emit('click')
    expect(f.returned).toHaveBeenCalledOnce()
  })

  it('clears on focus returning to any Muse window', () => {
    const f = setup()
    f.notice.show(f.window)
    const old = f.latest()
    const click = old.listeners('click')[0]!
    const other = new f.native.Window()
    f.native.getFocusedWindow.mockReturnValue(other)
    f.native.app.emit('browser-window-focus', new Event('focus'), other)
    click()
    expect(old.close).toHaveBeenCalledOnce()
    expect(f.returned).not.toHaveBeenCalled()
  })

  it('keeps the notice when a delayed focus event arrives after all Muse windows lost focus', () => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    expect(f.native.adapter.isForeground()).toBe(false)
    f.native.app.emit('browser-window-focus', new Event('focus'), f.window)
    expect(notification.close).not.toHaveBeenCalled()
    notification.emit('click')
    expect(f.returned).toHaveBeenCalledOnce()
    expect(notification.close).toHaveBeenCalledOnce()
  })

  it('contains focus getter failures without discarding the notice or interrupting later listeners', () => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    const error = new Error('focus state unavailable')
    const next = vi.fn()
    f.native.adapter.isForeground.mockImplementationOnce(() => { throw error })
    f.native.app.on('browser-window-focus', next)
    try {
      expect(() => { f.native.app.emit('browser-window-focus', new Event('focus'), f.window) }).not.toThrow()
      expect(next).toHaveBeenCalledOnce()
      expect(notification.close).not.toHaveBeenCalled()
      expect(console.warn).toHaveBeenCalledWith('desktop task completion: could not inspect focus', error)
      notification.emit('click')
      expect(f.returned).toHaveBeenCalledOnce()
    } finally { f.native.app.off('browser-window-focus', next) }
  })

  it.each([
    [false, false, false],
    [true, true, false],
    [false, true, true],
  ])('handles navigation inPlace=%s mainFrame=%s clear=%s', (inPlace, mainFrame, clears) => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    const click = notification.listeners('click')[0]!
    f.window.webContents.emit('did-start-navigation', new Event('navigation'), 'muse://app/next', inPlace, mainFrame)
    expect(notification.close).toHaveBeenCalledTimes(clears ? 1 : 0)
    click()
    expect(f.returned).toHaveBeenCalledTimes(clears ? 0 : 1)
  })

  it('clears on window close and refuses a destroyed window or web contents', () => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    const click = notification.listeners('click')[0]!
    f.implementation.destroyed = true
    f.window.emit('closed')
    click()
    f.notice.show(f.window)
    expect(notification.close).toHaveBeenCalledOnce()
    expect(f.returned).not.toHaveBeenCalled()
    expect(f.native.notices).toHaveLength(1)
    f.implementation.destroyed = false
    f.implementation.webContents.destroyed = true
    f.notice.show(f.window)
    expect(f.native.notices).toHaveLength(1)
  })

  it('checks window liveness again at click time', () => {
    const f = setup()
    f.notice.show(f.window)
    f.implementation.destroyed = true
    f.latest().emit('click')
    expect(f.returned).not.toHaveBeenCalled()
  })

  it('disposes idempotently and ignores late callbacks and future completions', () => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    const click = notification.listeners('click')[0]!
    const failed = notification.listeners('failed')[0]!
    notification.close.mockImplementation(() => { click(); failed(new Event('failed'), 'closing') })
    f.notice.dispose()
    f.notice.dispose()
    f.notice.show(f.window)
    f.native.app.emit('browser-window-focus')
    expect(notification.close).toHaveBeenCalledOnce()
    expect(f.returned).not.toHaveBeenCalled()
    expect(f.native.notices).toHaveLength(1)
    expect(f.native.app.listenerCount('browser-window-focus')).toBe(0)
  })

  it('does not create or queue a notification when the OS has no support', () => {
    const f = setup()
    f.native.adapter.isSupported.mockReturnValue(false)
    f.notice.show(f.window)
    f.native.adapter.isSupported.mockReturnValue(true)
    f.native.app.emit('browser-window-focus')
    expect(f.native.notices).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledWith('desktop task completion: native notifications are unsupported')
  })

  it.each(['constructor', 'show', 'support'] as const)('contains a native %s failure without keeping listeners', (operation) => {
    const f = setup()
    const error = new Error(`${operation} denied`)
    if (operation === 'constructor') f.native.state.constructorError = error
    if (operation === 'show') f.native.state.showError = error
    if (operation === 'support') f.native.adapter.isSupported.mockImplementationOnce(() => { throw error })
    expect(() => { f.notice.show(f.window) }).not.toThrow()
    expect(f.implementation.listenerCount('closed')).toBe(0)
    expect(f.implementation.webContents.listenerCount('did-start-navigation')).toBe(0)
    expect(console.warn).toHaveBeenCalledWith('desktop task completion: native notification unavailable', error)
    if (operation === 'show') expect(f.latest().close).toHaveBeenCalledOnce()
  })

  it('clears a rejected native notice and does not retry it', () => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    const click = notification.listeners('click')[0]!
    notification.emit('failed', new Event('failed'), 'notifications disabled')
    click()
    expect(notification.close).toHaveBeenCalledOnce()
    expect(f.returned).not.toHaveBeenCalled()
    expect(f.native.notices).toHaveLength(1)
    expect(console.warn).toHaveBeenCalledWith('desktop task completion: native notification failed', 'notifications disabled')
  })

  it('keeps a timed-out toast clickable in the notification center', () => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    const click = notification.listeners('click')[0]!
    notification.emit('close')
    expect(notification.close).not.toHaveBeenCalled()
    click()
    expect(notification.close).toHaveBeenCalledOnce()
    expect(f.returned).toHaveBeenCalledOnce()
  })

  it('contains close and return callback failures after invalidating the notice', () => {
    const f = setup()
    f.notice.show(f.window)
    const notification = f.latest()
    const closeError = new Error('close denied')
    const returnError = new Error('return failed')
    notification.close.mockImplementationOnce(() => { throw closeError })
    f.returned.mockImplementationOnce(() => { throw returnError })
    expect(() => { notification.emit('click') }).not.toThrow()
    expect(notification.eventNames()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith('desktop task completion: could not close notification', closeError)
    expect(console.warn).toHaveBeenCalledWith('desktop task completion: could not return to Muse', returnError)
    f.notice.clear()
    expect(notification.close).toHaveBeenCalledOnce()
  })
})
