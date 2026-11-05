/** Keyless assembled video playback, cut detection, and reviewable shot drafts. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-session-query'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./session-video.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/session-video/shelf.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SESSION = 'session-video-keyless-web-e2e'
const TITLE = 'Session video inspection'
const VIDEO = 'three-shots.mp4'
const TAIL = 'SESSION_VIDEO_TRANSCRIPT_END'

function fixture(): string {
  const session = Session.create(SessionId('session-video-fixture-source'))
  const message = (turn: number, text: string) => {
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', { stream: [], turn, step: 1, message: createMessage({ role: 'assistant',
      content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
  }
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Inspect this existing video without generating anything.' },
  ] }), { surfaceOp: 'append' })
  session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  message(1, 'The original three-shot video is ready for review.')
  session.append('deliverables/presented', { turn: 1, callId: ToolCallId('present-synthetic-video'), files: [
    { path: VIDEO, description: 'Synthetic black, white, black video; three seconds.' },
  ] })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Keep the video available while I read the rest of the conversation.' },
  ] }), { surfaceOp: 'append' })
  message(2, [...Array.from({ length: 32 }, (_, index) =>
    `Review note ${index + 1}: the conversation keeps the original video available. Scroll back to compare the recorded frames before writing a change request.`), TAIL].join('\n\n'))
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

describe('web e2e: recorded conversation video inspection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleWatch: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, profile: { hmr: false, packages: [
      { dir: fileURLToPath(new URL('../../../packages/drama/session-video', import.meta.url)) },
      { dir: fileURLToPath(new URL('../../../packages/client/ui-session-video', import.meta.url)) },
    ] } })
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
      '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
      '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-threads', '1',
      '-pix_fmt', 'yuv420p', join(scaffold.workspaceCwd, VIDEO)])
    await seedSession(scaffold, fixture(), SESSION)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.emulateMedia({ colorScheme: 'dark' })
    consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
    const group = page.getByRole('treeitem').first()
    await group.waitFor({ timeout: 15000 })
    await group.click()
    const sessionRow = page.getByRole('treeitem').nth(1)
    await sessionRow.waitFor({ timeout: 10000 })
    await sessionRow.click()
    await page.getByText(TAIL, { exact: true }).waitFor({ timeout: 15000 })
    await page.locator('[data-muse-video-anchor]').waitFor({ timeout: 15000 })
    await page.waitForSelector('body[data-ds-dark-theme]')
  }, 180000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('plays the native delivery and exposes three real cut ranges through one shelf player', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-playback'))
    const inline = page.locator('[data-muse-inline-video] video')
    await inline.evaluate((element) => { element.scrollIntoView({ block: 'center', behavior: 'instant' }) })
    await expect.poll(() => inline.evaluate(element => (element as HTMLVideoElement).readyState),
      { timeout: 15000 }).toBeGreaterThanOrEqual(1)
    expect(await inline.evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(3)
    await inline.evaluate(async (element) => { await (element as HTMLVideoElement).play() })
    await expect.poll(() => inline.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    await inline.evaluate((element) => { (element as HTMLVideoElement).pause() })

    const anchor = page.locator('[data-muse-video-anchor]')
    await anchor.click()
    const shelf = page.locator('[data-muse-video-shelf]')
    const shots = shelf.getByRole('button', { name: /^Shot \d+ ·/u })
    await expect.poll(() => shots.count(), { timeout: 30000 }).toBe(3)
    await expect.poll(() => shelf.evaluate(element => element.getAnimations({ subtree: true })
      .every(animation => animation.playState === 'finished' || animation.playState === 'idle'))).toBe(true)
    await expect.poll(() => shelf.getByRole('group', { name: 'Video shots' }).evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const seat = element.closest('[data-muse-video-shelf]')?.getBoundingClientRect()
      return seat !== undefined && bounds.height >= 78 && bounds.bottom <= seat.bottom && bounds.bottom < innerHeight
        && [...element.querySelectorAll('button')].every((button) => {
          const box = button.getBoundingClientRect()
          return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
        })
    })).toBe(true)
    expect(await page.locator('[data-muse-shelf-video]').count()).toBe(1)
    await shots.nth(1).focus()
    await page.keyboard.press('Enter')
    const video = shelf.locator('video[data-muse-shelf-video]')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    expect(await shots.nth(1).getAttribute('aria-pressed')).toBe('true')
    const play = shelf.getByRole('button', { name: 'Play', exact: true })
    expect(await play.evaluate((element) => {
      const button = element.getBoundingClientRect()
      const icon = element.querySelector('svg')?.getBoundingClientRect()
      return { button: [button.width, button.height], icon: [icon?.width, icon?.height] }
    })).toEqual({ button: [22, 22], icon: [20, 20] })
    expect(await play.locator('svg').getAttribute('data-icon')).toContain('play-triangle-outline')
    await play.click()
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false)
    const pause = shelf.getByRole('button', { name: 'Pause', exact: true })
    expect(await pause.locator('svg').getAttribute('data-icon')).toContain('pause-bars-outline')
    await pause.click()
    await shots.nth(1).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-muse-video-shelf]', scaffold.workspaceCwd), MODE)
    await anchor.click()
    expect(await page.locator('[data-muse-shelf-video]').count()).toBe(0)
    await anchor.click()
    expect(await page.locator('[data-muse-shelf-video]').count()).toBe(1)
    await expect.poll(() => shelf.evaluate(element => element.getAnimations({ subtree: true })
      .every(animation => animation.playState === 'finished' || animation.playState === 'idle'))).toBe(true)
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    await expect.poll(() => shots.first().evaluate(element => element.style.getPropertyValue('--video-shot-thumbnail').startsWith('url(')),
      { timeout: 10000 }).toBe(true)
    if (process.env.DSH_VIDEO_SCREENSHOT) {
      await page.getByText(TAIL, { exact: true }).evaluate((element) => {
        element.scrollIntoView({ block: 'center', behavior: 'instant' })
      })
      await page.screenshot({ path: process.env.DSH_VIDEO_SCREENSHOT })
    }
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('appends the selected shot to the existing draft without sending a new message', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-redo-draft'))
    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this unfinished instruction.'
    await editor.fill(draft)
    const before = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    const userCount = before.events.filter(event => event.type === 'user/message').length
    const shelf = page.locator('[data-muse-video-shelf]')
    await shelf.getByRole('button', { name: /^Shot 2 ·/u }).focus()
    await page.keyboard.press('Enter')
    await shelf.getByRole('button', { name: 'Regenerate this shot', exact: true }).click()
    await expect.poll(() => editor.innerText()).toContain('Regenerate this shot: three-shots.mp4')
    const text = await editor.innerText()
    expect(text.startsWith(draft)).toBe(true)
    expect(text).toContain('original range: 1.000–2.000 seconds')
    const after = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    expect(after.events.filter(event => event.type === 'user/message')).toHaveLength(userCount)
    expect(after.events.filter(event => event.type === 'request/header')).toHaveLength(0)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('collects and restores the same inline node without changing transcript layout, including reduced motion', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-scroll-collection'))
    const anchor = page.locator('[data-muse-video-anchor]')
    if (await anchor.getAttribute('aria-expanded') === 'true') await anchor.click()
    const card = page.locator('[data-muse-inline-video]')
    const layer = page.locator('[data-video-absorption]')
    const handle = await card.elementHandle()
    if (handle === null) throw new Error('Inline video has no stable card')
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion })
      await card.evaluate((element) => { element.scrollIntoView({ block: 'center', behavior: 'instant' }) })
      await expect.poll(() => layer.getAttribute('data-phase')).toBe('idle')
      const before = await card.evaluate((element) => {
        const scroll = element.closest('[data-conversation-scroll]')
          ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
        if (scroll === undefined || scroll === null) throw new Error('Inline card has no conversation scroll')
        return { height: element.getBoundingClientRect().height, scrollHeight: scroll.scrollHeight }
      })
      const box = await card.boundingBox()
      if (box === null) throw new Error('Inline card is outside the viewport')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 6000)
      await expect.poll(() => layer.getAttribute('data-phase')).toBe('collected')
      expect(await handle.evaluate(element => element.isConnected)).toBe(true)
      const after = await card.evaluate((element) => {
        const scroll = element.closest('[data-conversation-scroll]')
          ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
        if (scroll === undefined || scroll === null) throw new Error('Inline card lost its conversation scroll')
        return { height: element.getBoundingClientRect().height, scrollHeight: scroll.scrollHeight,
          visibility: getComputedStyle(element).visibility, inert: (element as HTMLElement).inert }
      })
      expect(after.height).toBe(before.height)
      expect(after.scrollHeight).toBe(before.scrollHeight)
      expect(after.visibility).toBe('hidden')
      expect(after.inert).toBe(true)
      await card.evaluate((element) => { element.scrollIntoView({ block: 'center', behavior: 'instant' }) })
      await expect.poll(() => layer.getAttribute('data-phase')).toBe('idle')
      expect(await handle.evaluate(element => element.isConnected)).toBe(true)
      expect(await card.evaluate(element => getComputedStyle(element).visibility)).toBe('visible')
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('downloads a recorded provider result into same-origin playback and real thumbnails without external traffic', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-provider-download'))
    const url = 'https://101.aigc.jubianai.net/synthetic-jubian-three-shots.mp4'
    const bytes = readFileSync(join(scaffold.workspaceCwd, VIDEO))
    await page.route(url, route => route.fulfill({ status: 200, contentType: 'video/mp4', body: bytes }))
    const originalFetch = globalThis.fetch
    let downloads = 0
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const address = input instanceof Request ? input.url : input.toString()
      if (address !== url) return originalFetch(input, init)
      downloads++
      expect(init?.credentials).toBe('omit')
      expect(init?.redirect).toBe('error')
      return new Response(bytes)
    })
    onTestFinished(async () => { transport.mockRestore(); await page.unroute(url) })
    const agent = scaffold.ctx.agents.list().find(value => value.session.id === SESSION)
    if (agent === undefined) throw new Error('Opened fixture has no live Session')
    const session = agent.session
    const callId = ToolCallId('recorded-jubian-video-result')
    session.append('turn/start', { turn: 3 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: 'Inspect this previously completed provider video.' },
    ] }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 3, step: 1 })
    session.append('tool/call', { turn: 3, step: 1, name: 'jubian_video', callId,
      arguments: JSON.stringify({ method: 'subtasks', task_id: 7 }) })
    session.append('tool/result', { turn: 3, step: 1, message: createToolResultMessage({ callId, isError: false, content: [
      { type: 'text', text: JSON.stringify({ subtasks: { rows: [{ parent_task_id: 7, status: 'succeeded', video_url: url }] } }) },
    ] }) }, { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [], turn: 3, step: 1, message: createMessage({ role: 'assistant',
      content: [{ type: 'text', text: 'The previously completed video is ready to inspect.' }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 3, step: 1 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(session)
    const shelf = page.locator('[data-muse-video-shelf]')
    const select = shelf.getByRole('combobox', { name: 'Conversation videos' })
    if (await page.locator('[data-muse-video-anchor]').getAttribute('aria-expanded') !== 'true') {
      await page.locator('[data-muse-video-anchor]').click()
    }
    await select.locator('option', { hasText: 'synthetic-jubian-three-shots.mp4' }).waitFor({ state: 'attached' })
    await select.selectOption({ label: 'synthetic-jubian-three-shots.mp4' })
    const video = shelf.locator('[data-muse-shelf-video]')
    await expect.poll(() => video.getAttribute('src'), { timeout: 30000 }).toContain('api/session-video?')
    await expect.poll(() => shelf.getByRole('button', { name: /^Shot \d+ ·/u }).count(), { timeout: 30000 }).toBe(6)
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    await expect.poll(() => shelf.getByRole('button', { name: /^Shot 4 ·/u })
      .evaluate(element => element.style.getPropertyValue('--video-shot-thumbnail').startsWith('url(')), { timeout: 10000 }).toBe(true)
    expect(downloads).toBe(1)
    expect(await shelf.locator('[data-muse-shelf-video]').count()).toBe(1)
    const recorded = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    expect(recorded.events.filter(event => event.type === 'request/header')).toHaveLength(0)
    expect(consoleWatch.pageErrors).toEqual([])
  })
})
