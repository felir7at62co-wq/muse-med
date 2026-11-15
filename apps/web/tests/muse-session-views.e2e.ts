/** Packaged Deep View cards render and retain their native Session state in Chromium. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, revealNavigationDrawer, ZH_BROWSER_LOCALE } from './support.ts'

const packageDir = process.env.MUSE_DEEP_VIEW_PACKAGE
const fixturePath = fileURLToPath(new URL('../../../snapshots/session/muse-session-views/session.v4.jsonl', import.meta.url))
const widths = [1280, 420] as const
const themes = ['light', 'dark'] as const

interface FixtureRow {
  readonly type: string
  readonly data?: {
    readonly turn?: number
    readonly callId?: string
    readonly arguments?: string
    readonly inserted?: readonly { readonly source?: { readonly kind: string } }[]
  }
}

function withTitle(rows: readonly FixtureRow[], title: string): string {
  return rows.map(row => JSON.stringify(row.type === 'session/title'
    ? { ...row, data: { ...row.data, title } } : row)).join('\n') + '\n'
}

async function openSession(page: Page, title: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 960 })
  await revealNavigationDrawer(page, 'zh')
  const reopen = page.getByRole('button', { name: '打开侧边栏', exact: true })
  if (await reopen.isVisible()) await reopen.click()
  const workspace = page.getByRole('treeitem').first()
  await workspace.waitFor()
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
  if (await workspace.getAttribute('aria-expanded') !== 'true') {
    await workspace.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => workspace.getAttribute('aria-expanded')).toBe('true')
  }
  const row = page.getByRole('treeitem').filter({ hasText: title })
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  await row.click()
}

async function assertCardFits(page: Page, title: string): Promise<void> {
  const card = page.getByRole('group', { name: title, exact: true })
  await card.scrollIntoViewIfNeeded()
  await card.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished))
  })
  const bounds = await card.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth,
      unobstructed: hit !== null && element.contains(hit),
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
  })
  expect(bounds.width).toBeGreaterThan(160)
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1)
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1)
  expect(bounds.unobstructed).toBe(true)
}

async function setViewport(page: Page, width: number): Promise<void> {
  if (width < 768) {
    const collapse = page.getByRole('button', { name: '收起侧边栏', exact: true })
    if (await collapse.isVisible()) await collapse.click()
    await expect.poll(() => page.locator('[data-sidebar-collapsed]').count()).toBe(1)
  }
  await page.setViewportSize({ width, height: 960 })
  if (width >= 768) return
  await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor({ state: 'attached' })
  await expect.poll(() => page.locator('[data-sidebar-mask]').evaluate(element => getComputedStyle(element).opacity)).toBe('0')
}

it.skipIf(packageDir === undefined)('renders packaged ordinary-session views across themes and widths without restoring Bot navigation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-view-browser-'))
  const owned: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  if (packageDir === undefined) throw Error('MUSE_DEEP_VIEW_PACKAGE must name the unpacked reviewed package')
  const rows = (await readFile(fixturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as FixtureRow)
  const firstEnd = rows.findIndex(row => row.type === 'turn/end' && row.data?.turn === 1)
  const answerQueued = rows.findIndex(row => row.type === 'agent/inbox/spliced'
    && row.data?.inserted?.some(message => message.source?.kind === 'deep-view-reply'))
  expect(firstEnd).toBeGreaterThan(answerQueued)
  expect(answerQueued).toBeGreaterThan(0)
  const firstTurn = [...rows.slice(0, answerQueued), rows[firstEnd]!]
  const call = rows.find(row => row.type === 'tool/call' && row.data?.callId === 'call_view_options')
  expect(call?.data?.arguments).toBeTypeOf('string')
  const args = JSON.parse(call!.data!.arguments!) as { readonly title: string; readonly view: object }
  const store = join(root, 'views')
  await mkdir(store, { mode: 0o700 })
  const cases = themes.flatMap(theme => widths.map(width => ({ theme, width, id: `muse-view-${theme}-${width}`, title: `待回答视图 ${theme} ${width}` })))
  await writeFile(join(store, 'pending.json'), JSON.stringify(Object.fromEntries(cases.map(test => [test.id, {
    id: 'call_view_options', callId: 'call_view_options', title: args.title, view: args.view,
    askedAt: 1790985600000, afterSeq: firstTurn.length - 2,
  }]))), { mode: 0o600 })
  const overlay = join(root, 'private-views.overlay.yml')
  await writeFile(overlay, JSON.stringify([{ id: 'deep-view', config: { home: store } }]) + '\n')
  const scaffold = owned.scaffold = await launchWebScaffold({ profile: { packages: [{ dir: packageDir, enabled: true }], hmr: false },
    extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay] })
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const settledId = await seedSession(scaffold, withTitle(rows, '已回答视图'), 'muse-view-settled', 'standard')
  await workspace.attachSession(settledId)
  await scaffold.ctx.sessionController.rename({ sessionId: settledId, title: '已回答视图' })
  for (const test of cases) {
    const id = await seedSession(scaffold, withTitle(firstTurn, test.title), test.id, 'standard')
    await workspace.attachSession(id)
    await scaffold.ctx.sessionController.rename({ sessionId: id, title: test.title })
  }
  let modelRequests = 0
  scaffold.ctx.on('llm/stream', async function* (_options, next) { modelRequests++; yield* next() })
  const screenshotRoot = join(REPO_ROOT, '.artifacts', 'cards-browser-ui')
  await mkdir(screenshotRoot, { recursive: true })
  const screenshots = await mkdtemp(join(screenshotRoot, 'acceptance-'))
  const browser = owned.browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, locale: ZH_BROWSER_LOCALE, colorScheme: 'light' })
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  try {
    for (const test of cases) {
      await openSession(page, '已回答视图')
      await page.emulateMedia({ colorScheme: test.theme })
      await setViewport(page, test.width)
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')))
        .toBe(test.theme === 'dark')
      const table = page.getByRole('group', { name: '示例工具对比', exact: true })
      await table.getByRole('cell', { name: '反馈工具', exact: true }).waitFor()
      const answer = page.getByRole('group', { name: '选择下一步', exact: true })
      await answer.locator('.dv-q-check').waitFor()
      expect(await answer.locator('.dv-q-label').allTextContents()).toEqual(['先优化反馈工具', '先做Skill进化'])
      expect(await answer.getByRole('button').count()).toBe(0)
      await assertCardFits(page, '示例工具对比')
      await assertCardFits(page, '选择下一步')
      expect(await page.locator('.bt-rail, [data-bot-id], [data-bot-chat]').count()).toBe(0)
      expect(await page.locator('body').innerText()).not.toContain('answer_to_pending_view')
      await page.screenshot({ path: join(screenshots, `${test.theme}-${test.width}-settled.png`), fullPage: true, animations: 'disabled' })
      await page.reload({ waitUntil: 'load' })
      await answer.locator('.dv-q-check').waitFor()
      await table.getByRole('cell', { name: '反馈工具', exact: true }).waitFor()
      await openSession(page, test.title)
      await setViewport(page, test.width)
      const pending = page.getByRole('group', { name: '选择下一步', exact: true })
      const option = pending.getByRole('button', { name: '先优化反馈工具', exact: true })
      await option.waitFor()
      await option.click({ trial: true })
      await assertCardFits(page, '选择下一步')
      await page.screenshot({ path: join(screenshots, `${test.theme}-${test.width}-pending.png`), fullPage: true, animations: 'disabled' })
      await pending.getByRole('button', { name: '关闭视图', exact: true }).click()
      await pending.waitFor({ state: 'hidden' })
      const response = await scaffold.hostFetch('/api/deep-view', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'pending', sessionId: test.id }) })
      expect(await response.json()).toEqual({ ok: true, value: null })
      await page.reload({ waitUntil: 'load' })
      await table.getByRole('cell', { name: '反馈工具', exact: true }).waitFor()
      expect(await pending.count()).toBe(0)
    }
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
    expect(modelRequests).toBe(0)
  } catch (error) {
    await page.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true })
    await writeFile(join(screenshots, 'failure.aria.txt'), await page.locator('body').ariaSnapshot())
    await writeFile(join(screenshots, 'failure.console.json'), JSON.stringify(console, null, 2) + '\n')
    await writeFile(join(screenshots, 'failure.state.json'), JSON.stringify({
      sessions: await scaffold.ctx.sessionController.list({}, new AbortController().signal),
      rows: await page.getByRole('treeitem').evaluateAll(elements => elements.map(element => element.outerHTML)),
    }, null, 2) + '\n')
    throw error
  }
}, 180_000)
