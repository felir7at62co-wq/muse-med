/** Phone navigation and confirmation cards in the shared Muse Bot interface. */
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const engines: BrowserType[] = process.env.DSH_MOBILE_WEBKIT === '1' ? [chromium, webkit] : [chromium]

for (const engine of engines) {
  describe(`Muse phone layout (${engine.name()})`, () => {
    let browser: Browser
    let page: Page
    let script: string

    beforeAll(async () => {
      const bundled = await build({
        stdin: {
          contents: `import { SHELL_CSS, CONVERSATION_CSS } from './third_party/plugins/ds-bot/src/client/styles.js';
import { closePhoneSidebar } from './third_party/plugins/ds-bot/src/client/phone-navigation.js';
const style = document.createElement('style');
style.textContent = SHELL_CSS + CONVERSATION_CSS;
document.head.append(style);
document.getElementById('open-chat')?.addEventListener('click', () => closePhoneSidebar({ toggleSidebar() {
  document.getElementById('frame').setAttribute('data-sidebar-collapsed', '');
  document.getElementById('frame').dataset.toggles = String(Number(document.getElementById('frame').dataset.toggles || 0) + 1);
} }));`,
          resolveDir: root,
          sourcefile: 'mobile-layout-fixture.js',
        },
        nodePaths: [join(root, 'node_modules/.pnpm/node_modules')],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        write: false,
      })
      script = bundled.outputFiles[0]!.text
      browser = await engine.launch()
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
      page = await context.newPage()
    })

    afterAll(async () => { await browser?.close() })

    it('collapses the expanded sidebar on a phone after opening a conversation', async () => {
      await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="frame"><div class="fixture_sidebarCol"><button id="open-chat">Open conversation</button></div></div>')
      await page.addScriptTag({ content: script })
      await page.getByRole('button', { name: 'Open conversation' }).tap()
      expect(await page.locator('#frame').getAttribute('data-sidebar-collapsed')).toBe('')
      expect(await page.locator('#frame').getAttribute('data-toggles')).toBe('1')
      await page.getByRole('button', { name: 'Open conversation' }).tap()
      expect(await page.locator('#frame').getAttribute('data-toggles')).toBe('1')

      await page.setViewportSize({ width: 1280, height: 850 })
      await page.locator('#frame').evaluate((node) =>{  node.removeAttribute('data-sidebar-collapsed') })
      await page.getByRole('button', { name: 'Open conversation' }).click()
      expect(await page.locator('#frame').getAttribute('data-sidebar-collapsed')).toBeNull()
      expect(await page.locator('#frame').getAttribute('data-toggles')).toBe('1')
    })

    it('keeps a long confirmation scrollable with reachable touch controls in both themes', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      const options = Array.from({ length: 18 }, (_, index) => `<button type="button" class="bt-q-opt"><span class="bt-q-body"><span class="bt-q-label">Candidate ${index + 1}: review this source before continuing</span></span></button>`).join('')
      await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--bt-main);color:var(--bt-ink);font-family:system-ui}#conversation{width:calc(100vw - 56px);margin-left:56px;padding:16px;box-sizing:border-box}.bt-q{box-sizing:border-box}</style>
<main id="conversation"><div class="bt-q-dock"><form class="bt-q bt-q-raised"><div class="bt-q-head"><div class="bt-q-text"><p class="bt-q-title">Confirm the selected candidates</p></div><button type="button" class="bt-q-x" aria-label="Dismiss">×</button></div><div class="bt-q-list">${options}</div><textarea class="bt-q-input" aria-label="Your answer"></textarea><div class="bt-q-foot"><button class="bt-q-submit" type="button">Confirm</button></div></form></div></main>`)
      await page.addScriptTag({ content: script })
      await page.getByRole('button', { name: 'Confirm', exact: true }).evaluate((button) =>{  button.addEventListener('click', () =>{  button.setAttribute('data-confirmed', 'true') }) })
      for (const dark of [false, true]) {
        await page.locator('body').evaluate((body, on) => body.toggleAttribute('data-ds-dark-theme', on), dark)
        const geometry = await page.locator('.bt-q-dock').evaluate(node => ({
          height: node.getBoundingClientRect().height,
          scroll: node.scrollHeight > node.clientHeight,
          overflow: document.documentElement.scrollWidth > innerWidth,
          fieldFont: getComputedStyle(document.querySelector('.bt-q-input')!).fontSize,
        }))
        expect(geometry.height).toBeLessThanOrEqual(844 * 0.52 + 1)
        expect(geometry.scroll).toBe(true)
        expect(geometry.overflow).toBe(false)
        expect(geometry.fieldFont).toBe('16px')
        const submit = page.getByRole('button', { name: 'Confirm', exact: true })
        await submit.scrollIntoViewIfNeeded()
        const bounds = await submit.boundingBox()
        expect(bounds!.height).toBeGreaterThanOrEqual(44)
        expect(bounds!.width).toBeGreaterThanOrEqual(44)
        await submit.tap()
        await expect.poll(() => submit.getAttribute('data-confirmed')).toBe('true')
        await submit.evaluate((button) =>{  button.removeAttribute('data-confirmed') })
      }
      const output = join(root, '.playwright-mcp/mobile-layout')
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: join(output, `${engine.name()}-confirmation.png`) })
    })

    it('keeps the installed shortcut on the selected computer mount', async () => {
      const manifest = JSON.parse(await readFile(join(root, 'apps/web/public/manifest.webmanifest'), 'utf8')) as { id?: string; start_url: string; scope: string; display: string }
      expect(manifest).not.toHaveProperty('id')
      expect(manifest.start_url).toBe('./')
      const mounts = ['https://muse.example/desktop/350f8add-15ed-475b-99b0-c629f438d06e/', 'https://muse.example/desktop/another-computer/']
      const identities = mounts.map((mount) => {
        const manifestUrl = new URL('manifest.webmanifest', mount)
        const startUrl = new URL(manifest.start_url, manifestUrl)
        expect(startUrl.href).toBe(mount)
        expect(new URL(manifest.scope, manifestUrl).href).toBe(mount)
        // Without an explicit id, manifest processing uses start_url as the application identity.
        return startUrl.href
      })
      expect(identities[0]).not.toBe(identities[1])
      expect(manifest.display).toBe('standalone')
    })

    it('reserves the desktop banner and safe area only on remote pages', async () => {
      await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main>Conversation</main>')
      await page.addScriptTag({ content: script })
      expect(await page.locator('body').evaluate(body => getComputedStyle(body).paddingTop)).toBe('0px')
      await page.addStyleTag({ content: 'body{padding-top:36px!important;box-sizing:border-box}#muse-desktop-context{position:fixed;top:0;height:36px}' })
      await page.locator('body').evaluate((body) => {
        const banner = document.createElement('nav')
        banner.id = 'muse-desktop-context'
        body.append(banner)
      })
      const rules = await page.evaluate(() => Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules)).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule).filter(rule => rule.selectorText.includes('muse-desktop-context')).map(rule => ({ selector: rule.selectorText, top: rule.style.top, paddingTop: rule.style.paddingTop, priority: rule.style.getPropertyPriority('padding-top') })))
      expect(rules).toContainEqual({ selector: 'body:has(> #muse-desktop-context)', top: '', paddingTop: 'calc(36px + env(safe-area-inset-top,0px))', priority: 'important' })
      expect(rules).toContainEqual({ selector: 'body > #muse-desktop-context', top: 'env(safe-area-inset-top,0px)', paddingTop: '', priority: '' })
      expect(await page.locator('body').evaluate(body => getComputedStyle(body).paddingTop)).toBe('36px')
      expect(await page.locator('#muse-desktop-context').evaluate(banner => getComputedStyle(banner).top)).toBe('0px')
    })
  })
}
