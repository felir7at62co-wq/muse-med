/** Computer-use status remains visible without taking mouse or keyboard focus. */
import { afterEach, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'

const fixture = vi.hoisted(() => ({
  windows: [] as Array<{
    options: Record<string, unknown>
    html: string
    destroyed: boolean
    shown: boolean
    mouseIgnored: boolean
    top: boolean
  }>,
}))
vi.mock('electron', () => ({
  screen: { getAllDisplays: () => [
    { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  ] },
  BrowserWindow: class {
    record
    constructor(options: Record<string, unknown>) {
      this.record = { options, html: '', destroyed: false, shown: false, mouseIgnored: false, top: false }
      fixture.windows.push(this.record)
    }
    webContents = { setWindowOpenHandler: vi.fn() }
    setIgnoreMouseEvents(value: boolean) { this.record.mouseIgnored = value }
    setAlwaysOnTop(value: boolean) { this.record.top = value }
    async loadURL(url: string) { this.record.html = decodeURIComponent(url.split(',').slice(1).join(',')) }
    showInactive() { this.record.shown = true }
    isDestroyed() { return this.record.destroyed }
    destroy() { this.record.destroyed = true }
  },
}))
import { DesktopComputerUseOverlay, computerUseOverlayHtml } from '../src/computer-use-overlay.ts'

afterEach(() => { fixture.windows.length = 0 })

it('shows a click-through non-focusable indicator on every display and removes it on idle', async () => {
  const overlay = new DesktopComputerUseOverlay(() => resolveDesktopLocale('zh-CN'))
  await overlay.update('active')
  expect(fixture.windows).toHaveLength(2)
  for (const window of fixture.windows) {
    expect(window.options).toMatchObject({ focusable: false, skipTaskbar: true, frame: false, transparent: true, show: false })
    expect(window.mouseIgnored).toBe(true)
    expect(window.top).toBe(true)
    expect(window.shown).toBe(true)
    expect(window.html).toContain('Muse 正在使用电脑')
    expect(window.html).not.toContain('<script')
  }
  await overlay.update('active')
  expect(fixture.windows).toHaveLength(2)
  await overlay.update('paused')
  expect(fixture.windows.slice(0, 2).every(window => window.destroyed)).toBe(true)
  expect(fixture.windows[2]?.html).toContain('电脑操作已暂停')
  await overlay.update('idle')
  expect(fixture.windows.every(window => window.destroyed)).toBe(true)
  overlay.dispose()
})

it('uses locale-owned copy and refuses to recreate an indicator after disposal', async () => {
  expect(computerUseOverlayHtml('active', resolveDesktopLocale('en-US'))).toContain('Muse is using your computer')
  const overlay = new DesktopComputerUseOverlay(() => resolveDesktopLocale('en-US'))
  overlay.dispose()
  await expect(overlay.update('active')).rejects.toThrow('disposed')
  expect(fixture.windows).toHaveLength(0)
})
