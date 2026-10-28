/**
 * Painted geometry from the shipped frame/sidebar and source-built Bot navigation.
 * Only roster data and row operations are synthetic; this browser lane does not certify native window chrome.
 */
import { build } from 'vite'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SOURCE = fileURLToPath(new URL('./fixtures/plugins/fixture-bot-sidebar-rail/', import.meta.url))
const ARTIFACTS = join(REPO_ROOT, '.artifacts', 'sidebar-rail')

async function markPlatform(page: Page, platform: 'web' | 'darwin' | 'windows'): Promise<void> {
  await page.addInitScript(({ value, snapshot }) => {
    if (value !== 'web') {
      Object.assign(window, { dshDesktop: { protocolVersion: 1,
        keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
        shortcuts: { get: async () => ({ ...snapshot, status: 'ready' }),
          subscribe: () => () => {}, recording: async () => {},
          edit: async () => ({ status: 'not-ready', snapshot }) },
      } })
    }
    const mark = () => {
      if (value === 'darwin') document.documentElement.dataset.platform = 'darwin'
      if (value === 'windows') {
        document.documentElement.dataset.platform = 'win32'
        document.documentElement.setAttribute('data-windows-titlebar', '')
        document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
      }
    }
    if (document.documentElement === null) document.addEventListener('DOMContentLoaded', mark, { once: true })
    else mark()
  }, { value: platform, snapshot: initialShortcutConfig() })
}

async function fixturePackage(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'dsh-bot-rail-client-'))
  try {
    for (const name of ['package.json', 'index.js', 'cordis.patch.yml']) {
      await copyFile(join(SOURCE, name), join(target, name))
    }
    const result = await build({ configFile: false, root: SOURCE, logLevel: 'error',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: { write: false, minify: false, target: 'es2022',
        lib: { entry: join(SOURCE, 'client-entry.js'), formats: ['cjs'] },
        rollupOptions: { external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] },
      },
    })
    if ('on' in result) throw new Error('Expected an in-memory build, not a watcher')
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output)
    const script = outputs.flatMap(output => output.type === 'chunk' ? [output.code] : []).join('\n')
    await writeFile(join(target, 'client.js'), `window.__ModuleLoader__.load({
      id: '@fixture/bot-sidebar-rail', factory: (require) => {
        const module = { exports: {} }; const exports = module.exports;
        ${script}
        return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' });
      }
    });\n`)
    return target
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector('[data-slot="sidebar"]')!.parentElement!
    const frame = sidebar.parentElement!
    const main = document.querySelector('[data-slot="main"]')!.parentElement!
    const rail = document.querySelector('.bt-rail')
    const button = rail?.querySelector('[data-bot-id="chief"]')
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      const round = (value: number) => Math.round(value * 100) / 100
      return { left: round(box.left), right: round(box.right), top: round(box.top), bottom: round(box.bottom),
        width: round(box.width), height: round(box.height) }
    }
    const hit = (element: Element | null | undefined) => {
      if (element === null || element === undefined) return false
      const box = element.getBoundingClientRect()
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return target !== null && element.contains(target)
    }
    const toggle = sidebar.querySelector('button[aria-label="Open sidebar"]')
    const controls = [...rail?.querySelectorAll(':scope > button') ?? []]
    const list = rail?.querySelector('.bt-list')
    return { sidebar: rect(sidebar), main: rect(main), rail: rail === null ? null : rect(rail),
      button: button === null || button === undefined ? null : rect(button),
      buttonHit: hit(button), toggle: toggle === null ? null : rect(toggle), toggleHit: hit(toggle),
      controlsHit: controls.length === 2 && controls.every(hit),
      listScrollable: list !== null && list !== undefined && list.scrollHeight > list.clientHeight,
      viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth,
      viewportHeight: innerHeight, pageHeight: document.documentElement.scrollHeight,
      collapsed: frame.hasAttribute('data-sidebar-collapsed'), retained: frame.hasAttribute('data-sidebar-rail'),
    }
  })
}

