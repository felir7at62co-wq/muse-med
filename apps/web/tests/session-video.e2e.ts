/** Keyless assembled video playback, cut detection, and reviewable shot drafts. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-session-query'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./session-video.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/session-video/inline.expected.md', import.meta.url))
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
    scaffold = await launchWebScaffold({ extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), OVERLAY], profile: { hmr: false, packages: [
      { dir: fileURLToPath(new URL('../../../packages/drama/session-video', import.meta.url)) },
      { dir: fileURLToPath(new URL('../../../packages/client/ui-session-video', import.meta.url)) },
      { dir: fileURLToPath(new URL('../../../packages/bundle/muse-video-ui', import.meta.url)), enabled: true },
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
    await page.getByRole('button', { name: 'Conversation videos', exact: true }).waitFor({ timeout: 15000 })
    await page.waitForSelector('body[data-ds-dark-theme]')
  }, 180000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('opens the session video menu from the standard header without a floating bubble', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-header-menu'))
    const header = page.locator('[data-conversation-header-presentation]')
    expect(await header.getAttribute('data-conversation-header-presentation')).toBe('standard')
    expect(await page.locator('[data-muse-video-anchor], [data-muse-video-shelf], [data-muse-video-spacer], [data-video-absorption]').count()).toBe(0)
    const button = page.getByRole('button', { name: 'Conversation videos', exact: true })
    const card = page.locator('[data-muse-inline-video]').first()
    await page.getByText(TAIL, { exact: true }).scrollIntoViewIfNeeded()
    expect(await card.evaluate((element) => {
      const scroll = element.closest('[data-conversation-scroll]')
      if (!(scroll instanceof HTMLElement)) throw new Error('No conversation scrollport')
      return element.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top
    })).toBe(true)
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const width of [1680, 860]) {
        await page.setViewportSize({ width, height: 1000 })
        await button.click()
        const menu = page.getByRole('menu')
        await menu.getByRole('menuitem', { name: VIDEO, exact: true }).waitFor()
        const box = await menu.boundingBox()
        if (box === null) throw new Error('Video menu has no bounds')
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width)
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'hidden' })
        await button.click()
        await menu.getByRole('menuitem', { name: VIDEO, exact: true }).waitFor()
        await page.getByText(TAIL, { exact: true }).click()
        await menu.waitFor({ state: 'hidden' })
      }
    }
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await header.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await page.getByRole('toolbar', { name: 'Trajectory toolbar', exact: true }).waitFor()
    await button.click()
    await page.getByRole('menuitem', { name: VIDEO, exact: true }).click()
    await expect.poll(() => header.getByRole('tab', { name: 'Chat', exact: true }).getAttribute('aria-selected')).toBe('true')
    const history = page.locator('[data-muse-session-video-history]')
    await history.locator('[data-muse-inline-video]').waitFor()
    expect(await history.evaluate(element => getComputedStyle(element).position)).not.toMatch(/^(absolute|fixed)$/u)
    expect(await history.getByRole('combobox', { name: 'Conversation videos' }).locator('option:checked').textContent()).toBe(VIDEO)
    await history.getByRole('button', { name: 'Close video', exact: true }).click()
    await history.waitFor({ state: 'detached' })
    expect(await card.count()).toBe(1)
    await card.scrollIntoViewIfNeeded()
    await expect.poll(() => card.locator('video').evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
    await expect.poll(() => card.getByRole('button', { name: /^Shot \d+ ·/u }).count(), { timeout: 30000 }).toBe(3)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('plays the delivered video and exposes three real cut ranges in its card', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-playback'))
    const inline = page.locator('[data-muse-inline-video] video')
    await inline.evaluate((element) => { element.scrollIntoView({ block: 'center', behavior: 'instant' }) })
    await expect.poll(() => inline.evaluate(element => (element as HTMLVideoElement).readyState),
      { timeout: 15000 }).toBeGreaterThanOrEqual(1)
    expect(await inline.evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(3)
    await inline.evaluate(async (element) => { await (element as HTMLVideoElement).play() })
    await expect.poll(() => inline.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    await inline.evaluate((element) => { (element as HTMLVideoElement).pause() })

    const shelf = page.locator('[data-muse-inline-video]').first()
    const shots = shelf.getByRole('button', { name: /^Shot \d+ ·/u })
    await expect.poll(() => shots.count(), { timeout: 30000 }).toBe(3)
    expect(await shelf.getByRole('combobox', { name: 'Conversation videos' }).isEnabled()).toBe(true)
    const redo = shelf.getByRole('button', { name: 'Regenerate this shot', exact: true })
    expect(await redo.isVisible()).toBe(true)
    expect(await redo.isDisabled()).toBe(true)
    await redo.locator('..').hover()
    const hint = page.getByRole('tooltip').filter({ hasText: 'Select a shot in the timeline first' })
    await hint.waitFor({ state: 'visible' })
    await page.mouse.move(300, 700)
    await hint.waitFor({ state: 'hidden' })
    await shots.nth(1).focus()
    await page.keyboard.press('Enter')
    const video = shelf.locator('video[data-muse-shelf-video]')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    expect(await shots.nth(1).getAttribute('aria-pressed')).toBe('true')
    expect(await redo.isEnabled()).toBe(true)
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
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-muse-inline-video]', scaffold.workspaceCwd), MODE)
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
    const shelf = page.locator('[data-muse-inline-video]').first()
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

  it('retains an interactive inline card across scrolling, including reduced motion', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-scroll-card'))
    const card = page.locator('[data-muse-inline-video]').first()
    const wrapper = page.locator('[data-presented-file][data-video]').filter({ has: card })
    const handle = await card.elementHandle()
    const wrapperHandle = await wrapper.elementHandle()
    if (handle === null || wrapperHandle === null) throw new Error('Inline video has no stable delivery')
    const video = card.locator('video')
    const preview = wrapper.getByRole('button', { name: /Preview .*three-shots\.mp4.*sidebar/u })
    const shots = card.getByRole('button', { name: /^Shot \d+ ·/u })
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion })
      await card.scrollIntoViewIfNeeded()
      expect(await preview.isVisible()).toBe(true)
      expect(await preview.isEnabled()).toBe(true)
      await expect.poll(() => shots.count()).toBe(3)
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
      const before = await card.evaluate((element) => {
        const scroll = element.closest('[data-conversation-scroll]')
          ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
        if (!(scroll instanceof HTMLElement)) throw new Error('Inline card has no conversation scroll')
        return { height: element.getBoundingClientRect().height, scrollHeight: scroll.scrollHeight }
      })
      await page.getByText(TAIL, { exact: true }).scrollIntoViewIfNeeded()
      await expect.poll(() => card.evaluate((element) => {
        const scroll = element.closest('[data-conversation-scroll]')
          ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
        if (!(scroll instanceof HTMLElement)) throw new Error('Inline card lost its scrollport')
        return element.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top
      })).toBe(true)
      expect(await handle.evaluate(element => element.isConnected)).toBe(true)
      expect(await wrapperHandle.evaluate(element => element.isConnected)).toBe(true)
      expect(await wrapper.evaluate(element => ({ visibility: getComputedStyle(element).visibility,
        inert: (element as HTMLElement).inert }))).toEqual({ visibility: 'visible', inert: false })
      await card.scrollIntoViewIfNeeded()
      expect(await handle.evaluate(element => element.isConnected)).toBe(true)
      expect(await wrapperHandle.evaluate(element => element.isConnected)).toBe(true)
      expect(await card.evaluate((element) => {
        const scroll = element.closest('[data-conversation-scroll]')
          ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
        if (!(scroll instanceof HTMLElement)) throw new Error('Inline card lost its scrollport')
        return { height: element.getBoundingClientRect().height, scrollHeight: scroll.scrollHeight,
          visibility: getComputedStyle(element).visibility, inert: element.closest('[inert]') !== null }
      })).toEqual({ ...before, visibility: 'visible', inert: false })
      expect(await preview.isEnabled()).toBe(true)
      await shots.nth(1).focus(); await page.keyboard.press('Enter')
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
      expect(await card.getByRole('button', { name: 'Regenerate this shot', exact: true }).isEnabled()).toBe(true)
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
    const shelf = page.locator('[data-muse-inline-video]').first()
    const select = shelf.getByRole('combobox', { name: 'Conversation videos' })
    await shelf.scrollIntoViewIfNeeded()
    await select.locator('option', { hasText: 'synthetic-jubian-three-shots.mp4' }).waitFor({ state: 'attached' })
    await page.getByRole('button', { name: 'Conversation videos', exact: true }).click()
    const items = page.getByRole('menu').getByRole('menuitem')
    expect(await items.allTextContents()).toEqual(['synthetic-jubian-three-shots.mp4', VIDEO])
    await page.keyboard.press('Escape')
    await select.selectOption({ label: 'synthetic-jubian-three-shots.mp4' })
    const video = shelf.locator('[data-muse-shelf-video]')
    await expect.poll(() => video.getAttribute('src'), { timeout: 30000 }).toContain('api/session-video?')
    await expect.poll(() => shelf.getByRole('button', { name: /^Shot \d+ ·/u }).count(), { timeout: 30000 }).toBe(6)
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    await expect.poll(() => shelf.getByRole('button', { name: /^Shot 4 ·/u })
      .evaluate(element => element.style.getPropertyValue('--video-shot-thumbnail').startsWith('url(')), { timeout: 10000 }).toBe(true)
    const redo = shelf.getByRole('button', { name: 'Regenerate this shot', exact: true })
    expect(await redo.isVisible()).toBe(true)
    expect(await redo.isDisabled()).toBe(true)
    await shelf.getByRole('button', { name: /^Shot 4 ·/u }).focus()
    await page.keyboard.press('Enter')
    expect(await redo.isEnabled()).toBe(true)
    await select.selectOption({ label: 'three-shots.mp4' })
    expect(await redo.isDisabled()).toBe(true)
    await select.selectOption({ label: 'synthetic-jubian-three-shots.mp4' })
    expect(await redo.isDisabled()).toBe(true)
    expect(downloads).toBe(1)
    expect(await shelf.locator('[data-muse-shelf-video]').count()).toBe(1)
    const recorded = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    expect(recorded.events.filter(event => event.type === 'request/header')).toHaveLength(0)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('drags the real playhead continuously within a file and across source boundaries', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-pointer-drag'))
    const shelf = page.locator('[data-muse-inline-video]').first()
    await shelf.scrollIntoViewIfNeeded()
    const shots = shelf.getByRole('button', { name: /^Shot \d+ ·/u })
    await expect.poll(() => shots.count(), { timeout: 30000 }).toBe(6)
    await expect.poll(() => shelf.evaluate(element => element.getAnimations({ subtree: true })
      .every(animation => animation.playState === 'finished' || animation.playState === 'idle'))).toBe(true)
    const slider = shelf.getByRole('slider', { name: 'Playback position', exact: true })
    for (const target of [1.5, 4.5]) {
      await slider.focus(); await page.keyboard.press('Home')
      await expect.poll(() => slider.getAttribute('aria-valuenow')).toBe('0')
      await expect.poll(() => shelf.locator('[data-muse-shelf-video]').evaluate(element => (element as HTMLVideoElement).readyState))
        .toBeGreaterThanOrEqual(1)
      const cap = await slider.locator('span').first().boundingBox()
      if (cap === null) throw new Error('Playhead cap is outside the viewport')
      const pixelsPerSecond = await shots.nth(1).evaluate(element => Number.parseFloat(element.style.getPropertyValue('--video-shot-left')))
      const original = await slider.elementHandle()
      await page.mouse.move(cap.x + cap.width / 2, cap.y + cap.height / 2)
      await page.mouse.down()
      try {
        await page.mouse.move(cap.x + cap.width / 2 + target * pixelsPerSecond, cap.y + cap.height / 2, { steps: 24 })
        const connected = await original?.evaluate(element => element.isConnected)
        await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')),
          { message: `drag to ${target}s while held; original slider connected=${String(connected)}` }).toBeCloseTo(target, 1)
        await expect.poll(() => shelf.locator('[data-muse-shelf-video]').evaluate(element => (element as HTMLVideoElement).currentTime))
          .toBeCloseTo(target < 3 ? target : target - 3, 1)
      } finally { await page.mouse.up() }
    }
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('holds the playhead under the pointer at an existing time under desktop CSS scaling', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-scaled-pointer'))
    const shelf = page.locator('[data-muse-inline-video]').first()
    await shelf.scrollIntoViewIfNeeded()
    const slider = shelf.getByRole('slider', { name: 'Playback position', exact: true })
    const shots = shelf.getByRole('button', { name: /^Shot \d+ ·/u })
    const originalPlatform = await page.locator('html').getAttribute('data-platform')
    try {
      await page.evaluate(() => { document.documentElement.setAttribute('data-platform', 'darwin') })
      for (const scale of [1, .8, 1.25]) {
        await page.evaluate((value) => { document.documentElement.style.zoom = String(value) }, scale)
        for (const start of [1, 4]) {
          await shots.nth(start).focus(); await page.keyboard.press('Enter')
          await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeCloseTo(start, 2)
          await slider.evaluate((element) => { element.scrollIntoView({ block: 'center', behavior: 'instant' }) })
          await expect.poll(() => slider.evaluate((element) => {
            const cap = element.querySelector('span')?.getBoundingClientRect()
            return cap !== undefined && element.contains(document.elementFromPoint(cap.left + cap.width / 2, cap.top + cap.height / 2))
          })).toBe(true)
          const cap = await slider.locator('span').first().boundingBox()
          if (cap === null) throw new Error('Scaled playhead cap is outside the viewport')
          const first = await shots.nth(0).boundingBox(), next = await shots.nth(1).boundingBox()
          if (first === null || next === null) throw new Error('Scaled shot positions are outside the viewport')
          const effectivePixelsPerSecond = next.x - first.x
          const x = cap.x + cap.width / 2, y = cap.y + cap.height / 2
          await page.mouse.move(x, y)
          await page.mouse.down()
          try {
            await slider.evaluate(async () => {
              await new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
            })
            await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')),
              { message: `press at ${start}s with CSS zoom ${scale} must preserve the position` }).toBeCloseTo(start, 2)
            await page.mouse.move(x + 30, y, { steps: 12 })
            const target = start + 30 / effectivePixelsPerSecond
            await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')),
              { message: `30 client pixels at CSS zoom ${scale}` }).toBeCloseTo(target, 2)
            await expect.poll(() => shelf.locator('[data-muse-shelf-video]')
              .evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(target < 3 ? target : target - 3, 2)
          } finally { await page.mouse.up() }
        }
      }
    } finally {
      await page.evaluate((platform) => {
        document.documentElement.style.zoom = ''
        if (platform === null) document.documentElement.removeAttribute('data-platform')
        else document.documentElement.setAttribute('data-platform', platform)
      }, originalPlatform)
    }
    expect(consoleWatch.pageErrors).toEqual([])
  })


  it('zooms the ruler and filmstrip with real controls while preserving paused time and the draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-timeline-zoom'))
    const shelf = page.locator('[data-muse-inline-video]').first()
    await shelf.scrollIntoViewIfNeeded()
    const zoom = shelf.getByRole('group', { name: 'Timeline zoom', exact: true })
    const range = zoom.getByRole('slider', { name: 'Timeline zoom', exact: true })
    const play = shelf.getByRole('button', { name: 'Play', exact: true })
    const zoomBounds = await zoom.boundingBox(), playBounds = await play.boundingBox()
    if (zoomBounds === null || playBounds === null) throw new Error('Timeline controls are outside the viewport')
    expect(zoomBounds.x).toBeGreaterThan(playBounds.x + playBounds.width)
    const vertical = await play.evaluate((element) => {
      const controls = element.closest('[data-muse-video-controls]')
      const picture = controls?.previousElementSibling
      const timeline = controls?.nextElementSibling
      if (controls == null || picture == null || timeline == null) throw new Error('Playback controls have no neighboring picture or timeline')
      const button = element.getBoundingClientRect(), above = picture.getBoundingClientRect(), below = timeline.getBoundingClientRect()
      const middle = controls.getBoundingClientRect(), zoom = controls.querySelector('[role="group"]')?.getBoundingClientRect()
      return { gapAbove: button.top - above.bottom, gapBelow: below.top - button.bottom,
        centerDelta: Math.abs(button.top + button.height / 2 - middle.top - middle.height / 2),
        zoomDelta: zoom === undefined ? Infinity : Math.abs(zoom.top + zoom.height / 2 - button.top - button.height / 2) }
    })
    expect(vertical.gapAbove).toBeGreaterThanOrEqual(6)
    expect(vertical.gapBelow).toBeGreaterThanOrEqual(6)
    expect(vertical.gapAbove).toBeCloseTo(vertical.gapBelow, 2)
    expect(vertical.centerDelta).toBeLessThanOrEqual(1)
    expect(vertical.zoomDelta).toBeLessThanOrEqual(1)
    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = await editor.innerText()
    const beforeEvents = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    const beforeUsers = beforeEvents.events.filter(event => event.type === 'user/message').length
    const video = shelf.locator('[data-muse-shelf-video]')
    expect(await video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
    const time = await video.evaluate(element => (element as HTMLVideoElement).currentTime)
    const playhead = shelf.getByRole('slider', { name: 'Playback position', exact: true })
    const position = await playhead.getAttribute('aria-valuenow')
    const scale = Number(await range.inputValue())
    const shots = shelf.getByRole('button', { name: /^Shot \d+ ·/u })
    const lastShot = shots.last()
    const measure = async () => ({
      width: await lastShot.evaluate(element => element.getBoundingClientRect().width),
      end: await shelf.locator('[data-end="true"]').evaluate(element => Number.parseFloat((element as HTMLElement).style
        .getPropertyValue('--video-tick-left'))),
    })
    const base = await measure()
    await range.focus(); await page.keyboard.press('Home')
    const rangeBounds = await range.boundingBox()
    if (rangeBounds === null) throw new Error('Zoom range is outside the viewport')
    await page.mouse.move(rangeBounds.x + 4, rangeBounds.y + rangeBounds.height / 2)
    await page.mouse.down()
    try {
      await page.mouse.move(rangeBounds.x + rangeBounds.width * .6, rangeBounds.y + rangeBounds.height / 2, { steps: 12 })
      await expect.poll(async () => Number(await range.inputValue())).toBeGreaterThan(.25)
    } finally { await page.mouse.up() }
    const mouseScale = Number(await range.inputValue())
    expect(mouseScale).toBeLessThan(4)
    await expect.poll(() => range.getAttribute('aria-valuetext')).toBe(`Timeline zoom ${Math.round(mouseScale * 100)}%`)
    const mouseGeometry = await measure()
    expect(mouseGeometry.width).toBeCloseTo(base.width * mouseScale / scale, 1)
    expect(mouseGeometry.end).toBeCloseTo(base.end * mouseScale / scale, 1)
    expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(time, 3)
    expect(await playhead.getAttribute('aria-valuenow')).toBe(position)
    for (const key of ['End', 'Home']) {
      await range.focus(); await page.keyboard.press(key)
      const nextScale = Number(await range.inputValue())
      expect(nextScale).toBe(key === 'End' ? 4 : .25)
      const next = await measure()
      expect(next.width).toBeCloseTo(base.width * nextScale / scale, 1)
      expect(next.end).toBeCloseTo(base.end * nextScale / scale, 1)
      expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(time, 3)
      expect(await playhead.getAttribute('aria-valuenow')).toBe(position)
    }
    expect(await zoom.getByRole('button', { name: 'Zoom out timeline', exact: true }).isDisabled()).toBe(true)
    await zoom.getByRole('button', { name: 'Zoom in timeline', exact: true }).click()
    expect(Number(await range.inputValue())).toBe(.5)
    await zoom.getByRole('button', { name: 'Zoom out timeline', exact: true }).click()
    expect(Number(await range.inputValue())).toBe(.25)
    await range.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
    expect(Number(await range.inputValue())).toBe(1)
    expect(await editor.innerText()).toBe(draft)
    const afterEvents = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    expect(afterEvents.events.filter(event => event.type === 'user/message')).toHaveLength(beforeUsers)
    expect(afterEvents.events.filter(event => event.type === 'request/header')).toHaveLength(0)
    expect(consoleWatch.pageErrors).toEqual([])
  })


  it('hot-unplugs the complete presentation, preserves draft and jobs, and persists across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-plugin-switch'))
    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this unfinished instruction while switching the video presentation.'
    await editor.fill(draft)
    const savedDraft = () => page.evaluate((id) => {
      const raw = localStorage.getItem(`dsh.conversation.${id}`)
      const stored: unknown = raw === null ? null : JSON.parse(raw)
      if (stored === null || typeof stored !== 'object' || !('draft' in stored)) throw new Error('Draft is not persisted')
      return stored.draft
    }, SESSION)
    await expect.poll(savedDraft).toMatchObject({ text: draft })
    const persistedDraft = await savedDraft()
    const originalEvents = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    const agent = scaffold.ctx.agents.get(SessionId(SESSION))
    if (agent === undefined) throw new Error('Opened fixture has no Agent')
    const release = '.session-video-plugin-switch.release'
    const started = await executeToolFixture(scaffold.ctx, {
      signal: new AbortController().signal, callId: ToolCallId('session-video-plugin-switch'), name: 'bash', agent,
      arguments: { command: `printf 'presentation-switch-job\\n'; for _ in $(seq 1 1200); do [ -e ${release} ] && break; sleep 0.1; done`,
        description: 'Retain background work while switching the presentation', run_in_background: true },
    })
    const match = /\bbash-[0-9a-f]{16}\b/u.exec(started.content.map(block => block.type === 'text' ? block.text : '').join(''))
    if (match === null) throw new Error('No background job receipt')
    const jobId = JobId(match[0])
    try {
      const button = page.getByRole('button', { name: 'Conversation videos', exact: true })
      const oldVideo = await page.locator('[data-muse-inline-video] video').first().elementHandle()
      const transcript = await page.locator('[data-chat-frame]').elementHandle()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      const toggle = dialog.getByRole('switch', { name: 'Video cards and timeline', exact: true })
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      await expect.poll(() => button.count()).toBe(0)
      expect(await page.locator('[data-muse-video-shelf], [data-muse-video-spacer], [data-muse-inline-video], [data-video-absorption]').count()).toBe(0)
      expect(await transcript?.evaluate(element => element.isConnected)).toBe(true)
      expect(await oldVideo?.evaluate(element => ({ connected: element.isConnected, src: element.getAttribute('src'), paused: (element as HTMLVideoElement).paused })))
        .toEqual({ connected: false, src: null, paused: true })
      const header = page.locator('[data-conversation-header-presentation]')
      await expect.poll(() => header.getAttribute('data-conversation-header-presentation')).toBe('standard')
      expect(await header.evaluate(element => getComputedStyle(element).position)).not.toBe('absolute')
      expect(await header.getByRole('tab', { name: 'Chat', exact: true }).count()).toBe(1)
      expect(await page.locator('[data-presented-file][data-video="true"] video').count()).toBeGreaterThan(0)
      expect(await page.locator('[data-presented-file][data-video="true"]').evaluateAll(elements => elements.every(element =>
        !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true' && getComputedStyle(element).visibility !== 'hidden'))).toBe(true)
      expect(await editor.innerText()).toBe(draft)
      expect(scaffold.ctx.jobs.get(jobId, agent.id).status).toBe('running')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/session-video/plugin-switch.expected.md', import.meta.url)), [
        '- Optional presentation: disabled', '- Native header: standard; Chat tab available',
        '- Original video player: available', '- Chat video cards and video menu: removed',
        '- Transcript: same mounted instance', '- Composer draft: preserved', '- Background job: running',
        await captureStableAria(page, '[data-muse-presentation-setting]', scaffold.workspaceCwd, { runningJobs: 'keep' }),
      ].join('\n'), MODE)
      await page.reload({ waitUntil: 'load' })
      await page.getByText(TAIL, { exact: true }).waitFor()
      expect(await button.count()).toBe(0)
      expect(await header.getAttribute('data-conversation-header-presentation')).toBe('standard')
      expect(await savedDraft()).toEqual(persistedDraft)
      const restoredDraft = await editor.innerText()
      expect(restoredDraft).toBe(draft)
      expect(readFileSync(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toContain('enabled: false')
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      for (const enabled of [true, false, true]) {
        await toggle.click()
        await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
        await expect.poll(() => button.count()).toBe(enabled ? 1 : 0)
        await expect.poll(() => header.getAttribute('data-conversation-header-presentation')).toBe('standard')
      }
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
      await expect.poll(() => page.locator('[data-muse-inline-video]').count()).toBe(2)
      await button.click()
      await page.getByRole('menuitem', { name: VIDEO, exact: true }).click()
      const history = page.locator('[data-muse-session-video-history]')
      await history.locator('[data-muse-inline-video] video').waitFor()
      expect(await page.locator('[data-muse-video-spacer], [data-muse-video-shelf]').count()).toBe(0)
      await history.getByRole('button', { name: 'Close video', exact: true }).click()
      expect(await editor.innerText()).toBe(restoredDraft)
      expect(await savedDraft()).toEqual(persistedDraft)
      expect(scaffold.ctx.jobs.get(jobId, agent.id).status).toBe('running')
      const finalEvents = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
      expect(finalEvents.events.filter(event => ['user/message', 'request/header'].includes(event.type)))
        .toEqual(originalEvents.events.filter(event => ['user/message', 'request/header'].includes(event.type)))
    } finally {
      await writeFile(join(scaffold.workspaceCwd, release), '')
      const settled = await scaffold.ctx.jobs.wait(jobId, 15000, agent.id)
      expect(settled.status).not.toBe('running')
      await scaffold.ctx.settings.update('ui-session-video', { enabled: true })
    }
    expect(consoleWatch.pageErrors).toEqual([])
  }, 90000)

})
