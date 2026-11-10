/** Real Web composition: native workers, owner-only task resources and reversible UI. */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-session-coordinator'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold, type WebConsoleTripwire } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./muse-session-coordinator.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/muse-session-coordinator/tasks.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: Muse Main Session coordination', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleTripwire: WebConsoleTripwire

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ firstUse: true, extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), OVERLAY,
    ], profile: { packages: [
      { dir: fileURLToPath(new URL('../../../packages/session/session-coordinator', import.meta.url)) },
      { dir: fileURLToPath(new URL('../../../packages/client/ui-session-coordinator', import.meta.url)) },
    ] } })
    const initial = await scaffold.ctx.workspaceController.initializeDefault(new AbortController().signal)
    expect(initial?.workspace.path).toBe(join(scaffold.workspaceCwd, 'Documents', 'deepseek-harness', 'default-workspace'))
    const adapter = new MockAdapter([
      textResponse('Main Session is ready to assign the task.'),
      (options) => {
        const input = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'muse-coordination')
        if (input?.source?.kind !== 'muse-coordination') throw new Error('Worker assignment input missing')
        return toolCallResponse('report-web-task', 'coordinator_report', {
          task_id: input.source.taskId, revision: input.source.revision, outcome: 'completed', summary: 'The worker reviewed episode two and retained episode three.',
        })
      },
      textResponse('Worker verification finished.'),
      textResponse('The execution Session has reported its result. Please review it.'),
    ])
    scaffold.ctx.llm.registerAdapter(['coordination-fixture'], adapter)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoleTripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const entry = page.getByRole('button', { name: 'Muse Main Session', exact: true })
    const entryBox = await entry.boundingBox()
    const newBox = await page.getByRole('button', { name: 'New session', exact: true }).last().boundingBox()
    expect(entryBox?.y).toBeLessThan(newBox?.y ?? 0)
    await entry.click()
    await vi.waitFor(() => {
      expect(scaffold.ctx.agents.list().some(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')).toBe(true)
    }, { timeout: 15000 })
    const main = scaffold.ctx.agents.list().find(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')
    if (main === undefined) throw new Error('Web profile did not activate the selected Main preset')
    expect(main.session.header.cwd).toBe(initial?.workspace.path)
    await entry.click()
    expect(scaffold.ctx.agents.list().filter(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')).toHaveLength(1)
    const denied = await executeToolFixture(scaffold.ctx, { agent: main, name: 'bash',
      arguments: { command: 'echo should-not-run' }, callId: ToolCallId('main-business-denial'), signal: new AbortController().signal })
    expect(denied.isError).toBe(true)
    main.model.select({ provider: 'coordination-fixture', model: 'mock' })
    main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review episode two; retain episode three.' }] }))
    await main.whenIdle()
    const dispatched = await executeToolFixture(scaffold.ctx, { agent: main, name: 'coordinator_dispatch',
      arguments: { request_key: 'web-review-episode-2', cwd: join(scaffold.workspaceCwd, 'workspace'), title: 'Review episode two',
        instructions: 'Review episode two. Do not change episode three. This fixture does not write files or call a provider.', reason: 'Fresh isolated review context' },
      callId: ToolCallId('main-dispatch'), signal: new AbortController().signal })
    expect(dispatched.isError).not.toBe(true)
    await page.getByText('Worker completed', { exact: true }).waitFor({ timeout: 20000 })
    await main.whenIdle()
    const matches = JSON.parse(await scaffold.ctx.sessionCoordinator.search(main, 'Review episode')) as { sessions: { sessionId: string }[] }
    expect(matches.sessions.length).toBeGreaterThan(0)
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows real native task receipts and opens the independent execution Session', async () => {
    const cards = page.locator('[data-muse-coordination-cards]')
    expect(await cards.getByText('The worker reviewed episode two and retained episode three.').count()).toBe(1)
    expect(await cards.getByText('Worker report; awaiting your acceptance').count()).toBe(1)
    expect(await cards.getByText('Stop task', { exact: true }).count()).toBe(0)
    const aria = await captureStableAria(page, '[data-muse-coordination-cards]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EXPECTED, aria, MODE)
    await mkdir(join(process.cwd(), '.artifacts'), { recursive: true })
    await page.screenshot({ path: join(process.cwd(), '.artifacts/muse-session-coordinator.png') })
    await cards.getByRole('button', { name: 'Open execution chat' }).click()
    await page.getByText('Worker verification finished.', { exact: true }).waitFor()
    expect(await page.locator('[data-muse-coordination-cards]').count()).toBe(0)
    await page.getByRole('button', { name: 'Muse Main Session', exact: true }).click()
    await page.getByText('Worker completed', { exact: true }).waitFor()
  })

  it('removes and restores its UI without duplicate cards or another worker execution', async () => {
    const ui = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ui-muse-session-coordinator')
    if (ui?.options.id === undefined) throw new Error('Task UI loader entry missing')
    const count = scaffold.ctx.agents.list().length
    scaffold.ctx.loader.remove(ui.id)
    await expect.poll(() => page.locator('[data-muse-coordination-cards]').count()).toBe(0)
    expect(await page.locator('[data-muse-main-entry]').count()).toBe(0)
    await scaffold.ctx.loader.create({ name: '@deepseek-ai/dsh-client-ui-session-coordinator' })
    await page.getByText('Worker completed', { exact: true }).waitFor()
    expect(await page.locator('[data-muse-coordination-cards]').count()).toBe(1)
    expect(await page.locator('[data-muse-main-entry]').count()).toBe(1)
    expect(scaffold.ctx.agents.list()).toHaveLength(count)
    expect(consoleTripwire.warnings).toEqual([])
    expect(consoleTripwire.pageErrors).toEqual([])
  })
})
