/** Real browser decoding and seeking over the shipped authenticated workspace video route. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-subprocess'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, REPO_ROOT, saveFailureShot } from './support.ts'

/** @param player - Actual media element. @returns Visible native controls contained by the viewport. */
async function visibleControls(player: Locator) {
  return await player.evaluate((node: HTMLVideoElement) => {
    const rect = node.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 8)
    return { controls: node.controls, width: rect.width, height: rect.height,
      contained: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      unobstructed: hit === node || (hit !== null && node.contains(hit)) }
  })
}

it('loads, seeks and streams an actual MP4 with visible controls in light, dark and narrow layouts', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'muse-video-preview-failure'))
  const tripwire = watchConsole(page)
  const workspace = join(scaffold.workspaceCwd, 'workspace')
  await mkdir(workspace)
  const ffmpeg = await scaffold.ctx.subprocess.resolveExecutable(process.env.DSH_FFMPEG_PATH ?? 'ffmpeg')
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('MP4 fixture encoding timed out')) }, 30_000)
  let child: ReturnType<typeof scaffold.ctx.subprocess.spawn> | undefined
  try {
    child = scaffold.ctx.subprocess.spawn({
      argv: [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(workspace, 'preview.mp4')],
      cwd: workspace, signal: controller.signal, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 32_768 } },
    })
    const outcome = await child.done
    controller.signal.throwIfAborted()
    expect(outcome.exitCode, child.collected.stderr?.readFrom(0).text).toBe(0)
  } finally {
    clearTimeout(timer)
    if (child) { child.terminate(); await child.waitForExit() }
  }
  const ranges: { status: number; range: string | null; contentRange: string | undefined }[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/api/video') return
    ranges.push({ status: response.status(), range: response.request().headers().range ?? null,
      contentRange: response.headers()['content-range'] })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await page.locator('[data-sidebar-right-expand]').click()
  await page.locator('[data-sidebar-right-guide-entry="files"]').click()
  await page.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
  await page.locator('[data-files-entry="file"]').getByRole('button', { name: 'preview.mp4', exact: true }).click()
  const player = page.locator('video[data-video-preview]')
  await player.waitFor({ state: 'visible' })
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(1)
  expect(await player.evaluate((node: HTMLVideoElement) => node.duration)).toBeCloseTo(4, 1)
  await expect.poll(() => ranges.some(row => row.status === 206 && row.range !== null && row.contentRange?.startsWith('bytes '))).toBe(true)
  await player.evaluate(async (node: HTMLVideoElement) => { await node.play() })
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0)
  await player.evaluate((node: HTMLVideoElement) => { node.pause(); node.currentTime = 3 })
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => !node.seeking && node.currentTime >= 2.9)).toBe(true)
  const source = await player.getAttribute('src')
  if (source === null) throw new Error('Video player has no source')
  const head = await page.request.head(source)
  expect(head.status()).toBe(200)
  expect(head.headers()['accept-ranges']).toBe('bytes')
  expect(Number(head.headers()['content-length'])).toBeGreaterThan(0)
  const range = await page.request.get(source, { headers: { Range: 'bytes=0-127' } })
  expect(range.status()).toBe(206)
  expect(range.headers()['content-range']).toMatch(/^bytes 0-127\/\d+$/u)
  expect((await range.body()).byteLength).toBe(128)
  const screenshots = join(REPO_ROOT, '.artifacts', 'muse-video-preview')
  await mkdir(screenshots, { recursive: true })
  for (const palette of ['light', 'dark'] as const) {
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: palette === 'light' ? 'Light' : 'Dark', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(palette === 'dark')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => visibleControls(player)).toMatchObject({ controls: true, contained: true, unobstructed: true })
    await page.screenshot({ path: join(screenshots, `${palette}.png`) })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.locator('[data-sidebar-right-panel="fullscreen"]').count()).toBe(1)
  await expect.poll(() => visibleControls(player)).toMatchObject({ controls: true, contained: true, unobstructed: true })
  const size = await visibleControls(player)
  expect(size.width).toBeGreaterThan(250)
  expect(size.height).toBeGreaterThan(100)
  await page.screenshot({ path: join(screenshots, 'narrow.png') })
  expect(tripwire.pageErrors).toEqual([])
})