async function collapse(page: Page): Promise<void> {
  if (!await page.locator('[data-sidebar-collapsed]').count()) {
    const button = page.getByRole('button', { name: 'Collapse sidebar', exact: true }).filter({ visible: true })
    await expect.poll(() => button.count()).toBe(1)
    await button.click()
  }
  await expect.poll(async () => {
    const info = await geometry(page)
    return info.collapsed && info.sidebar.width === 56 && info.rail !== null
  }).toBe(true)
  await page.locator('.bt-rail .bt-list').evaluate((element) => { element.scrollTop = 0 })
  await expect.poll(async () => (await geometry(page)).buttonHit).toBe(true)
}

/** Read browser layout on successive painted frames, including interrupted transitions. */
async function sampleMotion(page: Page, toggles: number[] = []) {
  return page.evaluate(async (interruptAt) => {
    const sidebar = document.querySelector('[data-slot="sidebar"]')!.parentElement!
    const frame = sidebar.parentElement!
    const main = document.querySelector('[data-slot="main"]')!.parentElement!
    const started = performance.now()
    const snapshots: Array<{
      time: number
      width: number
      mainLeft: number
      visibleControls: number
      toggleHit: boolean
      toggleDetails: string[]
      transition: string
      duration: string
      animating: boolean
    }> = []
    let interrupted = 0
    let settled = 0
    const clickToggle = () => {
      const selector = 'button[aria-label="Open sidebar"],button[aria-label="Collapse sidebar"]'
      const buttons = [...sidebar.querySelectorAll<HTMLButtonElement>(selector)]
      const button = buttons.find(candidate => candidate.getBoundingClientRect().width > 0)
      if (button === undefined) throw new Error('Sidebar toggle is not mounted')
      button.click()
    }
    const snapshot = (now: number) => {
      const bounds = sidebar.getBoundingClientRect()
      const opacityOf = (element: Element) => {
        let opacity = 1
        for (let node: Element | null = element; node !== null && node !== frame; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (style.visibility === 'hidden' || style.display === 'none') return 0
          opacity *= Number(style.opacity)
        }
        return opacity
      }
      const visibleButtons = [...sidebar.querySelectorAll('button')].filter((button) => {
        const box = button.getBoundingClientRect()
        if (box.width === 0 || box.height === 0 || box.right <= bounds.left || box.left >= bounds.right
          || box.bottom <= bounds.top || box.top >= bounds.bottom) return false
        return opacityOf(button) > .04
      })
      const toggleHit = visibleButtons.some((button) => {
        if (!['Open sidebar', 'Collapse sidebar'].includes(button.getAttribute('aria-label') ?? '')) return false
        const box = button.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return hit !== null && button.contains(hit)
      })
      const style = getComputedStyle(frame)
      const toggleDetails = toggleHit ? [] : [...sidebar.querySelectorAll('button')]
        .filter(button => ['Open sidebar', 'Collapse sidebar'].includes(button.getAttribute('aria-label') ?? ''))
        .map((button) => {
          const box = button.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          return JSON.stringify({ label: button.getAttribute('aria-label'), x: box.x, y: box.y, width: box.width, height: box.height,
            alpha: opacityOf(button), hit: hit?.tagName, hitLabel: hit?.getAttribute('aria-label'), hitClass: hit?.getAttribute('class') })
        })
      snapshots.push({ time: Math.round(now - started), width: Math.round(bounds.width * 100) / 100,
        mainLeft: Math.round(main.getBoundingClientRect().left * 100) / 100,
        visibleControls: visibleButtons.length, toggleHit, toggleDetails,
        transition: style.transitionProperty, duration: style.transitionDuration,
        animating: frame.hasAttribute('data-animating') })
    }
    snapshot(started)
    clickToggle()
    await new Promise<void>((resolve, reject) => {
      const paint = (now: number) => {
        snapshot(now)
        if (interrupted < interruptAt.length && now - started >= interruptAt[interrupted]!) {
          clickToggle()
          interrupted += 1
          settled = 0
        }
        const active = frame.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')
        if (interrupted === interruptAt.length && !active && !frame.hasAttribute('data-animating')) settled += 1
        else settled = 0
        if (settled >= 4) resolve()
        else if (now - started > 5000) reject(new Error('Sidebar motion did not settle'))
        else requestAnimationFrame(paint)
      }
      requestAnimationFrame(paint)
    })
    return snapshots
  }, toggles)
}

