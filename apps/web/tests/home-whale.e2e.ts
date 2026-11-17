/** Keyless real-profile checks for the Muse home mark and native input isolation. */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const artifacts = fileURLToPath(new URL('../../../.artifacts/home-brand/', import.meta.url))

describe('Muse home artwork in the default web profile', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleState: ReturnType<typeof watchConsole>
  let captureDir: string

  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true })
    captureDir = await mkdtemp(join(artifacts, 'run-'))
    scaffold = await launchWebScaffold({ firstUse: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    consoleState = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.locator('[data-conversation-content] img[src$="muse-med-logo-black.webp"]').waitFor()
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('loads the Muse mark without the retired whale canvas and preserves native input', async () => {
    expect(await page.locator('[data-home-whale]').count()).toBe(0)
    const mark = page.locator('[data-conversation-content] img[src$="muse-med-logo-black.webp"]')
    expect(await mark.evaluate((image: HTMLImageElement) => ({
      loaded: image.complete && image.naturalWidth > 0,
      decorative: image.getAttribute('aria-hidden'), alt: image.alt,
    }))).toEqual({ loaded: true, decorative: 'true', alt: '' })
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await input.fill('保留这个试用草稿')
    await input.click()
    expect(await input.innerText()).toBe('保留这个试用草稿')
    await input.press('ControlOrMeta+A')
    await input.press('Backspace')
    await page.screenshot({ path: join(captureDir, 'light.png') })
  })

  it('switches artwork with the theme and fits the narrow home', async () => {
    const settings = scaffold.ctx.get('settings')!
    try {
      await settings.update('ui-theme', { preference: 'dark' })
      const mark = page.locator('[data-conversation-content] img[src$="muse-med-logo-white.webp"]')
      await mark.waitFor()
      await expect.poll(() => mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
      await page.setViewportSize({ width: 390, height: 844 })
      const box = (await mark.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      await page.screenshot({ path: join(captureDir, 'dark-narrow.png') })
    } finally {
      await page.setViewportSize({ width: 1440, height: 960 })
      await settings.update('ui-theme', { preference: 'light' })
    }
    expect(consoleState.pageErrors).toEqual([])
    expect(consoleState.warnings).toEqual([])
  })
})
