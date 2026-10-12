/** Muse's new-task picker exposes its two product modes in both themes, without model calls. */
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { load } from 'js-yaml'
import { chromium, type Browser, type Page } from 'playwright'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings } from './support.ts'

let scaffold: WebScaffold
let browser: Browser
let page: Page
const evidenceDir = process.env.DSH_UI_EVIDENCE_DIR

beforeAll(async () => {
  const root = fileURLToPath(new URL('../../desktop-host/', import.meta.url))
  const patch = loadOverlayPatches('muse-med', join(root, 'config/desktop.cordis.patch.yml'))
    .find(row => row.id === 'agent-preset-registry')
  const policy = patch?.config as { default: string; selectablePresets: string[] }
  expect(policy).toEqual({ default: 'short-drama', selectablePresets: ['short-drama', 'editing'] })
  // These UI declarations retain the real product labels; product-preset.spec.ts owns full composition activation.
  const definitions: PresetDefinition[] = []
  for (const id of ['short-drama', 'editing', 'creation', 'standard', 'ptc', 'cordis', 'minimal']) {
    const meta = load(await readFile(join(root, 'presets', id, 'preset.yml'), 'utf8')) as { name?: string; description?: string; order: number }
    definitions.push({ id, ...meta, plugins: [] })
  }
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
  scaffold = await launchWebScaffold({ agentPresets: { ...policy, definitions } })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
})

afterAll(async () => {
  try { await browser?.close() } finally { await scaffold?.close() }
})

it('defaults to short drama, offers editing, and hides the five other modes in conversation and settings', async () => {
  const consoleWatch = watchConsole(page)
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'workspace')
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.getByRole('button', { name: '短剧模式', exact: true }).click()
    await page.getByRole('menu').waitFor()
    expect(await page.getByRole('menuitem').allTextContents()).toEqual([
      expect.stringContaining('短剧模式'), expect.stringContaining('编辑模式'),
    ])
    const menuBounds = await page.getByRole('menu').boundingBox()
    const viewport = page.viewportSize()!
    expect(menuBounds).not.toBeNull()
    expect(menuBounds!.x).toBeGreaterThanOrEqual(0)
    expect(menuBounds!.y).toBeGreaterThanOrEqual(0)
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(viewport.height)
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `two-modes-${theme}.png`) })
    await page.keyboard.press('Escape')
    expect(await page.getByRole('menu').count()).toBe(0)
  }
  await page.getByRole('button', { name: '短剧模式', exact: true }).click()
  await page.getByRole('menuitem', { name: /^编辑模式/ }).click()
  await expect.poll(() => scaffold.ctx.agents.list().filter(agent => agent.session.header.cwd?.endsWith('/workspace'))
    .map(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx))).toEqual(['editing'])
  await openSettings(page, 'en')
  await page.getByRole('button', { name: 'Agent presets', exact: true }).click()
  const dialog = page.getByRole('dialog')
  expect(await dialog.getByText(/Standard mode|PTC mode|Minimal mode|Creator mode|Creation mode/).allTextContents()).toEqual([])
  expect((await scaffold.ctx.agentPresets.remoteExportList()).presets.map(row => row.id)).toEqual(['short-drama', 'editing'])
  if (evidenceDir) await page.screenshot({ path: join(evidenceDir, 'two-modes-settings.png') })
  expect(consoleWatch.pageErrors).toEqual([])
})
