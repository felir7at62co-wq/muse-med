/** Silent native completion notices owned by the Desktop main process. */

import type { Event, NotificationConstructorOptions } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Native notification operations used by the completion controller. */
export interface CompletionNoticeNotification {
  /**
   * Register the OS rejection callback.
   * @param event - Native failure event name.
   * @param listener - Receives the operating system's rejection message.
   */
  on(event: 'failed', listener: (event: Event, error: string) => void): void
  /**
   * Register the single activation callback.
   * @param event - Native activation event name.
   * @param listener - Returns to Muse when the user activates the notice.
   */
  once(event: 'click', listener: () => void): void
  /** Detach activation and rejection callbacks before closing. */
  removeAllListeners(): void
  /** Ask the operating system to present this notice. */
  show(): void
  /** Withdraw the current notice. */
  close(): void
}

/** Operating-system operations supplied by the Desktop main process. */
export interface CompletionNoticeNative {
  /** @returns Whether the operating system supports native notifications. */
  isSupported(): boolean
  /** @returns Whether a live, visible, non-minimized Muse window currently has focus. */
  isForeground(): boolean
  /**
   * Create one native notice using the selected language and silent playback.
   * @param options - Locale-owned copy and native presentation options.
   * @returns The notification owned until replacement, focus, navigation, or disposal.
   */
  create(options: NotificationConstructorOptions): CompletionNoticeNotification
  /**
   * Observe any Muse window gaining focus.
   * @param listener - Clears the outstanding completion notice.
   * @returns The focus listener's disposer.
   */
  onFocus(listener: () => void): () => void
}

type NavigationListener = (event: Event, url: string, inPlace: boolean, mainFrame: boolean) => void

/** Window lifecycle needed to invalidate a notice when its owning document ends. */
export interface CompletionNoticeWindow {
  /** @returns Whether the primary application window has been destroyed. */
  isDestroyed(): boolean
  /**
   * Observe the owning window closing.
   * @param event - Native window-close event name.
   * @param listener - Invalidates the notice after its owner closes.
   */
  on(event: 'closed', listener: () => void): void
  /**
   * Release the owning window's close listener.
   * @param event - Native window-close event name.
   * @param listener - Previously registered owner-close callback.
   */
  off(event: 'closed', listener: () => void): void
  /** Primary document lifecycle, independent of child-frame navigation. */
  webContents: {
    isDestroyed(): boolean
    on(event: 'did-start-navigation', listener: NavigationListener): void
    off(event: 'did-start-navigation', listener: NavigationListener): void
  }
}

interface OwnedNotice {
  notification: CompletionNoticeNotification
  detach(): void
}

/** Keeps one background completion notice, including notification-center clicks, until focus, navigation, replacement, or disposal. */
export class DesktopCompletionNotice {
  private current: OwnedNotice | undefined
  private disposed = false
  private readonly stopFocus: () => void

  /**
   * @param locale - Reads the current shell language when a completion arrives.
   * @param returnToMuse - Returns to the application only after a notification click.
   * @param native - Native notification and application-focus operations.
   */
  constructor(
    private readonly locale: () => DesktopLocale,
    private readonly returnToMuse: () => void,
    private readonly native: CompletionNoticeNative,
  ) {
    this.stopFocus = native.onFocus(() => {
      this.attempt(() => {
        if (native.isForeground()) this.clear()
      }, 'could not inspect focus')
    })
  }

  /**
   * Replace the previous notice when no Muse window has focus; never queue a foreground completion.
   * @param window - Live primary application window that owns the completed work.
   */
  show(window: CompletionNoticeWindow): void {
    this.clear()
    if (this.disposed) return
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed() || this.native.isForeground()) return
      if (!this.native.isSupported()) {
        console.warn('desktop task completion: native notifications are unsupported')
        return
      }
      const messages = this.locale().messages
      const notification = this.native.create({ title: messages.taskCompleteTitle, body: messages.taskCompleteBody, silent: true })
      const clear = (): void => {
        if (this.current?.notification === notification) this.clear()
      }
      const navigating: NavigationListener = (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) clear()
      }
      this.current = {
        notification,
        detach: () => {
          this.attempt(() => { window.off('closed', clear) }, 'could not detach window listener')
          this.attempt(() => { window.webContents.off('did-start-navigation', navigating) }, 'could not detach navigation listener')
        },
      }
      window.on('closed', clear)
      window.webContents.on('did-start-navigation', navigating)
      notification.on('failed', (_event, error) => {
        if (this.current?.notification !== notification) return
        console.warn('desktop task completion: native notification failed', error)
        this.clear()
      })
      notification.once('click', () => {
        if (this.disposed || this.current?.notification !== notification) return
        this.clear()
        this.attempt(() => {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) this.returnToMuse()
        }, 'could not return to Muse')
      })
      notification.show()
    } catch (error) {
      this.clear()
      console.warn('desktop task completion: native notification unavailable', error)
    }
  }

  /** Invalidate callbacks and release the current notice without scheduling another. */
  clear(): void {
    const current = this.current
    this.current = undefined
    if (!current) return
    this.attempt(() => { current.notification.removeAllListeners() }, 'could not detach notification listeners')
    current.detach()
    this.attempt(() => { current.notification.close() }, 'could not close notification')
  }

  /** Stop accepting completions and remove all owned listeners and native notices. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.attempt(this.stopFocus, 'could not detach focus listener')
    this.clear()
  }

  private attempt(action: () => void, message: string): void {
    try { action() }
    catch (error) { console.warn(`desktop task completion: ${message}`, error) }
  }
}
