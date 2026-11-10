/** Render an existing delivered video and preserve the unfinished review draft. */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/session-video-inline', import.meta.url))
const OWNER = fileURLToPath(new URL('../../../snapshots/session/muse-media-import-safe-filename', import.meta.url))
const VIDEO = 'source/media/company/91000000-0000-4000-8000-000000000001-video (1).mp4'
const SESSION = 'session-video-inline-recorded'
const MODE = webSnapshotMode()

it('replays a delivered video with inline shot selection and an unsent review draft', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    fileURLToPath(new URL('./session-video.overlay.yml', import.meta.url))], profile: { hmr: false, packages: [
    { dir: fileURLToPath(new URL('../../../packages/drama/session-video', import.meta.url)) },
    { dir: fileURLToPath(new URL('../../../packages/client/ui-session-video', import.meta.url)) },
    { dir: fileURLToPath(new URL('../../../packages/bundle/muse-video-ui', import.meta.url)), enabled: true },
  ] } })
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
    const shot = card.getByRole('button', { name: /^Shot 1 ·/u })
    await expect.poll(() => shot.count(), { timeout: 30000 }).toBe(1)
    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this unfinished instruction.'
    await editor.fill(draft)
    const before = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    const userCount = before.events.filter(event => event.type === 'user/message').length
    await shot.focus()
    await page.keyboard.press('Enter')
    expect(await shot.getAttribute('aria-pressed')).toBe('true')
    const redo = card.getByRole('button', { name: 'Regenerate this shot', exact: true })
    expect(await redo.isEnabled()).toBe(true)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), await captureStableAria(page, '[data-muse-inline-video]', scaffold.workspaceCwd), MODE)
    await redo.click()
    await expect.poll(() => editor.innerText()).toContain('Regenerate this shot:')
    expect((await editor.innerText()).startsWith(draft)).toBe(true)
    const after = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    expect(after.events.filter(event => event.type === 'user/message')).toHaveLength(userCount)
    const anchor = page.locator('[data-muse-video-anchor]')
    await anchor.click()
    await expect.poll(() => page.locator('[data-muse-video-shelf]').isVisible()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 180000)
