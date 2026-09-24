import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { DshDesktopApi } from '../src/ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

function manager(locale = 'en', canInstall = true) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  onTestFinished(() => { dom.window.close() })
  const bundled = [{ name: 'dsh-ffmpeg', version: '0.4.3', mounted: true },
    { name: '@moyu-good/dsh-lark-bridge', version: '0.6.1', mounted: false }]
  const plugins = [
    { name: 'example plugin', npm: 'safe-plugin@1.2.3', repository: 'https://github.com/a/b',
      description: { en: '<script>not executable</script>', zh: '示例插件' }, bundled: false },
    { name: 'source-only', repository: 'https://github.com/a/c', description: {}, bundled: false },
    { name: 'ffmpeg', npm: 'dsh-ffmpeg', repository: 'https://github.com/a/d', description: {}, bundled: true },
  ]
  const catalog = vi.fn(async (discover: boolean) => ({ bundled, plugins: discover ? plugins : [], canInstall }))
  const add = vi.fn(async () => {})
  const api: DshDesktopApi = {
    protocolVersion: 1, locale: async () => resolveDesktopLocale(locale),
    plugins: { catalog, add, list: async () => [], remove: async () => {}, toggle: async () => {},
      disableAll: async () => {}, update: async () => {} },
    backend: { status: async () => ({ phase: 'ready' }), retry: async () => {}, subscribe: () => () => {} },
    updates: { check: async () => ({ phase: 'idle' }), install: async () => {}, subscribe: () => () => {} },
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  const confirm = vi.spyOn(dom.window, 'confirm').mockReturnValue(true)
  runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const element = <T extends HTMLElement>(selector: string): T => {
    const value = dom.window.document.querySelector<T>(selector)
    if (value === null) throw new Error(`missing plugin manager element ${selector}`)
    return value
  }
  return { dom, element, catalog, add, confirm }
}

it('loads offline built-ins before user-triggered discovery and installs only a selected npm entry', async () => {
  const page = manager()
  expect(page.dom.window.document.querySelector('#bundled-plugins')).not.toBeNull()
  await expect.poll(() => page.dom.window.document.querySelector('#bundled-plugins')?.textContent).toContain('dsh-ffmpeg')
  expect(page.catalog).toHaveBeenCalledExactlyOnceWith(false)
  expect(page.add).not.toHaveBeenCalled()
  page.element<HTMLButtonElement>('#discover').click()
  await expect.poll(() => page.element('#catalog-plugins').textContent).toContain('source-only')
  expect(page.element('#catalog-plugins').querySelectorAll('button')).toHaveLength(1)
  expect(page.element('#catalog-plugins').querySelector('script')).toBeNull()
  expect(page.element<HTMLAnchorElement>('#catalog-plugins a').href).toBe('https://github.com/a/b')
  expect(page.element('#catalog-plugins').textContent).toContain('Only npm registry packages can be installed')
  page.element<HTMLButtonElement>('#catalog-plugins button').click()
  await expect.poll(() => page.add.mock.calls.length).toBe(1)
  expect(page.confirm).toHaveBeenCalledOnce()
  expect(page.add).toHaveBeenCalledWith('safe-plugin@1.2.3')
  await expect.poll(() => page.element('#status').textContent).toContain('backend has restarted')
})

it('keeps built-ins visible on discovery failure and allows retry', async () => {
  const page = manager('zh')
  await expect.poll(() => page.catalog.mock.calls.length).toBe(1)
  page.catalog.mockRejectedValueOnce(new Error('catalog offline'))
  page.element<HTMLButtonElement>('#discover').click()
  await expect.poll(() => page.element('#status').textContent).toContain('catalog offline')
  expect(page.element('#bundled-plugins').textContent).toContain('@moyu-good/dsh-lark-bridge')
  page.element<HTMLButtonElement>('#discover').click()
  await expect.poll(() => page.element('#catalog-plugins').textContent).toContain('示例插件')
  expect(page.add).not.toHaveBeenCalled()
})

it('filters locally and requires confirmation without enabling writes in development', async () => {
  const page = manager('en', false)
  await expect.poll(() => page.catalog.mock.calls.length).toBe(1)
  page.element<HTMLButtonElement>('#discover').click()
  await expect.poll(() => page.element('#catalog-plugins').textContent).toContain('source-only')
  expect(page.element('#catalog-plugins').querySelectorAll('button')).toHaveLength(0)
  expect(page.element<HTMLButtonElement>('#install').disabled).toBe(true)
  const search = page.element<HTMLInputElement>('#catalog-search')
  search.value = 'source-only'
  search.dispatchEvent(new page.dom.window.Event('input'))
  expect(page.element('#catalog-plugins').children).toHaveLength(1)
  expect(page.catalog.mock.calls).toEqual([[false], [true]])
  expect(page.add).not.toHaveBeenCalled()
})
