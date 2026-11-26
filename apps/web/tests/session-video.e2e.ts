/** Keyless video review through the native right Sidebar and ordinary conversation drafts. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-session-query'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
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
const ORIENTATIONS = [
  { name: 'portrait', width: 180, height: 320 },
  { name: 'landscape', width: 320, height: 180 },
] as const
const PROVIDER_URL = 'https://101.aigc.jubianai.net/synthetic-jubian-three-shots.mp4'
const TAIL = 'SESSION_VIDEO_TRANSCRIPT_END'
const WORKSPACE = '[data-muse-video-workspace]'
const PLAYER = '[data-muse-shelf-video]'
const COMPOSER_SCOPE = '[data-muse-composer-scope]:visible'
const PREVIEW_SCOPE = '[data-muse-preview-scope]'
const REVIEW_REQUEST = 'Review the selected footage against the script and delivery requirements, and suggest specific fixes for any issues.'

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
    ...ORIENTATIONS.map(({ name }) => ({ path: `${name}.mp4`, description: `Synthetic ${name} video; three seconds.` })),
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
  const screenshot = async (name?: string, colorScheme: 'light' | 'dark' = 'light') => {
    const requested = process.env.DSH_VIDEO_SCREENSHOT
    if (requested === undefined) return
    await mkdir(dirname(requested), { recursive: true })
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ path: name === undefined ? requested : join(dirname(requested), name) })
  }
  const submitDraft = async (submit: () => Promise<void> = () => editor().press('Enter'),
    reply = 'The selected source coordinates have been retained.', tool?: {
      name: 'muse_video' | 'present'
      call: Record<string, unknown>
      evidence?: (content: readonly ContentBlock[]) => void
    }): Promise<string> => {
    const callId = ToolCallId(`agent-shot-${tool?.name ?? 'response'}`)
    const dispose = scaffold.ctx.on('llm/stream', async function* (request) {
      if (tool !== undefined) {
        const observed = request.messages.find(message => message.role === 'tool' && message.toolCallId === callId)
        if (observed === undefined) { yield* toolCallResponse(callId, tool.name, tool.call); return }
        tool.evidence?.(observed.content)
      }
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
    for (const { name, width, height } of ORIENTATIONS) {
      execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=10:d=3`,
        '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', join(scaffold.workspaceCwd, `${name}.mp4`)])
    }
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
    expect(text).not.toContain('<!-- muse-video-review:')
    expect(text).not.toContain('muse_video')
    expect(await editor().locator('[data-composer-chip="muse-video-review"]').getByText('Read-only review', { exact: true }).count()).toBe(1)
    expect(await eventCounts()).toEqual(before)
    expect(before.requests).toBe(0)
    await screenshot()
    const sidebarEdge = await page.locator('[data-side="sidebar"]').boundingBox()
    const inputBounds = await editor().boundingBox(), transcriptBounds = await page.getByText(TAIL, { exact: false }).boundingBox()
    if (sidebarEdge === null || inputBounds === null || transcriptBounds === null) throw new Error('Conversation or navigation is outside the viewport')
    expect(inputBounds.x).toBeGreaterThanOrEqual(sidebarEdge.x)
    expect(transcriptBounds.x).toBeGreaterThanOrEqual(sidebarEdge.x)
    const submitted = await submitDraft()
    expect(submitted).toContain('<!-- muse-video-review:')
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
    expect(submitted).toContain(REVIEW_REQUEST)
    expect(submitted).toContain('<!-- muse-video-review:')
    expect(serializedSelections(submitted)).toHaveLength(1)
    expect((await eventCounts()).messages).toBe(before.messages + 1)
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(0)
    expect(await editor().locator('[data-composer-chip="muse-video-review"]').count()).toBe(0)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('reviews the current whole video directly without opening the picker or selecting a reference first', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-direct-whole-review'))
    await editor().fill('')
    await selectSecondSegment()
    const video = workspace().locator(PLAYER)
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1)
    await workspace().getByRole('button', { name: 'Whole video', exact: true }).click()
    expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1)
    await expect.poll(() => workspace().getByRole('button', { name: 'Add current video to chat', exact: true }).isEnabled()).toBe(true)
    expect(await editor().locator('[data-composer-chip="muse-video"]').count()).toBe(0)
    expect(await workspace().locator('[data-muse-video-picker]').count()).toBe(0)
    const before = await eventCounts()
    const submitted = await submitDraft(() => workspace().getByRole('button', { name: 'Review selected videos', exact: true }).click())
    const selections = serializedSelections(submitted)
    expect(selections).toEqual([expect.objectContaining({ label: VIDEO, path: join(scaffold.workspaceCwd, VIDEO) })])
    expect(selections[0]).not.toHaveProperty('shot_id')
    expect(selections[0]).not.toHaveProperty('start_seconds')
    expect(submitted).toContain(REVIEW_REQUEST)
    expect(submitted).toContain('<!-- muse-video-review:')
    expect((await eventCounts()).messages).toBe(before.messages + 1)
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(0)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('adds the current whole video for an ordinary modification request without sending it automatically', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-direct-whole-modification'))
    const draft = 'Make the pacing gentler and keep the dialogue.'
    await editor().fill(draft)
    const before = await eventCounts()
    await workspace().getByRole('button', { name: 'Add current video to chat', exact: true }).click()
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(1)
    expect((await editor().innerText()).startsWith(draft)).toBe(true)
    expect(await editor().innerText()).not.toContain('read-only review')
    expect(await workspace().getByRole('button', { name: 'Add current video to chat', exact: true }).isDisabled()).toBe(true)
    expect(await eventCounts()).toEqual(before)
    const submitted = await submitDraft()
    expect(submitted.startsWith(draft)).toBe(true)
    const selections = serializedSelections(submitted)
    expect(selections).toEqual([expect.objectContaining({ label: VIDEO })])
    expect(selections[0]).not.toHaveProperty('shot_id')
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('brings the current segment into an unfinished review draft without sending or adding it twice', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-direct-segment-draft'))
    const draft = 'Slow down the gesture here and keep the dialogue.'
    await editor().fill(draft)
    await selectSecondSegment()
    const before = await eventCounts()
    await workspace().getByRole('button', { name: 'Review selected videos', exact: true }).click()
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video"]').count()).toBe(1)
    await workspace().getByRole('button', { name: 'Review selected videos', exact: true }).click()
    expect(await editor().locator('[data-composer-chip="muse-video-review"]').count()).toBe(1)
    expect(await workspace().getByText('1 selected in chat', { exact: true }).count()).toBe(1)
    expect((await editor().innerText()).startsWith(draft)).toBe(true)
    expect((await editor().innerText()).split(REVIEW_REQUEST)).toHaveLength(2)
    expect(await editor().innerText()).not.toContain('<!-- muse-video-review:')
    expect(await editor().innerText()).not.toContain('muse_video')
    await editor().press('ControlOrMeta+A')
    const copied = await editor().evaluate((element) => {
      const clipboardData = new DataTransfer()
      element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
      return clipboardData.getData('text/plain')
    })
    expect(copied).toContain('Read-only review')
    expect(copied.startsWith(draft)).toBe(true)
    expect(copied).not.toContain('<!-- muse-video-review:')
    expect(copied).not.toContain('muse_video')
    await editor().press('ArrowRight')
    expect(await workspace().getByRole('button', { name: 'Add selected segment', exact: true }).isDisabled()).toBe(true)
    expect(await eventCounts()).toEqual(before)
    await screenshot('session-video-direct-review.png')
    const viewport = page.viewportSize()
    if (viewport === null) throw new Error('Review workspace has no viewport')
    try {
      await page.setViewportSize({ width: 1280, height: 820 })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        const bounds = await workspace().boundingBox()
        if (bounds === null) throw new Error('Review workspace is outside the compact viewport')
        for (const name of ['Add selected segment', 'Review selected videos']) {
          const action = await workspace().getByRole('button', { name, exact: true }).boundingBox()
          if (action === null) throw new Error(`Review action is outside the compact viewport: ${name}`)
          expect(action.x).toBeGreaterThanOrEqual(bounds.x)
          expect(action.x + action.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
        }
        await screenshot(`session-video-direct-review-${colorScheme}.png`, colorScheme)
      }
    } finally {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: 'light' })
    }
    const submitted = await submitDraft()
    expect([...submitted.matchAll(/<!-- muse-video-review:/gu)]).toHaveLength(1)
    expect(serializedSelections(submitted)).toEqual([expect.objectContaining({ label: VIDEO, start_seconds: 1, end_seconds: 2 })])
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('clears read-only mode before preparing changes and submits the same selected source without the review protocol', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-review-to-edit'))
    const draft = 'Keep my pacing notes and make this gesture gentler.'
    await editor().fill(draft)
    await selectSecondSegment()
    const before = await eventCounts()
    await workspace().getByRole('button', { name: 'Review selected videos', exact: true }).click()
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video-review"]').count()).toBe(1)
    await workspace().getByRole('button', { name: 'Prepare edit', exact: true }).click()
    await expect.poll(() => editor().locator('[data-composer-chip="muse-video-review"]').count()).toBe(0)
    expect(await editor().locator('[data-composer-chip="muse-video"]').count()).toBe(1)
    expect((await editor().innerText()).startsWith(draft)).toBe(true)
    expect(await editor().innerText()).toContain('Apply my requested changes to the videos or visual segments selected in this message.')
    expect(await eventCounts()).toEqual(before)
    const submitted = await submitDraft()
    expect(submitted).not.toContain('<!-- muse-video-review:')
    expect(serializedSelections(submitted)).toEqual([expect.objectContaining({ label: VIDEO, start_seconds: 1, end_seconds: 2 })])
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
    await workspace().getByRole('button', { name: 'Video selection', exact: true }).click()
    await page.getByRole('combobox', { name: 'Choose episode', exact: true }).selectOption('unassigned')
    await workspace().getByRole('button', { name: `Switch video: ${VIDEO}`, exact: true }).click()
    await workspace().getByRole('button', { name: 'Review selected videos', exact: true }).click()
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
    const linkedTabId = await workspace().locator(PLAYER).evaluate(element =>
      element.closest('[data-dockkit-content]')?.getAttribute('data-dockkit-content'))
    if (!linkedTabId) throw Error('Linked video has no retained tab')
    const linkedWorkspace = page.locator(`[data-dockkit-content="${linkedTabId}"] ${WORKSPACE}`)
    for (const selectAnotherVideo of [false, true]) {
      if (selectAnotherVideo) {
        await linkedWorkspace.getByRole('button', { name: 'Video selection', exact: true }).click()
        await linkedWorkspace.getByRole('combobox', { name: 'Choose episode', exact: true }).selectOption('31')
        await linkedWorkspace.getByRole('button', { name: `Switch video: ${previous.label}`, exact: true }).click()
      }
      const selected = selectAnotherVideo ? previous : source
      const player = linkedWorkspace.locator(PLAYER)
      await expect.poll(() => player.getAttribute('aria-label')).toBe(selected.label)
      await linkedWorkspace.getByRole('slider', { name: 'Playback position', exact: true }).press('ArrowRight')
      await expect.poll(() => player.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
      const position = await player.evaluate(element => (element as HTMLVideoElement).currentTime)
      for (const action of [/^Float/u, /^(?:Dock|Send back)/u]) {
        await linkedWorkspace.getByRole('button', { name: action }).click()
        await expect.poll(() => player.getAttribute('aria-label')).toBe(selected.label)
        expect(await player.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(position, 2)
      }
      expect(await editor().innerText()).toBe(draft)
    }
    await advice.click()
    await expect.poll(() => linkedWorkspace.locator(PLAYER).getAttribute('aria-label')).toBe(source.label)
    await expect.poll(() => linkedWorkspace.locator(PLAYER).evaluate(element => (element as HTMLVideoElement).currentTime))
      .toBeCloseTo(shot.startSeconds, 2)
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
  it('reviews a bound episode shot, drafts the suggested edit and compares a returned version', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-authored-shot'))
    await editor().fill('Prepare this conversation for an existing-video review.')
    await submitDraft()
    const agent = scaffold.ctx.agents.get(SessionId(SESSION))
    if (agent === undefined) throw Error('Conversation Agent is unavailable')
    const signal = new AbortController().signal
    const inventory = await scaffold.ctx.sessionVideo.list(agent.id, signal)
    const source = inventory.sources.find(item => item.path === join(scaffold.workspaceCwd, VIDEO))
    if (source?.version === null || source === undefined || source.path === null) throw Error('Recorded local video is unavailable')
    const evidence = join(scaffold.workspaceCwd, 'video-production-evidence.json')
    await writeFile(evidence, JSON.stringify({ scriptId: 4660, episodeNumber: 46, shotNumbers: [10, 11, 12] }))
    const scriptPath = join(scaffold.workspaceCwd, 'episode-46.md')
    const screenplay = '场次 46-1：暗室内景\n【镜头12】\n画面：暗室保持低照度。\n对白：林岚「别开灯。」\n'
    await writeFile(scriptPath, screenplay)
    appendToolResult(agent.session, 2, 'review-script-source', 'muse_production', { method: 'preview' }, {
      method: 'preview', script_id: 4660, episode: 46, source_path: scriptPath,
      source_sha256: createHash('sha256').update(screenplay).digest('hex'),
      plan_path: join(scaffold.workspaceCwd, '.muse', 'production', `${'a'.repeat(64)}.json`), fingerprint: 'a'.repeat(64),
    })
    const args = { method: 'bind', source_id: source.id, source_version: source.version,
      sha256: createHash('sha256').update(readFileSync(source.path)).digest('hex'), evidence_paths: [evidence],
      production: { scriptId: 4660, episodeNumber: 46, packageIndex: 3, shotNumbers: [10, 11, 12],
        shotRanges: [{ shotNumber: 12, startSeconds: 1, endSeconds: 2 }] } }
    const result = await executeToolFixture(scaffold.ctx, { agent, signal, callId: ToolCallId('bind-observed-shot'), name: 'muse_video', arguments: args })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    if (typeof result.value !== 'string') throw Error('Binding produced no result')
    appendToolResult(agent.session, 2, 'bound-observed-shot', 'muse_video', args, JSON.parse(result.value) as Record<string, unknown>)
    const episode = workspace().getByRole('combobox', { name: 'Choose episode', exact: true })
    await expect.poll(() => episode.getByRole('option', { name: 'Episode 46', exact: true }).count()).toBe(1)
    await episode.selectOption('46')
    await workspace().getByRole('button', { name: 'Video selection', exact: true }).click()
    const picker = workspace().locator('[data-muse-video-picker]')
    await picker.getByRole('button', { name: `Switch video: ${VIDEO}`, exact: true }).click()
    await workspace().getByRole('button', { name: 'Shot 12', exact: true }).click()
    expect(await workspace().getByRole('button', { name: 'Shot 10', exact: true }).isDisabled()).toBe(true)
    await expect.poll(() => workspace().locator(PLAYER).evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1)
    const scope = page.locator(COMPOSER_SCOPE)
    const currentRange = 'Episode 46 · Shot 12 · 00:01–00:02'
    await expect.poll(() => scope.innerText()).toContain(currentRange)
    expect(await workspace().locator(PREVIEW_SCOPE).innerText()).toContain(currentRange)
    expect(await editor().innerText()).toBe('')
    const authoredWorkspace = await captureStableAria(page, WORKSPACE, scaffold.workspaceCwd)
    const authoredComposer = await captureStableAria(page, COMPOSER_SCOPE, scaffold.workspaceCwd)
    const problem = 'The sampled frame is too bright for the dark room.'
    const basis = 'Screenplay, shot 12: keep the room dim.'
    const suggestion = 'Lower the exposure for the dark room and retain the original framing.'
    const advice = new URL(`dsh-resource://session-video/session/${encodeURIComponent(SESSION)}`)
    for (const [name, value] of Object.entries({ source: source.id, version: source.version,
      shot: `authored:${source.id}:${source.version}:12:1:2`, start: '1', end: '2' })) advice.searchParams.set(name, value)
    const reviewLink = advice.href
    for (const [name, value] of Object.entries({ at: '1.25', problem, basis, suggestion })) advice.searchParams.set(name, value)
    const review = { method: 'review', source_id: source.id, source_version: source.version, start_seconds: 1, end_seconds: 2 }
    const reviewerEvidence = vi.fn<(content: readonly ContentBlock[]) => void>()
    await editor().fill('')
    const submitted = await submitDraft(() => workspace().getByRole('button', { name: 'Review selected videos', exact: true }).click(),
      `[Review finding](${advice.href})\n\nDialogue is unverified.`,
      { name: 'muse_video', call: review, evidence: reviewerEvidence })
    expect(serializedSelections(submitted)).toEqual([expect.objectContaining({ authored_shot_number: 12, start_seconds: 1, end_seconds: 2, review_tool: 'muse_video' })])
    expect(submitted).toContain('<!-- muse-video-review:')
    expect(await page.locator('body').innerText()).not.toContain('<!-- muse-video-review:')
    expect(reviewerEvidence).toHaveBeenCalledOnce()
    const modelContent = reviewerEvidence.mock.calls[0]?.[0]
    expect(modelContent).toContainEqual(expect.objectContaining({ type: 'image' }))
    const evidenceText = modelContent?.find(block => block.type === 'text')?.text
    const reviewPayload: unknown = JSON.parse(evidenceText ?? 'null')
    expect(reviewPayload).toMatchObject({ review_link: reviewLink, production: { episodeNumber: 46, shotNumbers: [12] },
      media: { width: 64, height: 64 }, references: { screenplay: { status: 'available', authored_shots: [12], text: screenplay.trimEnd() } },
      dialogue: { status: 'no_audio_track' } })
    expect(reviewPayload).toHaveProperty('frames', expect.arrayContaining([expect.objectContaining({ requested_seconds: 1.25 })]))
    const outside = await executeToolFixture(scaffold.ctx, { agent, signal, callId: ToolCallId('outside-shot'), name: 'muse_video', arguments: { ...review, start_seconds: 0 } })
    expect(outside.isError).toBe(true)

    const userDraft = 'Keep the dialogue.'
    await editor().fill(userDraft)
    const beforeAdvice = await eventCounts()
    const adviceCard = page.locator('[data-muse-suggestion-card]')
    await adviceCard.waitFor()
    const adviceText = await adviceCard.innerText()
    expect(adviceText).toContain(problem)
    expect(adviceText).toContain(basis)
    expect(adviceText).toContain(suggestion)
    const issueTime = adviceCard.getByRole('link', { name: '00:01.25', exact: true })
    await issueTime.click()
    await expect.poll(() => workspace().locator(PLAYER).evaluate(element => (element as HTMLVideoElement).currentTime))
      .toBeCloseTo(1.25, 2)
    expect(await workspace().locator(PREVIEW_SCOPE).innerText()).toContain(currentRange)
    expect(await editor().innerText()).toBe(userDraft)
    expect(await editor().locator('[data-composer-chip="muse-video"]').count()).toBe(0)
    expect(await eventCounts()).toEqual(beforeAdvice)
    const adviceSnapshot = await captureStableAria(page, '[data-muse-suggestion-card]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(golden('authored-shot-advice'),
      adviceSnapshot.replaceAll(encodeURIComponent(source.version), '{{videoVersion}}'), MODE)
    await adviceCard.getByRole('link', { name: 'Use this suggestion in chat', exact: true }).click()
    await expect.poll(() => editor().innerText()).toContain(suggestion)
    expect((await editor().innerText()).startsWith(userDraft)).toBe(true)
    const rangeChip = editor().locator('[data-composer-chip="muse-video"]')
    expect(await rangeChip.count()).toBe(1)
    expect(await rangeChip.innerText()).toContain('Episode 46 · Shot 12 · 1.00–2.00 s')
    expect(await eventCounts()).toEqual(beforeAdvice)
    const revisedName = 'shot-12-revised.mp4'
    const revisedPath = join(scaffold.workspaceCwd, revisedName)
    await copyFile(join(scaffold.workspaceCwd, 'portrait.mp4'), revisedPath)
    const modification = await submitDraft(undefined, 'Here is the revised shot.', {
      name: 'present', call: { files: [{ path: revisedName }] },
    })
    expect(serializedSelections(modification)).toEqual([expect.objectContaining({ source_id: source.id,
      source_version: source.version, authored_shot_number: 12, start_seconds: 1, end_seconds: 2 })])
    expect(modification).toContain(suggestion)
    expect(modification).not.toContain('<!-- muse-video-review:')

    const returned = await scaffold.ctx.sessionVideo.list(agent.id, signal)
    const revised = returned.sources.find(item => item.path === revisedPath)
    if (revised?.version == null) throw Error('Returned video has no playable version')
    const bindRevised = { ...args, source_id: revised.id, source_version: revised.version,
      sha256: createHash('sha256').update(readFileSync(revisedPath)).digest('hex'),
      production: { ...args.production, shotRanges: [{ shotNumber: 12, startSeconds: 0.5, endSeconds: 2.5 }] } }
    const bound = await executeToolFixture(scaffold.ctx, { agent, signal, callId: ToolCallId('bind-revised-shot'),
      name: 'muse_video', arguments: bindRevised })
    expect(bound.isError, JSON.stringify(bound.content)).toBe(false)
    if (typeof bound.value !== 'string') throw Error('Returned video binding produced no result')
    appendToolResult(agent.session, 2, 'bound-revised-shot', 'muse_video', bindRevised, JSON.parse(bound.value) as Record<string, unknown>)

    const preview = workspace().locator(PLAYER)
    const compare = workspace().getByRole('region', { name: 'Shot versions', exact: true })
    const originalVersion = compare.getByRole('button', { name: 'Original V1', exact: true })
    const revisedVersion = compare.getByRole('button', { name: 'New V2', exact: true })
    const revisedScope = 'Episode 46 · Shot 12 · 00:00.50–00:02.50 · V2'
    const returnedCard = '[data-muse-revised-video]'
    const sameShotCompare = page.locator(returnedCard).getByRole('button', { name: 'Compare with original', exact: true })
    await expect.poll(() => scope.innerText()).toContain(`${currentRange} · V1`)
    await sameShotCompare.waitFor()
    const delivery = await captureStableAria(page, returnedCard, scaffold.workspaceCwd)
    const followUp = 'Keep this follow-up while I compare the versions.'
    await editor().fill(followUp)
    const beforeCompare = await eventCounts()
    const workspaceTabs = await page.locator(WORKSPACE).count()
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await workspace().waitFor({ state: 'hidden' })
    expect(await scope.innerText()).toContain(`${currentRange} · V1`)
    await expect.poll(async () => {
      const pin = await scope.boundingBox(), composer = await page.locator('[data-composer-card]:visible').boundingBox()
      return pin !== null && composer !== null ? Math.abs(pin.x - composer.x) : Infinity
    }).toBeLessThanOrEqual(1)
    await sameShotCompare.click()
    await expect.poll(() => preview.getAttribute('aria-label')).toBe(revisedName)
    expect(await page.locator(WORKSPACE).count()).toBe(workspaceTabs)
    expect(await revisedVersion.getAttribute('aria-pressed')).toBe('true')
    expect(await originalVersion.getAttribute('aria-pressed')).toBe('false')
    await expect.poll(() => preview.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1)
    await expect.poll(() => scope.innerText()).toContain(revisedScope)
    expect(await workspace().locator(PREVIEW_SCOPE).innerText()).toContain(revisedScope)
    expect(await editor().innerText()).toBe(followUp)
    expect(await editor().locator('[data-composer-chip="muse-video"]').count()).toBe(0)
    const comparison = await captureStableAria(page, `${WORKSPACE}:visible [aria-label="Shot versions"]`, scaffold.workspaceCwd)
    await compareOrRefreshGolden(golden('authored-shot'), [authoredWorkspace, '## Current shot in chat', authoredComposer,
      '## Returned revision', delivery, '## Same-shot comparison', comparison].join('\n\n'), MODE)

    await originalVersion.click()
    await expect.poll(() => preview.getAttribute('aria-label')).toBe(VIDEO)
    await expect.poll(() => scope.innerText()).toContain(`${currentRange} · V1`)
    const settledPreviewTime = () => preview.evaluate((element) => {
      const video = element as HTMLVideoElement
      return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking ? video.currentTime : -1
    })
    const playhead = workspace().getByRole('slider', { name: 'Playback position', exact: true })
    // A source label can change before metadata and the initial seek have settled.
    await expect.poll(settledPreviewTime).toBeCloseTo(1.25, 2)
    await playhead.press('ArrowRight')
    await expect.poll(settledPreviewTime).toBeGreaterThan(1.25)
    const originalTime = await settledPreviewTime()
    expect(originalTime).toBeLessThan(2)
    await revisedVersion.click()
    await expect.poll(() => preview.getAttribute('aria-label')).toBe(revisedName)
    await expect.poll(settledPreviewTime).toBeCloseTo(0.5 + (originalTime - 1) * 2, 2)
    await workspace().getByRole('button', { name: 'Adopt new version', exact: true }).click()
    expect(await workspace().getByRole('button', { name: 'Adopted', exact: true }).isDisabled()).toBe(true)
    await workspace().getByRole('button', { name: 'Shot 12', exact: true }).locator('img').waitFor()
    await screenshot('session-video-shot-versions.png')
    const desktopViewport = page.viewportSize()
    if (desktopViewport === null) throw Error('Version comparison requires a desktop viewport')
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ colorScheme: 'dark' })
      const small = workspace()
      await expect.poll(() => small.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await small.getByRole('combobox', { name: 'Choose episode', exact: true }).isVisible()).toBe(true)
      expect(await small.locator(PREVIEW_SCOPE).innerText()).toContain(revisedScope)
      expect(await small.getByRole('button', { name: 'Adopted', exact: true }).isVisible()).toBe(true)
      await screenshot('session-video-shot-versions-narrow.png', 'dark')
    } finally {
      await page.setViewportSize(desktopViewport)
      await page.emulateMedia({ colorScheme: 'light' })
    }
    await originalVersion.click()
    await expect.poll(() => preview.getAttribute('aria-label')).toBe(VIDEO)
    await workspace().getByRole('button', { name: 'Shot 12', exact: true }).click()
    await expect.poll(() => preview.getAttribute('aria-label')).toBe(revisedName)
    await workspace().getByRole('button', { name: 'Whole video', exact: true }).click()
    await scope.waitFor({ state: 'hidden' })
    expect(await editor().innerText()).toBe(followUp)
    expect(await eventCounts()).toEqual(beforeCompare)
    expect(createHash('sha256').update(readFileSync(source.path)).digest('hex')).toBe(args.sha256)
    expect(consoleWatch.pageErrors).toEqual([])
  })

  it('fits portrait and landscape media into the available panel and retains controls in short floating panes', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-orientation-fit'))
    const preview = workspace().filter({ has: page.locator(PLAYER) })
    const draft = 'Keep this instruction while resizing the preview.'
    await editor().fill(draft)
    for (const { name, width, height } of ORIENTATIONS) {
      await preview.getByRole('button', { name: 'Video selection', exact: true }).click()
      await preview.getByRole('combobox', { name: 'Choose episode', exact: true }).selectOption('all')
      await preview.getByRole('button', { name: `Switch video: ${name}.mp4`, exact: true }).click()
      const video = preview.locator(PLAYER)
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(width)
      expect(await video.evaluate(element => (element as HTMLVideoElement).videoHeight)).toBe(height)
      await preview.getByRole('button', { name: /^Video segment 1 ·/u }).waitFor()
      await preview.getByRole('slider', { name: 'Playback position', exact: true }).press('ArrowRight')
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
      const time = await video.evaluate(element => (element as HTMLVideoElement).currentTime)
      const mounted = await video.elementHandle()
      if (mounted === null) throw Error('Selected video is not mounted')
      try {
        for (const viewport of [{ width: 1280, height: 820 }, { width: 1680, height: 1000 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport)
          await expect.poll(async () => {
            const box = await video.boundingBox()
            return box?.height ?? 0
          }).toBeGreaterThan(viewport.height * 0.45)
          const box = await video.boundingBox()
          if (box === null) throw Error('Video preview is not rendered')
          expect(await video.evaluate(element => getComputedStyle(element).objectFit)).toBe('contain')
          const renderedWidth = Math.min(box.width, box.height * width / height)
          const renderedHeight = renderedWidth * height / width
          expect(name === 'portrait' ? renderedHeight / box.height : renderedWidth / box.width).toBeCloseTo(1, 2)
          expect(await video.evaluate((element, original) => element === original, mounted)).toBe(true)
          expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(time, 2)
          expect(await preview.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
          await screenshot(`session-video-${name}-${viewport.width}.png`)
        }
        await page.setViewportSize({ width: 1680, height: 1000 })
        await preview.getByRole('button', { name: /^Float/u }).click()
        const floating = page.locator('[data-dockkit-float]').filter({ has: page.locator(WORKSPACE) })
        await expect.poll(() => floating.count()).toBe(1)
        const floatingPreview = floating.locator(WORKSPACE)
        const floatingVideo = floatingPreview.locator(PLAYER)
        const handle = floating.locator('[data-dockkit-float-resize]')
        await expect.poll(() => handle.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        })).toBe(true)
        const pane = await floating.boundingBox(), grip = await handle.boundingBox()
        if (pane === null || grip === null) throw Error('Floating resize control is not rendered')
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
        await page.mouse.down()
        await page.mouse.move(grip.x + grip.width / 2 + 360 - pane.width,
          grip.y + grip.height / 2 + 340 - pane.height, { steps: 12 })
        await page.mouse.up()
        await expect.poll(async () => (await floating.boundingBox())?.height).toBeCloseTo(340, 0)
        await expect.poll(() => floatingPreview.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
        expect((await floatingVideo.boundingBox())?.height).toBeGreaterThanOrEqual(140)
        const review = floatingPreview.getByRole('button', { name: 'Review selected videos', exact: true })
        await review.scrollIntoViewIfNeeded()
        const action = await review.boundingBox()
        const panel = await floating.boundingBox()
        if (action === null || panel === null) throw Error('Review control is not rendered')
        expect(action.y + action.height).toBeLessThanOrEqual(panel.y + panel.height)
        await screenshot(`session-video-${name}-short-float.png`)
        await floatingPreview.getByRole('button', { name: /^(?:Dock|Send back)/u }).click()
        await floating.waitFor({ state: 'hidden' })
        expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(time, 2)
        expect(await editor().innerText()).toBe(draft)
      } finally { await mounted.dispose() }
    }
    expect(consoleWatch.pageErrors).toEqual([])
  })
})
