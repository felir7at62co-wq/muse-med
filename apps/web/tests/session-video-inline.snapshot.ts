/** Replay recorded video entries, review drafts and Agent suggestions. */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/session-video-inline', import.meta.url))
const SUGGESTION_DIR = fileURLToPath(new URL('../../../snapshots/web/session-video-suggestion', import.meta.url))
const OWNER = fileURLToPath(new URL('../../../snapshots/session/muse-media-import-safe-filename', import.meta.url))
const VIDEO = 'source/media/company/91000000-0000-4000-8000-000000000001-video (1).mp4'
const SESSION = 'session-video-inline-recorded'
const MODE = webSnapshotMode()

function launchVideoScaffold() {
  return launchWebScaffold({ extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    fileURLToPath(new URL('./session-video.overlay.yml', import.meta.url))], profile: { hmr: false, packages: [
    { dir: fileURLToPath(new URL('../../../packages/drama/session-video', import.meta.url)) },
    { dir: fileURLToPath(new URL('../../../packages/client/ui-session-video', import.meta.url)) },
    { dir: fileURLToPath(new URL('../../../packages/bundle/muse-video-ui', import.meta.url)), enabled: true },
  ] } })
}

it('replays a compact video entry with workspace segment selection and an unsent review draft', async () => {
  const scaffold = await launchVideoScaffold()
  let browser: Browser | undefined
  try {
    const videoPath = join(scaffold.workspaceCwd, VIDEO)
    await mkdir(dirname(videoPath), { recursive: true })
    await copyFile(join(OWNER, 'workspace.expected', VIDEO), videoPath)
    await seedSession(scaffold, await readFile(join(OWNER, 'session.v4.jsonl'), 'utf8'), SESSION)
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor({ timeout: 15000 })
    await group.click()
    const session = page.getByRole('treeitem').nth(1)
    await session.waitFor({ timeout: 10000 })
    await session.click()
    const card = page.locator('[data-muse-inline-video]')
    await card.waitFor({ timeout: 15000 })
    await card.scrollIntoViewIfNeeded()
    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this unfinished instruction.'
    await editor.fill(draft)
    const before = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    const userCount = before.events.filter(event => event.type === 'user/message').length
    const delivered = await captureStableAria(page, '[data-muse-inline-video]', scaffold.workspaceCwd)
    expect(await card.locator('[data-muse-shelf-video]').count()).toBe(0)
    await card.getByRole('button', { name: /^Switch video:/u }).click()
    const workspace = page.locator('[data-muse-video-workspace]:visible')
    const shot = workspace.getByRole('button', { name: /^Video segment 1 ·/u })
    await expect.poll(() => shot.count(), { timeout: 30000 }).toBe(1)
    await shot.focus()
    await page.keyboard.press('Enter')
    expect(await shot.getAttribute('aria-pressed')).toBe('true')
    const currentRange = 'Video segment 1 · 00:00–00:01'
    const composerScope = page.locator('[data-muse-composer-scope]:visible')
    const previewScope = workspace.locator('[data-muse-preview-scope]')
    await expect.poll(() => composerScope.innerText()).toContain(currentRange)
    expect(await previewScope.innerText()).toContain(currentRange)
    expect(await editor.innerText()).toBe(draft)
    const currentShot = await captureStableAria(page, '[data-muse-composer-scope]:visible', scaffold.workspaceCwd)
    const review = workspace.getByRole('button', { name: 'Review selected videos', exact: true })
    expect(await review.isEnabled()).toBe(true)
    await review.click()
    await expect.poll(() => editor.innerText()).toContain('Review the selected footage against the script and delivery requirements, and suggest specific fixes for any issues.')
    expect((await editor.innerText()).startsWith(draft)).toBe(true)
    expect(await editor.locator('[data-composer-chip="muse-video"]').count()).toBe(1)
    const reviewMode = editor.locator('[data-composer-chip="muse-video-review"]')
    expect(await reviewMode.count()).toBe(1)
    expect(await reviewMode.getAttribute('contenteditable')).toBe('false')
    expect(await reviewMode.getByText('Read-only review', { exact: true }).count()).toBe(1)
    expect(await editor.innerText()).not.toMatch(/<!--\s*muse-video-review|muse_video/u)
    await editor.focus()
    await page.keyboard.press('ControlOrMeta+A')
    const copied = await editor.evaluate((element) => {
      const clipboardData = new DataTransfer()
      element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
      return clipboardData.getData('text/plain')
    })
    expect(copied).toContain(draft)
    expect(copied).toContain('Read-only review')
    expect(copied).not.toMatch(/<!--\s*muse-video-review|muse_video/u)
    await page.keyboard.press('ArrowRight')
    const after = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    expect(after.events.filter(event => event.type === 'user/message')).toHaveLength(userCount)
    const preview = await captureStableAria(page, '[data-muse-video-workspace]:visible', scaffold.workspaceCwd)
    const composer = await captureStableAria(page, '[data-composer-input][contenteditable="true"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'),
      `## Delivered video\n\n${delivered}\n\n## Video workspace\n\n${preview}\n\n## Current shot in chat\n\n${currentShot}\n\n## Unsent review draft\n\n${composer}`, MODE)
    const preservedDraft = await editor.innerText()
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await expect.poll(() => workspace.count()).toBe(0)
    expect(await composerScope.innerText()).toContain(currentRange)
    expect(await editor.innerText()).toBe(preservedDraft)
    expect(await editor.locator('[data-composer-chip="muse-video"]').count()).toBe(1)
    expect(await reviewMode.count()).toBe(1)
    await page.locator('[data-muse-video-anchor]').click()
    await workspace.waitFor()
    expect(await shot.getAttribute('aria-pressed')).toBe('true')
    expect(await editor.innerText()).toBe(preservedDraft)
    expect(await reviewMode.count()).toBe(1)
    expect((await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))).events.filter(event => event.type === 'user/message'))
      .toHaveLength(userCount)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 180000)

