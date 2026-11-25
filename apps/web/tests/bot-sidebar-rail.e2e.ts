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
const WEB_APP = fileURLToPath(new URL('../', import.meta.url))
const ARTIFACTS = join(REPO_ROOT, '.artifacts', 'sidebar-rail')

function watchSidebarCrashes(page: Page): string[] {
  const errors: string[] = []
  // Slot supervision can replace a failed Bot entry with the native Workspace region without a pageerror.
  page.on('console', (message) => {
    if (message.text().startsWith("slot entry crashed in 'sidebar.workspaces':")) errors.push(message.text())
  })
  return errors
}

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
    const result = await build({ configFile: false, root: WEB_APP, logLevel: 'error',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { dedupe: ['open-bot-avatar'] },
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

const OPEN_WIDTH = 280
const RAIL_WIDTH = 88
const NARROW_WIDTH = 390
const HAIRLINE = 1.1

async function geometry(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-slot="sidebar"]')!.parentElement!
    const frame = shell.parentElement!
    const main = document.querySelector('[data-slot="main"]')!.parentElement!
    const column = document.querySelector('.bt-leftcol')
    const row = column?.querySelector('[data-bot-id="chief"]')
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      const round = (value: number) => Math.round(value * 100) / 100
      return { left: round(box.left), right: round(box.right), top: round(box.top),
        width: round(box.width), height: round(box.height) }
    }
    const hit = (element: Element | null | undefined) => {
      if (!element) return false
      const box = element.getBoundingClientRect()
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return target !== null && element.contains(target)
    }
    const botToggle = '.bt-title-toggle, .bt-leftcol .bt-side-collapse'
    const toggleSelector = document.documentElement.dataset.platform === 'darwin'
      ? `[data-sidebar-opener], ${botToggle}` : botToggle
    const toggle = [...document.querySelectorAll(toggleSelector)].find(hit)
    const list = column?.querySelector('.bt-list')
    const shellBox = rect(shell)
    return {
      shell: shellBox, shellOccupied: Math.max(0, Math.min(shellBox.width, shellBox.right)),
      shellCollapsed: frame.hasAttribute('data-sidebar-collapsed'), shellDrawer: frame.hasAttribute('data-sidebar-drawer'),
      windowsTitlebar: document.documentElement.hasAttribute('data-windows-titlebar'),
      shellOpenerHit: hit(document.querySelector('[data-sidebar-opener]')),
      main: rect(main), column: column ? rect(column) : null, mode: column?.getAttribute('data-left') ?? null,
      row: row ? rect(row) : null, rowHit: hit(row), toggle: toggle ? rect(toggle) : null,
      footerHit: hit(column?.querySelector('.bt-leftcol-foot button')),
      listScrollable: list !== undefined && list !== null && list.scrollHeight > list.clientHeight,
      viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth,
      viewportHeight: innerHeight, pageHeight: document.documentElement.scrollHeight,
    }
  })
}

async function waitForColumn(page: Page, mode: 'open' | 'rail' | 'drawer'): Promise<void> {
  const width = mode === 'rail' ? RAIL_WIDTH : OPEN_WIDTH
  const occupied = mode === 'open' ? OPEN_WIDTH : RAIL_WIDTH
  // Chromium can paint the native shell border even when its grid track is closed.
  await expect.poll(async () => {
    const result = await geometry(page)
    const narrow = result.viewportWidth === NARROW_WIDTH
    const mainAtBotEdge = narrow ? result.main.left === occupied : Math.abs(result.main.left - occupied) <= HAIRLINE
    const shellSettled = narrow
      ? result.shellOccupied === 0 && result.shellDrawer !== result.windowsTitlebar
      : result.shellOccupied <= HAIRLINE
    return {
      ...result, shellSettled, mainAtBotEdge,
    }
  }).toMatchObject({
    mode, column: { left: 0, right: width, width }, shellSettled: true, shellCollapsed: true, mainAtBotEdge: true,
  })
}

async function dragColumnTo(page: Page, target: number): Promise<void> {
  const grip = await page.getByRole('separator', { name: 'Resize sidebar', exact: true }).boundingBox()
  if (!grip) throw new Error('Bot sidebar resize grip is not visible')
  const y = grip.y + grip.height / 2
  await page.mouse.move(grip.x + grip.width / 2, y)
  await page.mouse.down()
  try { await page.mouse.move(target, y) }
  finally { await page.mouse.up() }
}

