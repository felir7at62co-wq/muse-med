// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { markDocumentPlatform, syncWindowFullscreen } from '../src/preload-platform.ts'

const on = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { on } }))

afterEach(() => {
  delete document.documentElement.dataset.fullscreen
  delete document.documentElement.dataset.platform
  delete document.documentElement.dataset.dshProduct
  vi.restoreAllMocks()
  on.mockClear()
})

it('marks the main document for platform controls and Muse styling', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  markDocumentPlatform()
  expect(document.documentElement.dataset).toMatchObject({ platform: 'win32', dshProduct: 'muse' })
})

it('marks the document when the preload runs before the document root exists', () => {
  vi.spyOn(document, 'documentElement', 'get').mockReturnValueOnce(null as never)
  const events = vi.spyOn(window, 'addEventListener').mockImplementationOnce(() => {})
  markDocumentPlatform()
  const [name, listener] = events.mock.calls[0] ?? []
  expect(name).toBe('DOMContentLoaded')
  if (typeof listener !== 'function') throw new Error('Expected document-ready callback')
  listener(new Event('DOMContentLoaded'))
  expect(document.documentElement.dataset.dshProduct).toBe('muse')
})

it.each(['linux'] as const)('subscribes no fullscreen channel on %s', (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  syncWindowFullscreen()
  expect(on).not.toHaveBeenCalled()
})

it.each(['darwin', 'win32'] as const)('mirrors the sent fullscreen state onto html[data-fullscreen] on %s', (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  syncWindowFullscreen()
  expect(on).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.windowFullscreen, expect.any(Function))
  const handler = on.mock.calls[0]?.[1] as (event: unknown, fullscreen: boolean) => void
  handler({}, true)
  expect(document.documentElement.dataset.fullscreen).toBe('true')
  handler({}, false)
  expect(document.documentElement.dataset.fullscreen).toBeUndefined()
  // A repeated windowed report stays a no-op rather than toggling the flag.
  handler({}, false)
  expect(document.documentElement.dataset.fullscreen).toBeUndefined()
})
