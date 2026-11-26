/** Compact deliveries retain source identity through one conversation video workspace. */
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

describe('web e2e: compact conversation video entries', () => {
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

  it('keeps both delivery identities while selecting one preview and preserving the modification draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-compact-deliveries'))
    const cards = page.locator('[data-muse-inline-video]')
    await expect.poll(() => cards.count(), { timeout: 30000 }).toBe(2)
    const first = cards.nth(0), second = cards.nth(1)
    expect(await cards.locator('[data-muse-shelf-video]').count()).toBe(0)
    const firstThumbnail = await first.locator('video').getAttribute('src')
    const secondThumbnail = await second.locator('video').getAttribute('src')
    if (firstThumbnail === null || secondThumbnail === null) throw Error('A delivered video has no thumbnail source')
    for (const [thumbnail, index] of [[firstThumbnail, 0], [secondThumbnail, 1]] as const) {
      const address = new URL(thumbnail, page.url())
      expect(address.origin).toBe(new URL(page.url()).origin)
      expect(address.pathname).toBe('/api/video')
      expect(address.searchParams.get('sessionId')).toBe(SESSION)
      expect(address.searchParams.get('presentedSeq')).toMatch(/^\d+$/u)
      expect(address.searchParams.get('presentedIndex')).toBe(String(index))
    }
    expect(firstThumbnail).not.toBe(secondThumbnail)
    const editor = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this unfinished instruction.'
    await editor.fill(draft)
    const before = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    await first.getByRole('button', { name: /^Switch video:/u }).click()
    const workspace = page.locator('[data-muse-video-workspace]:visible')
    const video = workspace.locator('[data-muse-shelf-video]')
    await expect.poll(() => video.getAttribute('aria-label')).toBe(FIRST)
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
    expect(await video.evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(3)
    const firstPlayback = await video.evaluate(element => (element as HTMLVideoElement).currentSrc)
    expect(new URL(firstPlayback).origin).toBe(new URL(page.url()).origin)
    expect(new URL(firstPlayback).pathname).toBe('/api/session-video')
    await workspace.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    await workspace.getByRole('button', { name: 'Pause', exact: true }).click()
    const shots = workspace.getByRole('button', { name: /^Video segment \d+ ·/u })
    await expect.poll(() => shots.count(), { timeout: 30000 }).toBe(3)
    await shots.nth(1).press('Enter')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    expect(await editor.innerText()).toBe(draft)
    await second.getByRole('button', { name: /^Switch video:/u }).click()
    await expect.poll(() => video.getAttribute('aria-label')).toBe(SECOND)
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
    expect(await video.evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(3)
    await expect.poll(() => shots.count(), { timeout: 30000 }).toBe(3)
    const secondPlayback = await video.evaluate(element => (element as HTMLVideoElement).currentSrc)
    expect(new URL(secondPlayback).origin).toBe(new URL(page.url()).origin)
    expect(new URL(secondPlayback).pathname).toBe('/api/session-video')
    expect(secondPlayback).not.toBe(firstPlayback)
    expect(await first.locator('video').getAttribute('src')).toBe(firstThumbnail)
    expect(await second.locator('video').getAttribute('src')).toBe(secondThumbnail)
    await workspace.getByRole('button', { name: 'Video selection', exact: true }).click()
    const choices = workspace.getByRole('button', { name: /^Switch video:/u })
    expect(await choices.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
      .toEqual(['Switch video: ' + FIRST, 'Switch video: ' + SECOND])
    const firstChoice = workspace.getByRole('button', { name: 'Switch video: ' + FIRST, exact: true })
    const secondChoice = workspace.getByRole('button', { name: 'Switch video: ' + SECOND, exact: true })
    expect(await firstChoice.getByText('Previewing', { exact: true }).count()).toBe(0)
    expect(await firstChoice.getAttribute('aria-pressed')).toBe('false')
    expect(await secondChoice.getByText('Previewing', { exact: true }).isVisible()).toBe(true)
    expect(await secondChoice.getAttribute('aria-pressed')).toBe('true')
    await secondChoice.click()
    await shots.nth(1).press('Enter')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
    expect(await shots.nth(1).getAttribute('aria-pressed')).toBe('true')
    await workspace.getByRole('button', { name: 'Add selected segment', exact: true }).click()
    await workspace.getByRole('button', { name: 'Prepare edit', exact: true }).click()
    await expect.poll(() => editor.innerText()).toContain('Apply my requested changes to the videos or visual segments selected in this message.')
    const text = await editor.innerText()
    expect(text.startsWith(draft)).toBe(true)
    expect(text).toContain('1.00–2.00 s · ' + SECOND)
    expect(text).not.toContain(FIRST)
    const after = await scaffold.ctx.sessionQuery.readSession(SessionId(SESSION))
    expect(after.events.filter(event => event.type === 'user/message')).toHaveLength(before.events.filter(event => event.type === 'user/message').length)
    expect(after.events.filter(event => event.type === 'request/header')).toHaveLength(0)
    expect(await page.locator('[data-muse-video-anchor]').count()).toBe(1)
    expect(await page.locator('[data-muse-video-launcher]').count()).toBe(0)
    expect(await workspace.locator('[data-muse-shelf-video]').count()).toBe(1)
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

  it('keeps recorded generated videos, selections and modification drafts inside their owning Sessions', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-video-generated-workspace-isolation'))
    const openSession = async (id: string, title: string) => {
      await page.locator('[data-row-key="session:' + id + '"]').click({ timeout: 15000 })
      await page.getByText('The generated video for ' + title + ' is ready.', { exact: true }).waitFor({ timeout: 15000 })
    }
    const openCard = async (label: string, otherLabel: string) => {
      const cards = page.locator('[data-muse-inline-video]')
      await expect.poll(() => cards.count(), { timeout: 30000 }).toBe(1)
      const card = cards.first()
      await card.scrollIntoViewIfNeeded()
      expect(await card.getByRole('button', { name: 'Switch video: ' + label, exact: true }).count()).toBe(1)
      expect(await card.locator('[data-muse-shelf-video]').count()).toBe(0)
      await card.getByRole('button', { name: 'Switch video: ' + label, exact: true }).click()
      const workspace = page.locator('[data-muse-video-workspace]:visible')
      const video = workspace.locator('[data-muse-shelf-video]')
      await expect.poll(() => video.getAttribute('aria-label')).toBe(label)
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState),
        { timeout: 30000 }).toBeGreaterThanOrEqual(1)
      const playback = await video.evaluate(element => (element as HTMLVideoElement).currentSrc)
      expect(new URL(playback).origin).toBe(new URL(page.url()).origin)
      expect(new URL(playback).pathname).toBe('/api/session-video')
      await workspace.getByRole('button', { name: 'Video selection', exact: true }).click()
      expect(await workspace.getByRole('button', { name: /^Switch video:/u }).count()).toBe(1)
      expect(await workspace.getByRole('button', { name: 'Switch video: ' + otherLabel, exact: true }).count()).toBe(0)
      const selected = workspace.getByRole('button', { name: 'Switch video: ' + label, exact: true })
      expect(await selected.getByText('Previewing', { exact: true }).isVisible()).toBe(true)
      expect(await selected.getAttribute('aria-pressed')).toBe('true')
      await selected.click()
      const shots = workspace.getByRole('button', { name: /^Video segment \d+ ·/u })
      await expect.poll(() => shots.count(), { timeout: 30000 }).toBe(3)
      return { workspace, video, shots, playback }
    }
    const input = page.locator('[data-composer-input][contenteditable="true"]').last()
    const prepare = async (draft: string, label: string, selection: Awaited<ReturnType<typeof openCard>>) => {
      await selection.shots.nth(1).press('Enter')
      await expect.poll(() => selection.video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1)
      await input.fill(draft)
      await selection.workspace.getByRole('button', { name: 'Add selected segment', exact: true }).click()
      await selection.workspace.getByRole('button', { name: 'Prepare edit', exact: true }).click()
      await expect.poll(() => input.innerText()).toContain('Apply my requested changes to the videos or visual segments selected in this message.')
      expect((await input.innerText()).startsWith(draft)).toBe(true)
      expect(await input.innerText()).toContain('1.00–2.00 s · ' + label)
    }
    await openSession(GENERATED_SESSION_A, GENERATED_TITLE_A)
    const first = await openCard(GENERATED_A, GENERATED_B)
    await first.workspace.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(() => first.video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    await first.workspace.getByRole('button', { name: 'Pause', exact: true }).click()
    await prepare('Keep alpha draft.', GENERATED_A, first)
    const alphaDraft = await input.innerText()
    await openSession(GENERATED_SESSION_B, GENERATED_TITLE_B)
    expect(await input.innerText()).not.toContain('Keep alpha draft.')
    expect(await input.innerText()).not.toContain(GENERATED_A)
    const second = await openCard(GENERATED_B, GENERATED_A)
    expect(second.playback).not.toBe(first.playback)
    await prepare('Keep beta draft.', GENERATED_B, second)
    expect(await input.innerText()).not.toContain(GENERATED_A)
    const betaDraft = await input.innerText()
    await openSession(GENERATED_SESSION_A, GENERATED_TITLE_A)
    await openCard(GENERATED_A, GENERATED_B)
    expect(await input.innerText()).toBe(alphaDraft)
    expect(await input.innerText()).not.toContain(GENERATED_B)
    await openSession(GENERATED_SESSION_B, GENERATED_TITLE_B)
    await openCard(GENERATED_B, GENERATED_A)
    expect(await input.innerText()).toBe(betaDraft)
    expect(await input.innerText()).not.toContain(GENERATED_A)
    for (const id of [GENERATED_SESSION_A, GENERATED_SESSION_B]) {
      const session = await scaffold.ctx.sessionQuery.readSession(SessionId(id))
      expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
      expect(session.events.filter(event => event.type === 'request/header')).toHaveLength(0)
    }
    expect(consoleWatch.pageErrors).toEqual([])
  }, 180000)
})
