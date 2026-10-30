/** Non-activating, click-through computer-use status on each display. */
import { BrowserWindow, screen } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Status sent by the owned Host process. */
export type ComputerUseState = 'active' | 'paused' | 'idle'

/** Escape shell-owned locale text for the isolated indicator document.
 * @param text - Localized shell copy.
 * @returns HTML text without markup.
 */
function escape(text: string): string {
  return text.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

/** Pure indicator HTML without scripts, links, remote resources or input controls.
 * @param state - Whether the agent is operating or yielded to the user.
 * @param locale - Desktop-owned localized strings.
 * @returns A self-contained document.
 */
export function computerUseOverlayHtml(state: 'active' | 'paused', locale: DesktopLocale): string {
  const color = state === 'active' ? '#4087ff' : '#d99723'
  const title = state === 'active' ? locale.messages.computerUseActive : locale.messages.computerUsePaused
  const detail = state === 'active' ? locale.messages.computerUseYieldHint : locale.messages.computerUseResumeHint
  return "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><style>"
    + 'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none;font-family:Segoe UI,Microsoft YaHei,sans-serif}'
    + '.edge{position:fixed;inset:0;box-sizing:border-box;border:3px solid ' + color + ';box-shadow:inset 0 0 20px ' + color + '99;border-radius:9px}'
    + '.label{position:fixed;left:50%;top:10px;transform:translateX(-50%);padding:9px 22px;border:1px solid ' + color + ';border-radius:12px;background:#10213ef2;color:white;text-align:center;box-shadow:0 3px 15px #0004;font-size:14px;white-space:nowrap}'
    + '.detail{font-size:12px;opacity:.86;margin-top:3px}</style></head><body><div class="edge"></div><div class="label"><strong>'
    + escape(title) + '</strong><div class="detail">' + escape(detail) + '</div></div></body></html>'
}

/** Own all indicator windows without taking input focus or holding application work alive. */
export class DesktopComputerUseOverlay {
  private windows: BrowserWindow[] = []
  private serial = Promise.resolve()
  private state: ComputerUseState = 'idle'
  private disposed = false
  private isDisposed(): boolean { return this.disposed }

  /** @param locale - Current shell locale, evaluated for every update. */
  constructor(private readonly locale: () => DesktopLocale) {}

  /** Show state before acknowledging Host admission; idle closes all indicator windows.
   * @param state - Content-free Host control state.
   * @returns Completion after the indicator is visible without activation.
   */
  update(state: ComputerUseState): Promise<void> {
    const operation = this.serial.catch((_error: unknown) => undefined).then(async () => {
      if (this.isDisposed()) throw new Error('Computer-use indicator disposed')
      if (state === this.state && this.windows.every(window => !window.isDestroyed())) return
      this.clear()
      if (state === 'idle') return
      try {
        for (const display of screen.getAllDisplays()) {
          const window = new BrowserWindow({
            ...display.bounds, show: false, frame: false, transparent: true,
            focusable: false, resizable: false, movable: false, skipTaskbar: true,
            hasShadow: false, alwaysOnTop: true, acceptFirstMouse: false,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
          })
          this.windows.push(window)
          window.setIgnoreMouseEvents(true)
          window.setAlwaysOnTop(true, 'screen-saver')
          window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(computerUseOverlayHtml(state, this.locale())))
          if (this.isDisposed()) throw new Error('Computer-use indicator disposed during loading')
          window.showInactive()
        }
        this.state = state
      } catch (error) { this.clear(); throw error }
    })
    this.serial = operation
    return operation
  }

  /** Close indicators when the Host stops; does not quit or activate other windows. */
  clear(): void {
    for (const window of this.windows) if (!window.isDestroyed()) window.destroy()
    this.windows = []
    this.state = 'idle'
  }

  /** Close pending and visible indicators during Desktop shutdown. */
  dispose(): void { this.disposed = true; this.clear() }
}