/** Read both painted columns on successive frames, including interrupted transitions. */
async function sampleMotion(page: Page, toggles: number[] = []) {
  return page.evaluate(async (interruptAt) => {
    const main = document.querySelector('[data-slot="main"]')!.parentElement!
    const started = performance.now()
    const botToggle = '.bt-title-toggle, .bt-leftcol .bt-side-collapse'
    const selector = document.documentElement.dataset.platform === 'darwin'
      ? `[data-sidebar-opener], ${botToggle}` : botToggle
    const round = (value: number) => Math.round(value * 100) / 100
    const toggle = () => [...document.querySelectorAll<HTMLButtonElement>(selector)].find((button) => {
      const box = button.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return box.width > 0 && box.height > 0 && hit !== null && button.contains(hit)
    })
    const click = () => {
      const button = toggle()
      if (!button) throw new Error(`Bot sidebar toggle cannot be clicked: ${[...document.querySelectorAll(selector)].map((entry) => {
        const box = entry.getBoundingClientRect()
        return `${entry.getAttribute('aria-label')}@${box.x},${box.y},${box.width},${box.height}`
      }).join(' | ')}`)
      button.click()
    }
    const samples: { time: number; edge: number; mainLeft: number; toggleHit: boolean }[] = []
    const snapshot = (time: number) => {
      const column = document.querySelector('.bt-leftcol')
      const edge = Math.max(0, column?.getBoundingClientRect().right ?? 0)
      samples.push({ time: Math.round(time - started), edge: round(edge),
        mainLeft: round(main.getBoundingClientRect().left), toggleHit: toggle() !== undefined })
      return column
    }
    snapshot(started)
    click()
    let interrupted = 0
    let settled = 0
    await new Promise<void>((resolve, reject) => {
      const paint = (now: number) => {
        const column = snapshot(now)
        if (interrupted < interruptAt.length && now - started >= interruptAt[interrupted]!) {
          try { click() }
          catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return }
          interrupted += 1
          settled = 0
        }
        const animations = [...main.getAnimations(), ...column?.getAnimations() ?? []]
        const active = animations.some(animation => animation.playState === 'running')
        const previous = samples.at(-2)
        const current = samples.at(-1)
        const still = previous?.edge === current?.edge && previous?.mainLeft === current?.mainLeft
        if (interrupted === interruptAt.length && !active && still && !column?.hasAttribute('data-leaving')) settled += 1
        else settled = 0
        if (settled >= 4) resolve()
        else if (now - started > 5000) reject(new Error('Bot sidebar motion did not settle'))
        else requestAnimationFrame(paint)
      }
      requestAnimationFrame(paint)
    })
    return samples
  }, toggles)
}

it.each(['web', 'darwin', 'windows'] as const)(
  'eases the Bot sidebar and conversation through hide, reopen and reversal on %s', async (platform) => {
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
        const sidebarCrashes = watchSidebarCrashes(page)
        await page.goto(scaffold.authenticatedUrl)
        await waitForColumn(page, 'open')
        const hidden = await sampleMotion(page)
        const shown = await sampleMotion(page)
        const reversed = await sampleMotion(page, [130, 290])
        const reopened = await sampleMotion(page)
        await page.setViewportSize({ width: NARROW_WIDTH, height: 600 })
        await waitForColumn(page, 'rail')
        const narrow = await geometry(page)
        expect(Math.abs(narrow.main.width - (NARROW_WIDTH - RAIL_WIDTH))).toBeLessThanOrEqual(HAIRLINE)
        expect(narrow.pageWidth).toBe(narrow.viewportWidth)
        expect(narrow.rowHit).toBe(true)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.setViewportSize({ width: 1280, height: 800 })
        await waitForColumn(page, 'open')
        const reducedHidden = await sampleMotion(page)
        const reducedShown = await sampleMotion(page)
        await writeFile(join(ARTIFACTS, `motion-${platform}-trace.json`),
          JSON.stringify({ hidden, shown, reversed, reopened, reducedHidden, reducedShown }, null, 2))
        for (const samples of [hidden, shown, reversed, reopened]) {
          expect(samples.some(sample => sample.edge > 1 && sample.edge < OPEN_WIDTH - 1), platform).toBe(true)
          expect(samples.some(sample => sample.mainLeft > 1 && sample.mainLeft < OPEN_WIDTH - 1), platform).toBe(true)
          expect(samples.at(-1)!.toggleHit).toBe(true)
        }
        for (const samples of [hidden, reversed]) {
          expect(samples.at(-1)!.edge).toBe(0)
          expect(Math.abs(samples.at(-1)!.mainLeft)).toBeLessThanOrEqual(HAIRLINE)
        }
        for (const samples of [shown, reopened]) {
          expect(samples.at(-1)!.edge).toBe(OPEN_WIDTH)
          expect(Math.abs(samples.at(-1)!.mainLeft - OPEN_WIDTH)).toBeLessThanOrEqual(HAIRLINE)
        }
        expect(hidden.every(sample => sample.toggleHit), 'reopen remains clickable throughout the hide').toBe(true)
        if (platform !== 'web') {
          expect([...shown, ...reversed, ...reopened].every(sample => sample.toggleHit), 'title bar toggle stays clickable').toBe(true)
        }
        expect(reducedHidden.slice(1).every(sample => sample.edge === 0), 'reduced-motion sidebar hide is immediate').toBe(true)
        expect(reducedShown.slice(1).every(sample => sample.edge === OPEN_WIDTH), 'reduced-motion sidebar reopen is immediate').toBe(true)
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
        expect(sidebarCrashes).toEqual([])
      } finally { await page.close() }
    } finally {
      try { await browser?.close() }
      finally { try { await scaffold?.close() } finally { await rm(packageDir, { recursive: true, force: true }) } }
    }
  },
)