it.each(['web', 'darwin', 'windows'] as const)(
  'eases Bot sidebar width and keeps a visible control through collapse and reversal on %s', async (platform) => {
    const packageDir = await fixturePackage()
    let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [{ dir: packageDir, enabled: true }] },
        extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
      browser = await chromium.launch()
      await mkdir(ARTIFACTS, { recursive: true })
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', reducedMotion: 'no-preference' })
      try {
        await markPlatform(page, platform)
        const tripwire = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl)
        await page.locator('.bt-side').waitFor()
        const collapseSamples = await sampleMotion(page)
        const expandSamples = await sampleMotion(page)
        const interruptedSamples = await sampleMotion(page, [100, 180])
        const expandedWidth = collapseSamples[0]!.width
        await page.getByRole('button', { name: 'Open sidebar', exact: true }).filter({ visible: true }).click()
        await expect.poll(async () => (await geometry(page)).sidebar.width).toBe(expandedWidth)
        await page.evaluate(() => {
          const sidebar = document.querySelector('[data-slot="sidebar"]')!.parentElement!
          const frame = sidebar.parentElement!
          document.documentElement.dataset.resizeTrackTransition = 'false'
          frame.addEventListener('transitionrun', (event) => {
            if (event instanceof TransitionEvent && event.target === frame && event.propertyName === 'grid-template-columns') {
              document.documentElement.dataset.resizeTrackTransition = 'true'
            }
          })
        })
        await page.setViewportSize({ width: 390, height: 600 })
        await expect.poll(async () => (await geometry(page)).sidebar.width).toBe(56)
        expect(await page.locator('html').getAttribute('data-resize-track-transition'), 'responsive collapse stays immediate').toBe('false')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.setViewportSize({ width: 1280, height: 800 })
        await expect.poll(async () => (await geometry(page)).sidebar.width).toBe(expandedWidth)
        await collapse(page)
        const reducedExpand = await sampleMotion(page)
        const reducedCollapse = await sampleMotion(page)
        await writeFile(join(ARTIFACTS, `motion-${platform}-trace.json`),
          JSON.stringify({ collapseSamples, expandSamples, interruptedSamples, reducedExpand, reducedCollapse }, null, 2))
        for (const samples of [collapseSamples, expandSamples]) {
          expect(samples.some(sample => sample.width > 57 && sample.width < expandedWidth - 1), platform).toBe(true)
        }
        expect(collapseSamples.at(-1)!.width).toBe(56)
        expect(expandSamples.at(-1)!.width).toBe(expandedWidth)
        expect(interruptedSamples.at(-1)!.width).toBe(56)
        const all = [...collapseSamples, ...expandSamples, ...interruptedSamples, ...reducedExpand, ...reducedCollapse]
        expect(all.every(sample => sample.visibleControls > 0), platform).toBe(true)
        expect(all.every(sample => Math.abs(sample.mainLeft - sample.width) <= 1), platform).toBe(true)
        if (platform === 'darwin') expect(all.every(sample => sample.toggleHit), 'macOS reopen remains clickable').toBe(true)
        expect(reducedExpand.slice(1).every(sample => sample.width === expandedWidth), 'reduced-motion expand is immediate').toBe(true)
        expect(reducedCollapse.slice(1).every(sample => sample.width === 56), 'reduced-motion collapse is immediate').toBe(true)
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } finally { await page.close() }
    } finally {
      try { await browser?.close() }
      finally { try { await scaffold?.close() } finally { await rm(packageDir, { recursive: true, force: true }) } }
    }
  },
)

