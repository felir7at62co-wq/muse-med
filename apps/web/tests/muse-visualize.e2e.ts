/** Packaged visualization cards replay, isolate state and draft prompts through real session inputs. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, revealNavigationDrawer, ZH_BROWSER_LOCALE } from './support.ts'

const packageDir = process.env.MUSE_VISUALIZE_PACKAGE
const fixturePath = fileURLToPath(new URL('../../../snapshots/session/muse-visualize/session.v4.jsonl', import.meta.url))
const iframeSelector = 'iframe[title="预算交互卡"]:visible'

interface FixtureRow {
  readonly type: string
  readonly data?: { readonly title?: string }
}

function titled(rows: readonly FixtureRow[], title: string): string {
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
  await page.locator(iframeSelector).last().contentFrame().getByRole('heading', { name: '预算方案 V2', exact: true }).waitFor()
}

async function fitFrame(page: Page, width: number): Promise<void> {
  const collapse = page.getByRole('button', { name: '收起侧边栏', exact: true })
  if (await collapse.isVisible()) await collapse.click()
  await expect.poll(() => page.locator('[data-sidebar-collapsed]').count()).toBe(1)
  await page.setViewportSize({ width, height: 960 })
  if (width < 768) {
    await expect.poll(() => page.locator('[data-sidebar-mask]').evaluate(element => getComputedStyle(element).opacity)).toBe('0')
  }
  const frame = page.locator(iframeSelector).last()
  await frame.scrollIntoViewIfNeeded()
  await frame.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished))
  })
  const geometry = await frame.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth,
      unobstructed: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element }
  })
  expect(geometry.width).toBeGreaterThan(180)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1)
  expect(geometry.unobstructed).toBe(true)
}

it.skipIf(packageDir === undefined)('replays packaged visualizations and keeps every iframe prompt inside its own existing composer state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-visualize-browser-'))
  const owned: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  if (packageDir === undefined) throw Error('MUSE_VISUALIZE_PACKAGE must name the unpacked reviewed package')
  const rows = (await readFile(fixturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as FixtureRow)
  const scaffold = owned.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: packageDir, enabled: true }], hmr: false },
    extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))],
  })
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  for (const [id, title] of [['visualize-session-a', '预算会话 A'], ['visualize-session-b', '预算会话 B']] as const) {
    const sessionId = await seedSession(scaffold, titled(rows, title), id, 'standard')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title })
  }
  let modelRequests = 0, submittedMessages = 0
  scaffold.ctx.on('llm/stream', () => { modelRequests++; throw Error('Browser replay cannot call a model') })
  scaffold.ctx.on('session/event', (_session, event) => { if (event.type === 'user/message') submittedMessages++ })
  const screenshotRoot = join(REPO_ROOT, '.artifacts', 'visualize-browser-ui')
  await mkdir(screenshotRoot, { recursive: true })
  const screenshots = await mkdtemp(join(screenshotRoot, 'acceptance-'))
  const browser = owned.browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, locale: ZH_BROWSER_LOCALE, colorScheme: 'light' })
  const messages = watchConsole(page)
  const externalImages: string[] = []
  await page.route('https://**/*', async (route) => {
    if (route.request().resourceType() === 'image') externalImages.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const frame = () => page.locator(iframeSelector).last().contentFrame()
  const composer = () => page.locator('[data-composer-input][contenteditable="true"]').last()
  try {
    await openSession(page, '预算会话 A')
    expect(await page.locator(iframeSelector).last().getAttribute('sandbox')).toBe('allow-scripts')
    expect(await frame().locator('#viz-quantity').inputValue()).toBe('3')
    expect(await frame().locator('[data-viz-out="total"]').textContent()).toBe('360')
    const isolated = await frame().locator('body').evaluate(() => {
      try { return parent.document === document } catch (error) { return error instanceof DOMException && error.name === 'SecurityError' }
    })
    expect(isolated).toBe(true)
    await frame().locator('#viz-quantity').focus()
    await page.keyboard.press('End')
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowLeft')
    await expect.poll(() => frame().locator('[data-viz-out="total"]').textContent()).toBe('840')
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key =>
      key.startsWith('dsh-visualize:state:') && localStorage.getItem(key)?.includes('"keep:viz-quantity":"7"')))).toBe(true)
    await frame().getByRole('button', { name: '带入方案', exact: true }).click()
    await expect.poll(() => composer().innerText()).toBe('按当前预算继续：7条视频')
    await fitFrame(page, 1280)
    await page.screenshot({ path: join(screenshots, 'light-1280-session-a.png'), fullPage: true, animations: 'disabled' })
    await openSession(page, '预算会话 B')
    expect(await frame().locator('#viz-quantity').inputValue()).toBe('3')
    expect((await composer().innerText()).trim()).toBe('')
    await composer().fill('用户正在编写的草稿')
    await frame().getByRole('button', { name: '带入方案', exact: true }).click()
    await expect.poll(() => composer().innerText()).toBe('用户正在编写的草稿')
    await page.getByText('输入框里已有草稿、引用或附件，卡片的内容没有写入', { exact: true }).waitFor()
    await openSession(page, '预算会话 A')
    await expect.poll(() => composer().innerText()).toBe('按当前预算继续：7条视频')
    expect(await frame().locator('#viz-quantity').inputValue()).toBe('7')
    await openSession(page, '预算会话 B')
    await expect.poll(() => composer().innerText()).toBe('用户正在编写的草稿')
    await page.reload({ waitUntil: 'load' })
    await frame().getByRole('heading', { name: '预算方案 V2', exact: true }).waitFor()
    await composer().fill('')
    await page.locator('input[type="file"]').setInputFiles({ name: '参考.txt', mimeType: 'text/plain', buffer: Buffer.from('保留这份附件') })
    const attachment = page.getByTitle('参考.txt')
    await attachment.waitFor({ state: 'visible' })
    await frame().getByRole('button', { name: '带入方案', exact: true }).click()
    await page.getByText('输入框里已有草稿、引用或附件，卡片的内容没有写入', { exact: true }).waitFor()
    expect((await composer().innerText()).trim()).toBe('')
    expect(await attachment.isVisible()).toBe(true)
    await openSession(page, '预算会话 A')
    expect(await frame().locator('#viz-quantity').inputValue()).toBe('7')
    await page.reload({ waitUntil: 'load' })
    await frame().getByRole('heading', { name: '预算方案 V2', exact: true }).waitFor()
    await expect.poll(() => frame().locator('#viz-quantity').inputValue()).toBe('7')
    await expect.poll(() => frame().locator('[data-viz-out="total"]').textContent()).toBe('840')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await fitFrame(page, 420)
    await frame().getByRole('button', { name: '带入方案', exact: true }).click({ trial: true })
    await page.screenshot({ path: join(screenshots, 'dark-420-session-a-reloaded.png'), fullPage: true, animations: 'disabled' })
    expect(modelRequests).toBe(0)
    expect(submittedMessages).toBe(0)
    expect(externalImages).toEqual([])
    expect(messages.pageErrors).toEqual([])
    expect(messages.warnings).toEqual([])
    await writeFile(join(screenshots, 'acceptance.json'), JSON.stringify({
      modelRequests, submittedMessages, externalImages, updatedMetaReplayed: true,
      interactiveSlider: true, frameSandbox: 'allow-scripts', reloadState: true,
      sessionIsolation: true, promptDraftOnly: true, userDraftRetained: true, attachmentRetained: true,
    }, null, 2) + '\n')
  } catch (error) {
    await page.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true, animations: 'disabled' })
    await writeFile(join(screenshots, 'failure.aria.txt'), await page.locator('body').ariaSnapshot())
    await writeFile(join(screenshots, 'failure.console.json'), JSON.stringify(messages, null, 2) + '\n')
    throw error
  }
}, 180_000)
