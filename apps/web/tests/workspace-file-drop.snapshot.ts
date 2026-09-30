/** Workspace-tree gestures preserve the draft and send ordinary file references through the shipped Web profile. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  recordFixture, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/workspace-file-drop', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

it('replays workspace file drag and touch menu references without uploading or sending the draft', async () => {
  const prompt = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]!
  const scaffold = await launchWebScaffold({
    ...(MODE === 'record' ? {} : { replayFixture: FIXTURE }),
    compareReplaySession: true,
  })
  let browser: Browser | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined
  let failure: unknown
  try {
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    await Promise.all([
      writeFile(join(cwd, 'notes 中文.txt'), 'Workspace review notes.\n'),
      writeFile(join(cwd, 'outline.md'), '# Workspace outline\n'),
    ])
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('[data-composer-input]').first()
    await input.fill('Review ')
    await page.locator('[data-sidebar-right-expand]').click()
    await page.locator('[data-sidebar-right-guide-entry="files"]').click()
    const notes = page.locator('[data-files-entry="file"]').getByRole('button', { name: 'notes 中文.txt', exact: true })
    expect(await notes.getAttribute('draggable')).toBe('true')
    await notes.dragTo(input)
    await expect.poll(() => input.innerText()).toContain('notes 中文.txt')
    await expect.poll(() => input.innerText()).toContain('Review ')
    await input.press('ControlOrMeta+End')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Actions for outline.md', exact: true }).click()
    const add = page.getByRole('menuitem', { name: 'Add to conversation', exact: true })
    await add.waitFor()
    const menuBounds = await add.boundingBox()
    expect(menuBounds).not.toBeNull()
    expect(menuBounds!.x).toBeGreaterThanOrEqual(0)
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(390)
    await add.click()
    await expect.poll(() => input.innerText()).toContain('outline.md')
    expect(await input.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    const sessionBeforeSend = scaffold.ctx.agents.list().find(agent => agent.session.header.cwd === cwd)?.session
    if (sessionBeforeSend === undefined) throw new Error('connected workspace has no Session')
    expect(sessionBeforeSend.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
    const draft = await captureStableAria(page, '[data-composer-input]', scaffold.workspaceCwd)

    await page.setViewportSize({ width: 1280, height: 900 })
    const settled = scaffold.whenTurnSettled()
    await input.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.agents.get(sessionId)?.session
    if (session === undefined) throw new Error('reference turn has no Session')
    const user = session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
    expect(user).toHaveLength(1)
    expect(user[0]!.content).toEqual([{ type: 'text', text: prompt }])
    await page.getByText('REFERENCES_READY', { exact: true }).waitFor()
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
    if (MODE !== 'record') {
      await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), `## Draft references\n\n${draft}`, MODE)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } catch (error) {
    failure = (tripwire?.pageErrors.length ?? 0) + (tripwire?.warnings.length ?? 0) === 0 ? error
      : new Error(`Browser diagnostics: ${JSON.stringify(tripwire)}`, { cause: error })
    throw failure
  } finally {
    try {
      await browser?.close()
    } finally {
      try { await scaffold.close() } catch (error) {
        if (failure !== undefined) throw new AggregateError([failure, error], 'Workspace file drop failed before scaffold cleanup')
        throw error
      }
    }
  }
})