it('retains painted desktop rails and restores classic presentation when the shell releases them', async () => {
  const packageDir = await fixturePackage()
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [{ dir: packageDir, enabled: true }] },
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
    browser = await chromium.launch()
    await mkdir(ARTIFACTS, { recursive: true })
    const expected: string[] = []
    for (const platform of ['web', 'darwin', 'windows'] as const) {
      for (const colorScheme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', colorScheme,
          reducedMotion: 'reduce' })
        try {
          await markPlatform(page, platform)
          const tripwire = watchConsole(page)
          await page.goto(scaffold.authenticatedUrl)
          await page.locator('.bt-side').waitFor()
          await collapse(page)
          const result = await geometry(page)
          expect(result.sidebar.width).toBe(56)
          expect(result.retained).toBe(true)
          expect(result.buttonHit).toBe(true)
          expect(result.controlsHit).toBe(true)
          expect(result.toggleHit).toBe(true)
          expect(result.toggle!.top).toBeGreaterThanOrEqual(platform === 'darwin' ? 48 : 0)
          expect(result.toggle!.left).toBeGreaterThanOrEqual(result.sidebar.left)
          expect(result.toggle!.right).toBeLessThanOrEqual(result.sidebar.right)
          expect(result.main.left).toBeGreaterThanOrEqual(result.sidebar.right)
          expect(result.button!.left).toBeGreaterThanOrEqual(result.sidebar.left)
          expect(result.button!.right).toBeLessThanOrEqual(result.sidebar.right)
          expect(result.button!.top).toBeGreaterThanOrEqual(platform === 'web' ? 0 : 40)
          expect(result.pageWidth).toBe(result.viewportWidth)
          expect(result.pageHeight).toBe(result.viewportHeight)
          expect(result.listScrollable).toBe(true)
          const reopen = page.getByRole('button', { name: 'Open sidebar', exact: true }).filter({ visible: true })
          expect(await reopen.count()).toBe(1)
          await page.locator('.bt-rail [data-bot-id="chief"]').click()
          expect(await page.locator('html').getAttribute('data-fixture-bot-selected')).toBe('chief')
          await page.screenshot({ path: join(ARTIFACTS, `${platform}-${colorScheme}-collapsed.png`) })
          await page.locator('.bt-rail .bt-list').evaluate((element) => { element.scrollTop = element.scrollHeight })
          expect(await page.locator('.bt-rail .bt-list').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
          await reopen.click()
          await expect.poll(async () => (await geometry(page)).sidebar.width).toBeGreaterThan(56)
          await collapse(page)
          await page.setViewportSize({ width: 390, height: 600 })
          await expect.poll(async () => (await geometry(page)).viewportWidth).toBe(390)
          const narrow = await geometry(page)
          expect(narrow.sidebar.width).toBe(56)
          expect(narrow.buttonHit).toBe(true)
          expect(narrow.main.left).toBeGreaterThanOrEqual(narrow.sidebar.right)
          expect(narrow.pageWidth).toBe(narrow.viewportWidth)
          await page.getByRole('button', { name: 'Leave fixture Bot mode', exact: true }).click()
          await expect.poll(async () => (await geometry(page)).sidebar.width).toBe(platform === 'web' ? 56 : 0)
          const classic = await geometry(page)
          expect(classic.rail).toBeNull()
          expect(classic.retained).toBe(platform === 'web')
          expect(classic.pageWidth).toBe(classic.viewportWidth)
          expected.push(`${platform}/${colorScheme}: ${JSON.stringify({ wide: result, narrow, classic })}`)
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
        } catch (error) {
          try { await page.screenshot({ path: join(ARTIFACTS, `${platform}-${colorScheme}-failure.png`) }) }
          catch (screenshotError) {
            // Optional diagnostics must preserve the original assertion failure.
            void screenshotError
          }
          throw error
        } finally { await page.close() }
      }
    }
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/bot-sidebar-rail/geometry.expected.md', import.meta.url)),
      expected.join('\n'), webSnapshotMode())
  } finally {
    try { await browser?.close() }
    finally { try { await scaffold?.close() } finally { await rm(packageDir, { recursive: true, force: true }) } }
  }
})
