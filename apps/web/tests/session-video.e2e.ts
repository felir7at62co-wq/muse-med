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

  it('floats native controls above a fading transcript and keeps the dark spider at the top', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-floating-header'))
    const header = page.locator('[data-conversation-header-presentation="floating"]')
    expect(await header.evaluate(element => getComputedStyle(element).position)).toBe('absolute')
    expect(await header.evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe('0px')
    const hierarchy = header.getByRole('navigation', { name: 'Session hierarchy' })
    expect(await hierarchy.count()).toBe(1)
    expect(await hierarchy.textContent()).toContain(TITLE)
    expect(await header.getByRole('tab').count()).toBe(0)
    const anchor = page.locator('[data-muse-video-anchor]')
    const geometry = await anchor.evaluate((element) => {
      const viewport = element.closest('[data-conversation-scroll]')
      if (viewport === null) throw new Error('Spider has no conversation scrollport')
      return { offset: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
        background: getComputedStyle(element).backgroundColor, ink: getComputedStyle(element).color }
    })
    expect(geometry.offset).toBeGreaterThanOrEqual(6)
    expect(geometry.offset).toBeLessThanOrEqual(12)
    expect(geometry.background).toBe('rgb(27, 27, 28)')
    const sourcePill = page.locator('[data-muse-video-source-pill]')
    await sourcePill.waitFor({ state: 'attached' })
    expect(await sourcePill.evaluate(element => ({ opacity: getComputedStyle(element).opacity, inert: (element as HTMLElement).inert })))
      .toEqual({ opacity: '0', inert: true })
    expect(await page.locator('[data-muse-video-shelf]').getByRole('combobox', { name: 'Conversation videos' }).count()).toBe(0)
    const fade = page.locator('[class*="headerFade"]')
    expect(await fade.evaluate(element => getComputedStyle(element).backgroundImage)).toContain('linear-gradient')
    expect(await fade.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body[data-ds-dark-theme]').count()).toBe(0)
    expect(await anchor.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(geometry.background)
    expect(await anchor.evaluate(element => getComputedStyle(element).color)).toBe(geometry.ink)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForSelector('body[data-ds-dark-theme]')
    const moreViews = header.getByRole('button', { name: 'More conversation views', exact: true })
    await moreViews.click()
    await page.getByRole('menuitem', { name: 'Trajectory', exact: true }).click()
    await expect.poll(() => page.locator('[data-muse-video-anchor]').count()).toBe(0)
    await moreViews.click()
    await page.getByRole('menuitem', { name: 'Chat', exact: true }).click()
    await page.locator('[data-muse-video-anchor]').waitFor()
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('opens and closes the curtain over a stable transcript throughout normal and reduced motion', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-curtain-flow'))
    const paragraph = page.getByText(/^Review note 18: /u)
    const anchor = page.locator('[data-muse-video-anchor]')
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion })
      if (await anchor.getAttribute('aria-expanded') === 'true') await anchor.click()
      await paragraph.evaluate(async (element) => {
        await document.fonts.ready
        element.scrollIntoView({ block: 'start', behavior: 'instant' })
        const scroll = element.closest('[data-conversation-scroll]')
          ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
        if (!(scroll instanceof HTMLElement)) throw new Error('Transcript has no scrollport')
        scroll.scrollTop = Math.max(0, scroll.scrollTop - 100)
      })
      for (const expanded of [true, false]) {
        const observation = await paragraph.evaluate(async (element, expand) => {
          const scroll = element.closest('[data-conversation-scroll]')
            ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
          const frame = element.closest('[data-chat-frame]')
          const shelf = frame?.querySelector('[data-muse-video-shelf]')
          const toggle = shelf?.querySelector('[data-muse-video-anchor]')
          const bubble = toggle?.closest('section')
          if (!(scroll instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement) || !(bubble instanceof HTMLElement)) {
            throw new Error('Video curtain has no owning transcript')
          }
          const snapshot = () => {
            const rect = element.getBoundingClientRect()
            return { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, top: rect.top, left: rect.left,
              width: rect.width, height: rect.height, connected: element.isConnected }
          }
          const before = snapshot()
          const frames: ReturnType<typeof snapshot>[] = []
          const visuals = new Set<string>()
          let running = false
          toggle.click()
          const started = performance.now()
          while (performance.now() - started < 1200) {
            await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
            frames.push(snapshot())
            const curtain = bubble.querySelector<HTMLElement>('[class*="curtain"]')
            const nodes = [bubble, curtain, curtain?.firstElementChild].filter((node): node is HTMLElement => node instanceof HTMLElement)
            running ||= nodes.some(node => node.getAnimations().some(animation => animation.playState === 'running'))
            visuals.add(JSON.stringify(nodes.map((node) => {
              const style = getComputedStyle(node)
              return [style.opacity, style.transform, style.clipPath, node.getBoundingClientRect().height]
            })))
          }
          const picture = bubble.querySelector('[data-muse-shelf-video]')?.getBoundingClientRect()
          const probe = picture !== undefined
            ? { x: picture.left + picture.width / 2, y: picture.top + picture.height / 2 }
            : { x: before.left + before.width / 2, y: before.top + before.height / 2 }
          const hit = document.elementFromPoint(probe.x, probe.y)
          return { before, frames, running, visualStates: visuals.size,
            expanded: toggle.getAttribute('aria-expanded') === 'true',
            hitShelf: hit?.closest('[data-muse-video-shelf]') !== null && hit !== null,
            expectedExpanded: expand }
        }, expanded)
        expect(observation.expanded).toBe(observation.expectedExpanded)
        for (const frame of observation.frames) {
          expect(frame.connected).toBe(true)
          expect(frame.scrollTop).toBeCloseTo(observation.before.scrollTop, 2)
          expect(frame.scrollHeight).toBe(observation.before.scrollHeight)
          for (const key of ['top', 'left', 'width', 'height'] as const) expect(frame[key]).toBeCloseTo(observation.before[key], 2)
        }
        expect(observation.hitShelf).toBe(expanded)
        expect(observation.running).toBe(reducedMotion === 'no-preference')
        if (reducedMotion === 'no-preference') expect(observation.visualStates).toBeGreaterThan(1)
      }
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(consoleWatch.pageErrors).toEqual([])
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
      const panel = element.closest('section')?.getBoundingClientRect()
      return panel !== undefined && bounds.height >= 78 && bounds.bottom <= panel.bottom && bounds.bottom < innerHeight
        && [...element.querySelectorAll('button')].every((button) => {
          const box = button.getBoundingClientRect()
          return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
        })
    })).toBe(true)
    expect(await page.locator('[data-muse-shelf-video]').count()).toBe(1)
    const sourcePill = shelf.locator('[data-muse-video-source-pill]')
    const pillGeometry = await sourcePill.evaluate((element) => {
      const anchor = element.parentElement?.querySelector('[data-muse-video-anchor]')
      if (anchor === null || anchor === undefined) throw new Error('Source pill has no Muse anchor')
      const pill = element.getBoundingClientRect(), muse = anchor.getBoundingClientRect()
      return { centerDelta: Math.abs(pill.top + pill.height / 2 - muse.top - muse.height / 2),
        beforeMuse: pill.right < muse.left, radius: getComputedStyle(element).borderRadius, inert: (element as HTMLElement).inert }
    })
    expect(pillGeometry.centerDelta).toBeLessThanOrEqual(1)
    expect(pillGeometry.beforeMuse).toBe(true)
    expect(pillGeometry.radius).toBe('999px')
    expect(pillGeometry.inert).toBe(false)
    expect(await sourcePill.getByRole('combobox', { name: 'Conversation videos' }).isEnabled()).toBe(true)
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
    await expect.poll(() => page.locator('[data-muse-shelf-video]').count()).toBe(0)
    expect(await sourcePill.evaluate(element => ({ opacity: getComputedStyle(element).opacity, inert: (element as HTMLElement).inert })))
      .toEqual({ opacity: '0', inert: true })
    expect(await shelf.getByRole('combobox', { name: 'Conversation videos' }).count()).toBe(0)
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
    const wrapper = page.locator('[data-presented-file][data-video]').filter({ has: card })
    const handle = await card.elementHandle()
    const wrapperHandle = await wrapper.elementHandle()
    if (handle === null || wrapperHandle === null) throw new Error('Inline video has no stable native delivery')
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion })
      await card.evaluate((element) => { element.scrollIntoView({ block: 'center', behavior: 'instant' }) })
      await expect.poll(() => layer.getAttribute('data-phase')).toBe('idle')
      const preview = wrapper.getByRole('button', { name: /Preview .*three-shots\.mp4.*sidebar/u })
      expect(await preview.isVisible()).toBe(true)
      expect(await preview.isEnabled()).toBe(true)
      expect(await wrapper.evaluate(element => (element as HTMLElement).inert)).toBe(false)
      const before = await card.evaluate((element) => {
        const scroll = element.closest('[data-conversation-scroll]')
          ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
        if (scroll === undefined || scroll === null) throw new Error('Inline card has no conversation scroll')
        return { height: element.getBoundingClientRect().height, scrollHeight: scroll.scrollHeight }
      })
      if (reducedMotion === 'no-preference') {
        await card.evaluate((element) => {
          const scroll = element.closest('[data-conversation-scroll]')
            ?? element.closest('[data-chat-frame]')?.querySelector('[data-chat-scroll]')
          if (!(scroll instanceof HTMLElement)) throw new Error('Inline card lost its scrollport')
          const cardRect = element.getBoundingClientRect(), viewport = scroll.getBoundingClientRect()
          const target = viewport.top + 44 - (cardRect.height * .9 + 44) * .35
          scroll.scrollTop += cardRect.top - target
        })
        await expect.poll(() => layer.getAttribute('data-phase')).toBe('moving')
        expect(await wrapper.evaluate(element => ({
          visibility: getComputedStyle(element).visibility, inert: (element as HTMLElement).inert,
        })))
          .toEqual({ visibility: 'hidden', inert: true })
      }
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
          visibility: getComputedStyle(element).visibility, inert: element.closest('[inert]') !== null }
      })
      expect(after.height).toBe(before.height)
      expect(after.scrollHeight).toBe(before.scrollHeight)
      expect(after.visibility).toBe('hidden')
      expect(after.inert).toBe(true)
      expect(await wrapperHandle.evaluate(element => element.isConnected)).toBe(true)
      expect(await wrapper.evaluate(element => ({
        visibility: getComputedStyle(element).visibility, inert: (element as HTMLElement).inert,
      })))
        .toEqual({ visibility: 'hidden', inert: true })
      await card.evaluate((element) => { element.scrollIntoView({ block: 'center', behavior: 'instant' }) })
      await expect.poll(() => layer.getAttribute('data-phase')).toBe('idle')
      expect(await handle.evaluate(element => element.isConnected)).toBe(true)
      expect(await card.evaluate(element => getComputedStyle(element).visibility)).toBe('visible')
      expect(await wrapperHandle.evaluate(element => element.isConnected)).toBe(true)
      expect(await wrapper.evaluate(element => ({
        visibility: getComputedStyle(element).visibility, inert: (element as HTMLElement).inert,
      })))
        .toEqual({ visibility: 'visible', inert: false })
      expect(await preview.isEnabled()).toBe(true)
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

  it('drags the real playhead continuously within a file and across source boundaries', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-pointer-drag'))
    const shelf = page.locator('[data-muse-video-shelf]')
    const anchor = page.locator('[data-muse-video-anchor]')
    if (await anchor.getAttribute('aria-expanded') !== 'true') await anchor.click()
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


  it('zooms the ruler and filmstrip with real controls while preserving paused time and the draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-timeline-zoom'))
    const shelf = page.locator('[data-muse-video-shelf]')
    const zoom = shelf.getByRole('group', { name: 'Timeline zoom', exact: true })
    const range = zoom.getByRole('slider', { name: 'Timeline zoom', exact: true })
    const play = shelf.getByRole('button', { name: 'Play', exact: true })
    const zoomBounds = await zoom.boundingBox(), playBounds = await play.boundingBox()
    if (zoomBounds === null || playBounds === null) throw new Error('Timeline controls are outside the viewport')
    expect(zoomBounds.x).toBeGreaterThan(playBounds.x + playBounds.width)
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

})
