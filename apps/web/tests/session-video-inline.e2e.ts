/** Delivered videos retain independent inline timelines and reviewable shot drafts. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
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

    // Cut analysis belongs to each visible inline card.
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

    expect(await page.locator('[data-muse-video-anchor], [data-muse-video-shelf], [data-muse-video-spacer]').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Conversation videos', exact: true }).count()).toBe(1)
    expect(consoleWatch.pageErrors).toEqual([])
  }, 180000)
})

const GENERATED_A = 'first-generated-three-shots.mp4'
const GENERATED_B = 'second-generated-three-shots.mp4'
const GENERATED_SESSION_A = 'session-inline-generated-a'
const GENERATED_SESSION_B = 'session-inline-generated-b'
const GENERATED_TITLE_A = 'Generated video alpha'
const GENERATED_TITLE_B = 'Generated video beta'

function generatedFixture(title: string, file: string): string {
  const session = Session.create(SessionId('session-inline-generated-fixture'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Review the generated video in this conversation.' },
  ] }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  const callId = ToolCallId('recorded-generated-video')
  const args = JSON.stringify({ media_kind: 'video' })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'jubian_media', arguments: args }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_media', arguments: args })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: [
    { type: 'text', text: JSON.stringify({ path: file }) },
  ] }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', { stream: [], turn: 1, step: 2, message: createMessage({ role: 'assistant',
    content: [{ type: 'text', text: `The generated video for ${title} is ready.` }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

describe('web e2e: generated inline videos stay in their own conversations', () => {
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
    makeVideo(join(scaffold.workspaceCwd, GENERATED_A), ['black', 'white', 'black'])
    makeVideo(join(scaffold.workspaceCwd, GENERATED_B), ['red', 'blue', 'red'])
    await seedSession(scaffold, generatedFixture(GENERATED_TITLE_A, GENERATED_A), GENERATED_SESSION_A)
    await seedSession(scaffold, generatedFixture(GENERATED_TITLE_B, GENERATED_B), GENERATED_SESSION_B)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
    await page.getByRole('treeitem').first().click({ timeout: 15000 })
  }, 180000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('shows recorded generated sources inline and does not carry videos, shots, or drafts across Sessions', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-inline-generated-isolation'))
    const openSession = async (id: string, title: string) => {
      const row = page.locator(`[data-row-key="session:${id}"]`)
      await row.click({ timeout: 15000 })
      await page.getByText(`The generated video for ${title} is ready.`, { exact: true }).waitFor({ timeout: 15000 })
    }
    const openCard = async (label: string, otherLabel: string) => {
      const cards = page.locator('[data-muse-inline-video]')
      await expect.poll(() => cards.count(), { timeout: 30000 }).toBe(1)
      const card = cards.first()
      await card.scrollIntoViewIfNeeded()
      const sources = card.getByRole('combobox', { name: 'Conversation videos' })
      await sources.waitFor({ timeout: 30000 })
      await expect.poll(() => sources.locator('option:checked').textContent()).toBe(label)
      expect(await sources.locator('option').allTextContents()).toEqual([label])
      expect(await sources.locator('option').allTextContents()).not.toContain(otherLabel)
      const video = card.locator('video[data-muse-shelf-video]')
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState),
        { timeout: 30000 }).toBeGreaterThanOrEqual(1)
      const playback = await video.getAttribute('src')
      expect(playback).toContain('api/session-video?')
      const shots = card.getByRole('button', { name: /^Shot \d+ ·/u })
      await expect.poll(() => shots.count(), { timeout: 60000 }).toBe(3)
      return { card, video, shots, playback }
    }

    await openSession(GENERATED_SESSION_A, GENERATED_TITLE_A)
    const first = await openCard(GENERATED_A, GENERATED_B)
    await first.video.evaluate(async (element) => { await (element as HTMLVideoElement).play() })
    await expect.poll(() => first.video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    await first.video.evaluate((element) => { (element as HTMLVideoElement).pause() })
    await first.shots.nth(1).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => first.video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    const input = page.locator('[data-composer-input][contenteditable="true"]').last()
    await input.fill('Keep alpha draft.')
    await first.card.getByRole('button', { name: 'Regenerate this shot', exact: true }).click()
    await expect.poll(() => input.innerText()).toContain(`Regenerate this shot: ${GENERATED_A}`)

    const history = page.locator('[data-muse-session-video-history]')
    const videoMenu = page.getByRole('button', { name: 'Conversation videos', exact: true })
    await videoMenu.click()
    expect(await page.getByRole('menu').getByRole('menuitem').allTextContents()).toEqual([GENERATED_A])
    await page.getByRole('menuitem', { name: GENERATED_A, exact: true }).click()
    await history.locator('[data-muse-inline-video]').waitFor()
    await openSession(GENERATED_SESSION_B, GENERATED_TITLE_B)
    await expect.poll(() => history.count()).toBe(0)
    const second = await openCard(GENERATED_B, GENERATED_A)
    expect(second.playback).not.toBe(first.playback)
    expect(await input.innerText()).not.toContain('Keep alpha draft.')
    expect(await input.innerText()).not.toContain(GENERATED_A)
    await second.shots.nth(1).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => second.video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    await input.fill('Keep beta draft.')
    await second.card.getByRole('button', { name: 'Regenerate this shot', exact: true }).click()
    await expect.poll(() => input.innerText()).toContain(`Regenerate this shot: ${GENERATED_B}`)
    expect(await input.innerText()).toContain('original range: 1.000–2.000 seconds')
    expect(await input.innerText()).not.toContain(GENERATED_A)

    await videoMenu.click()
    expect(await page.getByRole('menu').getByRole('menuitem').allTextContents()).toEqual([GENERATED_B])
    await page.getByRole('menuitem', { name: GENERATED_B, exact: true }).click()
    await history.locator('[data-muse-inline-video]').waitFor()
    await openSession(GENERATED_SESSION_A, GENERATED_TITLE_A)
    if (await history.count() > 0) {
      await expect.poll(() => history.getByRole('combobox', { name: 'Conversation videos' }).locator('option:checked').textContent()).toBe(GENERATED_A)
      await history.getByRole('button', { name: 'Close video', exact: true }).click()
    }
    await openCard(GENERATED_A, GENERATED_B)
    await expect.poll(() => input.innerText()).toContain('Keep alpha draft.')
    expect(await input.innerText()).toContain(GENERATED_A)
    expect(await input.innerText()).not.toContain(GENERATED_B)
    for (const id of [GENERATED_SESSION_A, GENERATED_SESSION_B]) {
      const session = await scaffold.ctx.sessionQuery.readSession(SessionId(id))
      expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
      expect(session.events.filter(event => event.type === 'request/header')).toHaveLength(0)
    }
    expect(consoleWatch.pageErrors).toEqual([])
  }, 180000)
})
