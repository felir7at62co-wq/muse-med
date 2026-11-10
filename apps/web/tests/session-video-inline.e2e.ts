/** Delivered videos retain independent inline timelines and reviewable shot drafts. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-session-query'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./session-video.overlay.yml', import.meta.url))
const SESSION = 'session-inline-video-independent-cards'
const FIRST = 'first-three-shots.mp4'
const SECOND = 'second-three-shots.mp4'
const TITLE = 'Inline video card inspection'

function fixture(): string {
  const session = Session.create(SessionId('session-inline-video-fixture'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Review the two existing videos in this conversation.' },
  ] }), { surfaceOp: 'append' })
  session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant',
    content: [{ type: 'text', text: 'Both videos are ready for review.' }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('deliverables/presented', { turn: 1, callId: ToolCallId('present-two-videos'), files: [
    { path: FIRST, description: 'Black, white, black video with three visual cuts.' },
    { path: SECOND, description: 'Red, blue, red video with three visual cuts.' },
  ] })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

function makeVideo(destination: string, colors: readonly [string, string, string]): void {
  execFileSync('ffmpeg', ['-v', 'error', '-nostdin',
    '-f', 'lavfi', '-i', `color=c=${colors[0]}:s=64x64:r=10:d=1`,
    '-f', 'lavfi', '-i', `color=c=${colors[1]}:s=64x64:r=10:d=1`,
    '-f', 'lavfi', '-i', `color=c=${colors[2]}:s=64x64:r=10:d=1`,
    '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', destination])
}

describe('web e2e: full inline conversation video cards', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleWatch: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), OVERLAY],
      profile: { hmr: false, packages: [
        { dir: fileURLToPath(new URL('../../../packages/drama/session-video', import.meta.url)) },
        { dir: fileURLToPath(new URL('../../../packages/client/ui-session-video', import.meta.url)) },
        { dir: fileURLToPath(new URL('../../../packages/bundle/muse-video-ui', import.meta.url)), enabled: true },
      ] },
    })
    makeVideo(join(scaffold.workspaceCwd, FIRST), ['black', 'white', 'black'])
    makeVideo(join(scaffold.workspaceCwd, SECOND), ['red', 'blue', 'red'])
    await seedSession(scaffold, fixture(), SESSION)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
    await page.getByRole('treeitem').first().click({ timeout: 15000 })
    await page.getByRole('treeitem').nth(1).click({ timeout: 15000 })
    await page.getByText('Both videos are ready for review.', { exact: true }).waitFor({ timeout: 15000 })
  }, 180000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('keeps each card bound to its own video while selecting shots, sources, and preserving the draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-inline-independent'))
    // The native delivered-video slot marks each full player with this stable owner attribute.
    const cards = page.locator('[data-muse-inline-video]')
    await expect.poll(() => cards.count(), { timeout: 30000 }).toBe(2)
    const first = cards.nth(0), second = cards.nth(1)
    const firstSource = first.getByRole('combobox', { name: 'Conversation videos' })
    const secondSource = second.getByRole('combobox', { name: 'Conversation videos' })
    await firstSource.waitFor({ timeout: 30000 })
    await secondSource.waitFor({ timeout: 30000 })
    await expect.poll(() => firstSource.locator('option:checked').textContent()).toBe(FIRST)
    await expect.poll(() => secondSource.locator('option:checked').textContent()).toBe(SECOND)

    const firstVideo = first.locator('video[data-muse-shelf-video]')
    const secondVideo = second.locator('video[data-muse-shelf-video]')
    await expect.poll(() => firstVideo.evaluate(element => (element as HTMLVideoElement).readyState),
      { timeout: 30000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => secondVideo.evaluate(element => (element as HTMLVideoElement).readyState),
      { timeout: 30000 }).toBeGreaterThanOrEqual(1)
    const firstUrl = await firstVideo.getAttribute('src')
    const secondUrl = await secondVideo.getAttribute('src')
    expect(firstUrl).toContain('api/session-video?')
    expect(secondUrl).toContain('api/session-video?')
    expect(firstUrl).not.toBe(secondUrl)
    expect(await firstVideo.evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(3)
    expect(await secondVideo.evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(3)
    await firstVideo.evaluate(async (element) => { await (element as HTMLVideoElement).play() })
    await expect.poll(() => firstVideo.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    await firstVideo.evaluate((element) => { (element as HTMLVideoElement).pause() })

    // Cut analysis belongs to the inline card even when the old bubble is closed.
    const firstShots = first.getByRole('button', { name: /^Shot \d+ ·/u })
    const secondShots = second.getByRole('button', { name: /^Shot \d+ ·/u })
    await second.scrollIntoViewIfNeeded()
    await expect.poll(() => secondShots.count(), { timeout: 60000 }).toBeGreaterThanOrEqual(3)
    await first.scrollIntoViewIfNeeded()
    await expect.poll(() => firstShots.count(), { timeout: 60000 }).toBe(6)
    await expect.poll(() => secondShots.count(), { timeout: 60000 }).toBe(6)
    await firstShots.nth(1).press('Enter')
    await expect.poll(() => firstVideo.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    expect(await firstShots.nth(1).getAttribute('aria-pressed')).toBe('true')
    const firstPosition = await firstVideo.evaluate(element => (element as HTMLVideoElement).currentTime)

    await secondSource.selectOption({ label: FIRST })
    await expect.poll(() => secondSource.locator('option:checked').textContent()).toBe(FIRST)
    expect(await firstSource.locator('option:checked').textContent()).toBe(FIRST)
    expect(await firstVideo.getAttribute('src')).toBe(firstUrl)
    expect(await firstVideo.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(firstPosition)
    await secondSource.selectOption({ label: SECOND })
    await expect.poll(() => secondSource.locator('option:checked').textContent()).toBe(SECOND)
    await expect.poll(() => secondShots.count(), { timeout: 30000 }).toBe(6)
    await secondShots.nth(4).press('Enter')
    await expect.poll(() => secondVideo.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    expect(await firstVideo.getAttribute('src')).toBe(firstUrl)

    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this unfinished instruction.'
    await editor.fill(draft)
    const before = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    const userCount = before.events.filter(event => event.type === 'user/message').length
    await second.getByRole('button', { name: 'Regenerate this shot', exact: true }).click()
    await expect.poll(() => editor.innerText()).toContain(`Regenerate this shot: ${SECOND}`)
    const text = await editor.innerText()
    expect(text.startsWith(draft)).toBe(true)
    expect(text).toContain('original range: 1.000–2.000 seconds')
    const after = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    expect(after.events.filter(event => event.type === 'user/message')).toHaveLength(userCount)
    expect(after.events.filter(event => event.type === 'request/header')).toHaveLength(0)

    // The original session-wide bubble remains usable while inline cards are present.
    const bubble = page.locator('[data-muse-video-anchor]')
    expect(await bubble.count()).toBe(1)
    await bubble.click()
    await page.locator('[data-muse-video-shelf]').getByRole('combobox', { name: 'Conversation videos' }).waitFor()
    await bubble.click()
    expect(consoleWatch.pageErrors).toEqual([])
  }, 180000)
})
