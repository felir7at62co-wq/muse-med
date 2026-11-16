/** Keyless video review through the native right Sidebar and ordinary conversation drafts. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
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
const MODE = webSnapshotMode()
const SESSION = 'session-video-keyless-web-e2e'
const TITLE = 'Session video inspection'
const VIDEO = 'three-shots.mp4'
const PROVIDER_URL = 'https://101.aigc.jubianai.net/synthetic-jubian-three-shots.mp4'
const TAIL = 'SESSION_VIDEO_TRANSCRIPT_END'
const WORKSPACE = '[data-muse-video-workspace]'
const PLAYER = '[data-muse-shelf-video]'

function fixture(firstPath: string, secondPath: string): string {
  const session = Session.create(SessionId('session-video-fixture-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Inspect this existing video without generating anything.' },
  ] }), { surfaceOp: 'append' })
  session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('deliverables/presented', { turn: 1, callId: ToolCallId('present-synthetic-video'), files: [
    { path: VIDEO, description: 'Synthetic black, white, black video; three seconds.' },
  ] })
  appendToolResult(session, 1, 'production-episodes', 'jubian_model', { method: 'episodes', script_id: 10 },
    { episodes: { total: 2, rows: [{ episode_id: 131, episode_count: 31, name: 'First production episode' },
      { episode_id: 133, episode_count: 33, name: 'Second production episode' }] } })
  for (const row of [{ taskId: 17, subtaskId: 171, episodeId: 131, path: firstPath },
    { taskId: 18, subtaskId: 181, episodeId: 133, path: secondPath }]) {
    appendToolResult(session, 1, `production-task-${row.taskId}`, 'jubian_video', { method: 'task', task_id: row.taskId },
      { task: { task_id: row.taskId, script_id: 10, episode_id: row.episodeId } })
    appendToolResult(session, 1, `production-download-${row.taskId}`, 'jubian_media',
      { method: 'download', media_kind: 'video', task_id: row.taskId, subtask_id: row.subtaskId }, { path: row.path })
  }
  appendToolResult(session, 1, 'recorded-jubian-video-result', 'jubian_video', { method: 'subtasks', task_id: 7 },
    { subtasks: { rows: [{ parent_task_id: 7, status: 'succeeded', video_url: PROVIDER_URL }] } })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant',
    content: [{ type: 'text', text: `The original three-shot video is ready for review.\n\n${TAIL}` }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

function appendToolResult(session: Session, turn: number, call: string, name: string,
  args: Record<string, unknown>, result: Record<string, unknown>): void {
  const callId = ToolCallId(call)
  const serialized = JSON.stringify(args)
  session.append('assistant/message', { stream: [], turn, step: 1, message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name, arguments: serialized }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, name, callId, arguments: serialized })
  session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, isError: false,
    content: [{ type: 'text', text: JSON.stringify(result) }] }) }, { surfaceOp: 'append' })
}

function serializedSelections(text: string): unknown[] {
  return Array.from(text.matchAll(/<muse-video-selection>\s*([\s\S]*?)\s*<\/muse-video-selection>/gu)).flatMap((match) => {
    const parsed: unknown = JSON.parse(match[1] ?? '')
    if (!Array.isArray(parsed)) throw new Error('Submitted video reference is not an array')
    const rows: unknown[] = []
    for (const value of parsed) rows.push(value)
    return rows
  })
}

describe('web e2e: conversation video review', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleWatch: ReturnType<typeof watchConsole>

  const eventCounts = async () => {
    const log = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    return { messages: log.events.filter(event => event.type === 'user/message').length,
      requests: log.events.filter(event => event.type === 'request/header').length }
  }
  const workspace = () => page.locator(`${WORKSPACE}:visible`)
  const editor = () => page.locator('[data-composer-input][contenteditable="true"]').last()
  const selectSecondSegment = async () => {
    const segment = workspace().getByRole('button', { name: /^Video segment 2 ·/u })
    await segment.focus()
    await segment.press('Enter')
  }
  const openWorkspace = async () => {
    await page.locator('[data-muse-video-anchor]').click()
    await workspace().waitFor()
    await workspace().locator(PLAYER).waitFor()
  }
  const golden = (name: string) => fileURLToPath(new URL(`./expected/session-video/${name}.expected.md`, import.meta.url))
  const screenshot = async (name?: string) => {
    const requested = process.env.DSH_VIDEO_SCREENSHOT
    if (requested === undefined) return
    await mkdir(dirname(requested), { recursive: true })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.screenshot({ path: name === undefined ? requested : join(dirname(requested), name) })
  }
  const submitDraft = async (submit: () => Promise<void> = () => editor().press('Enter'),
    reply = 'The selected source coordinates have been retained.'): Promise<string> => {
    const dispose = scaffold.ctx.on('llm/stream', async function* () {
      const text = reply
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }, { prepend: true })
    try {
      const settled = scaffold.whenTurnSettled()
      await submit()
      await settled
    } finally { dispose() }
    const log = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    const last = log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').at(-1)
    if (last?.type !== 'user/message') throw new Error('No submitted user message')
    return last.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), OVERLAY],
      profile: { hmr: false, packages: [
        { dir: fileURLToPath(new URL('../../../packages/drama/session-video', import.meta.url)) },
        { dir: fileURLToPath(new URL('../../../packages/client/ui-session-video', import.meta.url)) },
        { dir: fileURLToPath(new URL('../../../packages/bundle/muse-video-ui', import.meta.url)), enabled: true },
      ] } })
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
      '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
      '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-threads', '1',
      '-pix_fmt', 'yuv420p', join(scaffold.workspaceCwd, VIDEO)])
    const firstPath = join(scaffold.workspaceCwd, 'production-first.mp4'), secondPath = join(scaffold.workspaceCwd, 'production-second.mp4')
    await Promise.all([copyFile(join(scaffold.workspaceCwd, VIDEO), firstPath), copyFile(join(scaffold.workspaceCwd, VIDEO), secondPath)])
    await seedSession(scaffold, fixture(firstPath, secondPath), SESSION)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const bytes = readFileSync(join(scaffold.workspaceCwd, VIDEO))
    await page.route(PROVIDER_URL, route => route.fulfill({ status: 200, contentType: 'video/mp4', body: bytes }))
    await page.setViewportSize({ width: 1680, height: 1000 })
    consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
    await page.getByRole('treeitem').first().click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText(TAIL, { exact: false }).waitFor()
    await page.locator('[data-muse-video-anchor]').waitFor()
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  beforeEach(async () => {
    if (await workspace().count() === 0 || await workspace().locator(PLAYER).count() === 0) await openWorkspace()
  })

  it('opens one native video tab beside the conversation while preserving the draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-native-sidebar'))
    const draft = 'Keep this unfinished instruction.'
    await editor().fill(draft)
    await openWorkspace()
    const tab = page.locator('[data-dockkit-tab]').filter({ hasText: 'Conversation videos' })
    expect(await tab.count()).toBe(1)
    const video = await workspace().locator(PLAYER).boundingBox(), input = await editor().boundingBox()
    if (video === null || input === null) throw new Error('Video or composer is outside the viewport')
    expect(video.x).toBeGreaterThanOrEqual(input.x + input.width - 1)
    expect(await editor().innerText()).toBe(draft)
    await page.locator('[data-muse-video-anchor]').click()
    expect(await tab.count()).toBe(1)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('plays one authorized source and exposes three real visual cut ranges', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-native-playback'))
    await workspace().getByRole('button', { name: /^Video segment 3 ·/u }).waitFor()
    expect(await workspace().getByRole('button', { name: /^Video segment \d+ ·/u }).count()).toBe(3)
    const video = workspace().locator(PLAYER)
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
    expect(await video.evaluate(element => (element as HTMLVideoElement).currentSrc)).toContain('/api/session-video')
    await workspace().getByRole('button', { name: /^Video segment 2 ·/u }).click()
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(1)
    expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeLessThan(2)
    await workspace().getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(1.1)
    await workspace().getByRole('button', { name: 'Pause', exact: true }).click()
    await selectSecondSegment()
    await compareOrRefreshGolden(golden('shelf'), await captureStableAria(page, WORKSPACE, scaffold.workspaceCwd), MODE)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      expect(await workspace().getByRole('button', { name: 'Add selected segment', exact: true }).isVisible()).toBe(true)
    }
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('prepares source-local segment review in the existing draft without sending a message', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-review-draft'))
    await workspace().getByRole('button', { name: /^Video segment 3 ·/u }).waitFor()
    const clipping = await editor().evaluate((element) => {
      const shell = element.closest<HTMLElement>('[data-phase="active"]')
      if (shell === null) throw new Error('Composer has no active Conversation shell')
      const before = element.getBoundingClientRect().left
      shell.scrollLeft = 48
      return { offset: shell.scrollLeft, before, after: element.getBoundingClientRect().left }
    })
    expect(clipping.offset, 'Conversation shell accepted horizontal caret scrolling').toBe(0)
    expect(clipping.after).toBe(clipping.before)
    const draft = 'Keep this unfinished instruction.'
    await editor().fill(draft)
    const before = await eventCounts()
    await selectSecondSegment()
    await workspace().getByRole('button', { name: 'Add selected segment', exact: true }).click()
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(1)
    await workspace().getByRole('button', { name: 'Review selected videos', exact: true }).click()
    const text = await editor().innerText()
    expect(text.startsWith(draft)).toBe(true)
    expect(text).toContain(VIDEO)
    expect(await eventCounts()).toEqual(before)
    expect(before.requests).toBe(0)
    await screenshot()
    const sidebarEdge = await page.locator('[data-side="sidebar"]').boundingBox()
    const inputBounds = await editor().boundingBox(), transcriptBounds = await page.getByText(TAIL, { exact: false }).boundingBox()
    if (sidebarEdge === null || inputBounds === null || transcriptBounds === null) throw new Error('Conversation or navigation is outside the viewport')
    expect(inputBounds.x).toBeGreaterThanOrEqual(sidebarEdge.x)
    expect(transcriptBounds.x).toBeGreaterThanOrEqual(sidebarEdge.x)
    const submitted = await submitDraft()
    const inventory = await scaffold.ctx.sessionVideo.list(SessionId(SESSION), new AbortController().signal)
    const source = inventory.sources.find(item => item.path?.endsWith(VIDEO))
    expect(serializedSelections(submitted)).toEqual([expect.objectContaining({
      source_id: source?.id, source_version: source?.version, path: source?.path, start_seconds: 1, end_seconds: 2,
    })])
    expect(submitted).toContain('"review_link": "dsh-resource://session-video/session/')
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('starts read-only review when the composer contains only the selected video reference', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-review-reference-only'))
    await editor().fill('')
    await selectSecondSegment()
    await workspace().getByRole('button', { name: 'Add selected segment', exact: true }).click()
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(1)
    const before = await eventCounts()
    const submitted = await submitDraft(() => workspace().getByRole('button', { name: 'Review selected videos', exact: true }).click())
    expect(submitted).toContain('read-only review')
    expect(submitted).toContain('Wait for my changes before editing or generating')
    expect(serializedSelections(submitted)).toHaveLength(1)
    expect((await eventCounts()).messages).toBe(before.messages + 1)
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(0)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('zooms and drags the timeline without changing the composer draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-native-timeline'))
    const video = workspace().locator(PLAYER)
    await selectSecondSegment()
    const draft = await editor().innerText(), before = await video.evaluate(element => (element as HTMLVideoElement).currentTime)
    const zoom = workspace().getByRole('slider', { name: 'Timeline zoom', exact: true })
    const originalZoom = Number(await zoom.inputValue())
    await workspace().getByRole('button', { name: 'Zoom in timeline', exact: true }).click()
    await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(originalZoom)
    expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(before, 2)
    const playhead = workspace().getByRole('slider', { name: 'Playback position', exact: true })
    await playhead.focus()
    await page.keyboard.press('End')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(3, 1)
    await playhead.focus()
    await page.keyboard.press('Home')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(0, 1)
    const bounds = await playhead.boundingBox()
    if (bounds === null) throw new Error('Playback position has no rendered track')
    await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    try { await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height / 2, { steps: 8 }) }
    finally { await page.mouse.up() }
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    expect(await editor().innerText()).toBe(draft)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('moves the same selected video between the native sidebar and a floating pane', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-native-floating'))
    await selectSecondSegment()
    const draft = await editor().innerText()
    await workspace().getByRole('button', { name: /^Float/u }).click()
    const floating = page.locator('[data-dockkit-host="float"]').filter({ has: workspace() })
    await expect.poll(() => floating.count()).toBe(1)
    await workspace().waitFor()
    expect(await workspace().locator(PLAYER).count()).toBe(1)
    await expect.poll(() => workspace().locator(PLAYER).evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1)
    expect(await editor().innerText()).toBe(draft)
    await workspace().getByRole('button', { name: /^(?:Dock|Send back)/u }).click()
    await expect.poll(() => floating.count()).toBe(0)
    await expect.poll(() => workspace().locator(PLAYER).evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1)
    expect(await editor().innerText()).toBe(draft)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('downloads a recorded provider result into same-origin playback without external traffic', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-provider-download'))
    const url = PROVIDER_URL
    const bytes = readFileSync(join(scaffold.workspaceCwd, VIDEO))
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
    onTestFinished(() => { transport.mockRestore() })
    await workspace().getByRole('button', { name: 'Video selection', exact: true }).click()
    await workspace().getByRole('checkbox', { name: 'Select video: synthetic-jubian-three-shots.mp4', exact: true }).check()
    await workspace().getByRole('button', { name: 'Switch video: synthetic-jubian-three-shots.mp4', exact: true }).click()
    await expect.poll(() => downloads).toBe(1)
    await expect.poll(() => workspace().locator(PLAYER).evaluate(element => (element as HTMLVideoElement).currentSrc), { timeout: 30000 })
      .toContain('/api/session-video')
    const inventory = await scaffold.ctx.sessionVideo.list(SessionId(SESSION), new AbortController().signal)
    const recorded = inventory.sources.find(item => item.remoteUrl === url)
    expect(recorded?.status).toBe('local')
    expect(recorded?.playbackUrl).toContain('api/session-video')
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('submits a normal typed request with productions selected across episodes', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-cross-episode-review'))
    const firstPath = join(scaffold.workspaceCwd, 'production-first.mp4'), secondPath = join(scaffold.workspaceCwd, 'production-second.mp4')
    const inventory = await scaffold.ctx.sessionVideo.list(SessionId(SESSION), new AbortController().signal)
    const first = inventory.sources.find(source => source.path === firstPath)
    const second = inventory.sources.find(source => source.path === secondPath)
    expect(first?.production).toMatchObject({ scriptId: 10, episodeId: 131, episodeNumber: 31, taskId: 17, subtaskId: 171 })
    expect(second?.production).toMatchObject({ scriptId: 10, episodeId: 133, episodeNumber: 33, taskId: 18, subtaskId: 181 })
    const clear = workspace().getByRole('button', { name: 'Clear selection', exact: true })
    if (await clear.count() > 0) await clear.click()
    const draft = 'Compare the two episodes, but do not generate a replacement.'
    await editor().fill(draft)
    const before = await eventCounts()
    const compactBefore = await page.locator('[data-muse-video-selection]').count()
    await workspace().getByRole('button', { name: 'Video selection', exact: true }).click()
    const filter = page.getByRole('combobox', { name: 'Choose episode', exact: true })
    await expect.poll(async () => (await filter.getByRole('option').allTextContents()).some(text => /\b31\b/u.test(text))).toBe(true)
    const options = await filter.getByRole('option').allTextContents()
    expect(options).toContain('All episodes')
    expect(options).toContain('Unassigned')
    await filter.selectOption('all')
    await filter.focus()
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => filter.inputValue()).toBe('31')
    for (const [episode, label] of [[31, 'production-first.mp4'], [33, 'production-second.mp4']] as const) {
      const option = options.find(text => new RegExp(`\\b${episode}\\b`, 'u').test(text))
      if (option === undefined) throw new Error(`No episode ${episode} filter`)
      await filter.selectOption({ label: option })
      await page.getByRole('checkbox', { name: `Select video: ${label}`, exact: true }).check()
    }
    await workspace().getByRole('button', { name: /^Video segment 3 ·/u }).waitFor()
    await compareOrRefreshGolden(golden('review-selection'), await captureStableAria(page, WORKSPACE, scaffold.workspaceCwd), MODE)
    await screenshot('session-video-episode-selection.png')
    await filter.focus()
    await page.keyboard.press('Escape')
    await expect.poll(() => workspace().locator('[data-muse-video-picker]').isVisible()).toBe(false)
    expect(await workspace().getByRole('button', { name: 'Video selection', exact: true })
      .evaluate(element => element === document.activeElement)).toBe(true)
    const text = await editor().innerText()
    expect(text.startsWith(draft)).toBe(true)
    expect(await editor().locator('[data-composer-chip="muse-video"]').count()).toBe(2)
    expect(await eventCounts()).toEqual(before)
    const submitted = await submitDraft()
    await expect.poll(() => page.locator('[data-muse-video-selection]').count()).toBe(compactBefore + 2)
    expect(serializedSelections(submitted)).toMatchObject([
      { source_id: first?.id, source_version: first?.version, path: firstPath,
        production: { scriptId: 10, episodeId: 131, episodeNumber: 31, taskId: 17 } },
      { source_id: second?.id, source_version: second?.version, path: secondPath,
        production: { scriptId: 10, episodeId: 133, episodeNumber: 33, taskId: 18 } },
    ])
    expect(Array.from(submitted.matchAll(/"review_link": "(dsh-resource:[^"]+)"/gu))).toHaveLength(2)
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(0)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('opens an Agent advice link at the source time and rejects an unavailable source version', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-advice-navigation'))
    const inventory = await scaffold.ctx.sessionVideo.list(SessionId(SESSION), new AbortController().signal)
    const source = inventory.sources.find(item => item.production?.episodeNumber === 33)
    const previous = inventory.sources.find(item => item.production?.episodeNumber === 31)
    if (source?.version === null || source === undefined) throw new Error('Production source has no current version')
    if (previous === undefined) throw new Error('Previous production source is unavailable')
    const analysis = await scaffold.ctx.sessionVideo.detect(SessionId(SESSION), source.id, source.version, new AbortController().signal)
    const shot = analysis.shots[1]
    const laterShot = analysis.shots[2]
    if (shot === undefined || laterShot === undefined) throw new Error('Synthetic production video has no second or third cut')
    const address = new URL(`dsh-resource://session-video/session/${encodeURIComponent(SESSION)}`)
    for (const [name, value] of Object.entries({ source: source.id, version: source.version, shot: shot.id,
      start: String(shot.startSeconds), end: String(shot.endSeconds) })) address.searchParams.set(name, value)
    const stale = new URL(address)
    stale.searchParams.set('version', `${source.version}-replaced`)
    stale.searchParams.set('shot', laterShot.id)
    stale.searchParams.set('start', String(laterShot.startSeconds))
    stale.searchParams.set('end', String(laterShot.endSeconds))
    const foreign = new URL(address)
    foreign.pathname = '/session/session-video-other-conversation'
    await editor().fill('Explain which source interval to inspect before changing anything.')
    await submitDraft(() => editor().press('Enter'),
      `The contrast changes in this sampled interval. [Inspect the source interval](${address.href}).\n\n`
      + `An earlier source revision is unavailable. [Inspect the earlier revision](${stale.href}).\n\n`
      + `This source belongs elsewhere. [Inspect another conversation](${foreign.href}).`)
    await workspace().getByRole('button', { name: 'Video selection', exact: true }).click()
    await workspace().getByRole('combobox', { name: 'Choose episode', exact: true }).selectOption('31')
    await workspace().getByRole('button', { name: `Switch video: ${previous.label}`, exact: true }).click()
    await expect.poll(() => workspace().locator(PLAYER).getAttribute('aria-label')).toBe(previous.label)
    await editor().fill('Keep this follow-up draft while I inspect the linked source.')
    const draft = await editor().innerText(), before = await eventCounts()
    const advice = page.getByRole('link', { name: 'Inspect the source interval', exact: true })
    expect(await advice.getAttribute('href')).toBe(address.href)
    await advice.click()
    await expect.poll(() => workspace().locator(PLAYER).getAttribute('aria-label')).toBe(source.label)
    await expect.poll(() => workspace().locator(PLAYER).evaluate(element => (element as HTMLVideoElement).currentTime))
      .toBeCloseTo(shot.startSeconds, 2)
    expect(await editor().innerText()).toBe(draft)
    await page.getByRole('link', { name: 'Inspect the earlier revision', exact: true }).click()
    const staleNotice = workspace().getByRole('status').filter({ hasText: 'This video or segment changed. Please select it again.' })
    await staleNotice.waitFor()
    expect(await staleNotice.innerText()).toBe('This video or segment changed. Please select it again.')
    expect(await workspace().locator(PLAYER).count()).toBe(0)
    expect(await workspace().getByRole('button', { name: 'Video selection', exact: true }).isVisible()).toBe(true)
    await page.getByRole('link', { name: 'Inspect another conversation', exact: true }).click()
    const foreignNotice = workspace().getByRole('status').filter({ hasText: 'This video belongs to another conversation. Open it there to review.' })
    await foreignNotice.waitFor()
    expect(await foreignNotice.innerText()).toBe('This video belongs to another conversation. Open it there to review.')
    expect(await workspace().locator(PLAYER).count()).toBe(0)
    expect(await editor().innerText()).toBe(draft)
    expect(await eventCounts()).toEqual(before)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('unplugs the video presentation while preserving the draft and a running job across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-plugin-switch'))
    const draft = 'Keep this unfinished instruction while switching the video presentation.'
    const agent = scaffold.ctx.agents.get(SessionId(SESSION))
    if (agent === undefined) throw new Error('Opened fixture has no Agent')
    const release = '.session-video-plugin-switch.release'
    onTestFinished(() => writeFile(join(scaffold.workspaceCwd, release), ''))
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const command = process.platform === 'win32'
      ? `Write-Output 'presentation-switch-job'; while (-not (Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 100 }`
      : `printf 'presentation-switch-job\\n'; for _ in $(seq 1 1200); do [ -e ${release} ] && break; sleep 0.1; done`
    const started = await executeToolFixture(scaffold.ctx, {
      signal: new AbortController().signal, callId: ToolCallId('session-video-plugin-switch'), name: shell, agent,
      arguments: { command, description: 'Retain background work while switching the presentation', run_in_background: true },
    })
    const match = /\b(?:bash|pwsh)-[0-9a-f]{16}\b/u.exec(started.content.map(block => block.type === 'text' ? block.text : '').join(''))
    if (match === null) throw new Error('No background job receipt')
    const jobId = JobId(match[0])
    try {
      // Windows workspace-write grants change file ACL metadata and invalidate earlier source versions.
      await page.reload({ waitUntil: 'load' })
      await page.getByText(TAIL, { exact: false }).waitFor()
      if (await workspace().count() === 0) await openWorkspace()
      await workspace().getByRole('button', { name: /^Video segment 2 ·/u }).waitFor()
      await editor().fill(draft)
      await selectSecondSegment()
      await workspace().getByRole('button', { name: 'Add selected segment', exact: true }).click()
      await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(1)
      const composedDraft = await editor().innerText()
      const before = await eventCounts(), oldVideo = await workspace().locator(PLAYER).elementHandle()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      const toggle = dialog.getByRole('switch', { name: 'Muse video workspace', exact: true })
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      await expect.poll(() => page.locator('[data-muse-video-anchor]').count()).toBe(0)
      await expect.poll(() => page.locator(WORKSPACE).count()).toBe(0)
      expect(await oldVideo?.evaluate(element => ({ connected: element.isConnected,
        src: element.getAttribute('src'), paused: (element as HTMLVideoElement).paused })))
        .toEqual({ connected: false, src: null, paused: true })
      expect(await editor().innerText()).toBe(composedDraft)
      expect(scaffold.ctx.jobs.get(jobId, agent.id).status).toBe('running')
      await compareOrRefreshGolden(golden('plugin-switch'), [
        '- Optional presentation: disabled', '- Native delivered video: available',
        '- Video workspace and conversation entry: removed', '- Composer draft: preserved', '- Background job: running',
        await captureStableAria(page, '[data-muse-presentation-setting]', scaffold.workspaceCwd, { runningJobs: 'keep' }),
      ].join('\n'), MODE)
      await page.reload({ waitUntil: 'load' })
      await page.getByText(TAIL, { exact: false }).waitFor()
      expect(await page.locator('[data-muse-video-anchor]').count()).toBe(0)
      expect(await editor().innerText()).toBe(composedDraft)
      const submitted = await submitDraft()
      expect(serializedSelections(submitted)).toHaveLength(1)
      const afterSubmission = await eventCounts()
      expect(afterSubmission.messages).toBe(before.messages + 1)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      await toggle.click()
      await expect.poll(() => page.locator('[data-muse-video-anchor]').count()).toBe(1)
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
      await openWorkspace()
      expect(await editor().innerText()).toBe('')
      expect(scaffold.ctx.jobs.get(jobId, agent.id).status).toBe('running')
      expect(await eventCounts()).toEqual(afterSubmission)
    } finally {
      try {
        await writeFile(join(scaffold.workspaceCwd, release), '')
        const settled = await scaffold.ctx.jobs.wait(jobId, 15000, agent.id)
        expect(settled.status).toBe('completed')
      } finally { await scaffold.ctx.settings.update('ui-session-video', { enabled: true }) }
    }
    expect(consoleWatch.pageErrors).toEqual([])
  })
})