it('replays structured Agent advice after its recorded video is unavailable', async () => {
  const scaffold = await launchVideoScaffold()
  let browser: Browser | undefined
  try {
    const sessionId = await seedSession(scaffold, await readFile(join(SUGGESTION_DIR, 'session.v4.jsonl'), 'utf8'),
      'session-video-suggestion-recorded')
    const inventory = await scaffold.ctx.sessionVideo.list(sessionId, new AbortController().signal)
    expect(inventory.sources).toMatchObject([{ label: 'historical-review.mp4', status: 'missing' }])
    const before = await scaffold.ctx.sessionQuery.readSession(sessionId)
    const userCount = before.events.filter(event => event.type === 'user/message').length
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem').first().click()
    await page.getByRole('treeitem').nth(1).click()
    const card = page.locator('[data-muse-suggestion-card]')
    await card.waitFor()
    const earlierSuggestion = page.locator('[data-muse-suggestion]:not([data-muse-suggestion-card])')
    await earlierSuggestion.getByRole('link', { name: '00:00–00:10', exact: true }).waitFor()
    const rendered = await captureStableAria(page, '[data-muse-suggestion-card]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SUGGESTION_DIR, 'ui.expected.md'), rendered, MODE)

    const issueTime = card.getByRole('link', { name: '00:08.50', exact: true })
    const address = await issueTime.getAttribute('href')
    if (address === null) throw Error('Recorded advice has no source link')
    expect(new URL(address).searchParams.get('source')).toBe(inventory.sources[0]?.id)
    const viewport = page.viewportSize()
    if (viewport === null) throw Error('Shot advice review requires a desktop viewport')
    try {
      const narrowWidth = 390
      await page.setViewportSize({ width: narrowWidth, height: 844 })
      await page.emulateMedia({ colorScheme: 'dark' })
      await card.scrollIntoViewIfNeeded()
      const cardBox = await card.boundingBox()
      expect(cardBox !== null && cardBox.x >= 0 && cardBox.x + cardBox.width <= narrowWidth).toBe(true)
      await expect.poll(() => card.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await issueTime.isVisible()).toBe(true)
      expect(await card.getByRole('link', { name: 'Use this suggestion in chat', exact: true }).isVisible()).toBe(true)
    } finally {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: 'light' })
    }

    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this follow-up.'
    await editor.fill(draft)
    await issueTime.click()
    const workspace = page.locator('[data-muse-video-workspace]:visible')
    await workspace.getByRole('status').filter({ hasText: 'This video or segment changed. Please select it again.' }).waitFor()
    expect(await workspace.locator('[data-muse-shelf-video]').count()).toBe(0)
    expect(await editor.innerText()).toBe(draft)
    const after = await scaffold.ctx.sessionQuery.readSession(sessionId)
    expect(after.events.filter(event => event.type === 'user/message')).toHaveLength(userCount)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 180000)