it('paints the Bot rail and floating drawer and releases the shell to classic presentation', async () => {
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
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', colorScheme, reducedMotion: 'reduce' })
        try {
          await markPlatform(page, platform)
          const tripwire = watchConsole(page)
          const sidebarCrashes = watchSidebarCrashes(page)
          await page.goto(scaffold.authenticatedUrl)
          await waitForColumn(page, 'open')
          await dragColumnTo(page, RAIL_WIDTH)
          await waitForColumn(page, 'rail')
          const wide = await geometry(page)
          expect(wide).toMatchObject({ rowHit: true, footerHit: true, listScrollable: true })
          expect(wide.toggle).not.toBeNull()
          expect(wide.row!.top).toBeGreaterThanOrEqual(platform === 'web' ? 0 : 40)
          expect(wide.row!.left).toBeGreaterThanOrEqual(wide.column!.left)
          expect(wide.row!.right).toBeLessThanOrEqual(wide.column!.right)
          expect(wide.pageWidth).toBe(wide.viewportWidth)
          expect(wide.pageHeight).toBe(wide.viewportHeight)
          expect(Math.abs(wide.main.left - wide.column!.right)).toBeLessThanOrEqual(HAIRLINE)
          expect(wide.main.right).toBe(wide.viewportWidth)
          await page.locator('.bt-rail [data-bot-id="chief"]').click()
          expect(await page.locator('html').getAttribute('data-fixture-bot-selected')).toBe('chief')
          await page.screenshot({ path: join(ARTIFACTS, `${platform}-${colorScheme}-collapsed.png`) })
          const list = page.locator('.bt-rail .bt-list')
          await list.evaluate((element) => { element.scrollTop = element.scrollHeight })
          expect(await list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
          await page.setViewportSize({ width: NARROW_WIDTH, height: 600 })
          await waitForColumn(page, 'rail')
          const narrow = await geometry(page)
          expect(narrow).toMatchObject({ rowHit: true, pageWidth: NARROW_WIDTH })
          expect(Math.abs(narrow.main.width - (NARROW_WIDTH - RAIL_WIDTH))).toBeLessThanOrEqual(HAIRLINE)
          await dragColumnTo(page, OPEN_WIDTH)
          await waitForColumn(page, 'drawer')
          await page.locator('.bt-leftcol .bt-list').evaluate((element) => { element.scrollTop = 0 })
          const drawer = await geometry(page)
          expect(drawer).toMatchObject({ rowHit: true, pageWidth: NARROW_WIDTH })
          expect(Math.abs(drawer.main.left - narrow.main.left)).toBeLessThanOrEqual(HAIRLINE)
          expect(Math.abs(drawer.main.width - narrow.main.width)).toBeLessThanOrEqual(HAIRLINE)
          expect(drawer.toggle).not.toBeNull()
          const { left: toggleLeft, right: toggleRight, top: toggleTop, width: toggleWidth, height: toggleHeight } = drawer.toggle!
          expect(toggleWidth).toBeGreaterThanOrEqual(28)
          expect(toggleLeft).toBeGreaterThanOrEqual(drawer.column!.left)
          expect(toggleRight).toBeLessThanOrEqual(drawer.column!.right)
          await page.locator('html').evaluate((element) => { element.removeAttribute('data-fixture-bot-selected') })
          await page.locator('.bt-leftcol [data-bot-id="chief"]').click()
          expect(await page.locator('html').getAttribute('data-fixture-bot-selected')).toBe('chief')
          await waitForColumn(page, 'rail')
          await page.getByRole('button', { name: 'Leave fixture Bot mode', exact: true }).click()
          await expect.poll(() => geometry(page)).toMatchObject({ column: null, mode: null, main: { left: 0 }, shellOccupied: 0 })
          const classic = await geometry(page)
          expect(classic.shellDrawer).toBe(platform !== 'windows')
          if (classic.shellDrawer) expect(classic.shellOpenerHit).toBe(true)
          await page.setViewportSize({ width: 1280, height: 800 })
          const classicWidth = platform === 'web' ? 56 : 0
          await expect.poll(() => geometry(page)).toMatchObject({
            column: null, shellDrawer: false, shellOccupied: classicWidth, main: { left: classicWidth }, pageWidth: 1280,
          })
          const restored = await geometry(page)
          // Record the docked edge after checking the native compositor hairline above.
          const left = wide.column!.right
          const docked = { ...wide, main: { ...wide.main, left, width: wide.main.right - left } }
          // The drawer header shrinks the button to fit the system-font brand text.
          const floating = { ...drawer, toggle: { right: toggleRight, top: toggleTop, height: toggleHeight } }
          expected.push(`${platform}/${colorScheme}: ${JSON.stringify({ wide: docked, narrow, drawer: floating, classic, restored })}`)
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          expect(sidebarCrashes).toEqual([])
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
