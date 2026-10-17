/** Muse exposes one creative Agent without preset or plugin-management navigation. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
let overlayRoot: string
const evidenceDir = process.env.DSH_UI_EVIDENCE_DIR

beforeAll(async () => {
  const root = fileURLToPath(new URL('../../desktop-host/', import.meta.url))
  const patches = loadOverlayPatches('muse-med', join(root, 'config/desktop.cordis.patch.yml'))
  const policy = patches.find(row => row.id === 'agent-preset-registry')?.config as {
    default: string
    selectablePresets: string[]
  }
  expect(policy).toEqual({ default: 'short-drama', selectablePresets: ['short-drama'] })
  const definitions: PresetDefinition[] = []
  for (const id of ['short-drama', 'creation', 'standard', 'ptc', 'cordis', 'minimal']) {
    const meta = load(await readFile(join(root, 'presets', id, 'preset.yml'), 'utf8')) as {
      name?: string
      description?: string
      order: number
    }
    definitions.push({ id, ...meta, plugins: [] })
  }
  overlayRoot = await mkdtemp(join(tmpdir(), 'muse-unified-ui-'))
  const overlay = join(overlayRoot, 'ui.patch.yml')
  const uiIds = ['ui-agent-preset', 'ui-plan', 'ui-plugin-manager', 'ui-settings-plugins', 'ui-settings-plugin-inventory']
  const uiRows = patches.filter(row => row.id !== undefined && uiIds.includes(row.id))
  expect(uiRows).toHaveLength(uiIds.length)
  await writeFile(overlay, JSON.stringify(uiRows))
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
  scaffold = await launchWebScaffold({ extraOverlayPath: overlay, agentPresets: { ...policy, definitions } })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
})

afterAll(async () => {
  try { await browser?.close() } finally {
    try { await scaffold?.close() } finally { if (overlayRoot) await rm(overlayRoot, { recursive: true, force: true }) }
  }
})

it('hides preset selection, mode labels and plugin management for the unified Agent', async () => {
  const consoleWatch = watchConsole(page)
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'workspace')
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    expect(await page.getByRole('button', { name: /短剧模式|编辑模式|短剧编导/ }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Plugins', exact: true }).count()).toBe(0)
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `unified-agent-${theme}.png`) })
  }
  await openSettings(page, 'en')
  expect(await page.getByRole('button', { name: 'Agent presets', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Built-in plugins', exact: true }).count()).toBe(0)
  expect((await scaffold.ctx.agentPresets.remoteExportList()).presets.map(row => row.id)).toEqual(['short-drama'])
  if (evidenceDir) await page.screenshot({ path: join(evidenceDir, 'unified-agent-settings.png') })
  expect(consoleWatch.pageErrors).toEqual([])
})
