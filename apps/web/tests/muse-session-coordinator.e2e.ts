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
const EXPECTED = fileURLToPath(new URL('./expected/muse-session-coordinator/navigation.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: Muse Main Session coordination', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleTripwire: WebConsoleTripwire
  let mainId: string
  let workerId: string

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
      (options) => {
        const receipt = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'muse-coordination' && message.source.purpose === 'receipt')
        if (!JSON.stringify(receipt?.content).includes('The worker reviewed episode two and retained episode three.')) throw new Error('Worker result missing from Main Session receipt')
        return textResponse('The worker reviewed episode two and retained episode three; the result is ready for your review.')
      },
    ])
    scaffold.ctx.llm.registerAdapter(['coordination-fixture'], adapter)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoleTripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
    expect(scaffold.ctx.agentPresets.defaultId).toBe('standard')
    expect(await page.getByTitle('Choose the agent preset for your new task').count()).toBe(0)
    const entry = page.getByRole('button', { name: 'Muse Main Session', exact: true })
    const entryBox = await entry.boundingBox()
    const newBox = await page.getByRole('button', { name: 'New session', exact: true }).last().boundingBox()
    expect(newBox?.y).toBeLessThan(entryBox?.y ?? 0)
    await vi.waitFor(() => {
      expect(scaffold.ctx.agents.list().some(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')).toBe(true)
    }, { timeout: 15000 })
    const main = scaffold.ctx.agents.list().find(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')
    if (main === undefined) throw new Error('Web profile did not activate the selected Main preset')
    mainId = main.id
    expect(scaffold.ctx.agentPresets.composedPreset(main.ctx)).toBe('main-session')
    expect(main.session.header.cwd).toBe(initial?.workspace.path)
    await vi.waitFor(async () => {
      expect(await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')).toBe(mainId)
    }, { timeout: 15000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await vi.waitFor(async () => {
      const selected = await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')
      expect(selected).toBeTruthy()
      expect(selected).not.toBe(mainId)
    }, { timeout: 15000 })
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
    await page.getByText('The worker reviewed episode two and retained episode three; the result is ready for your review.', { exact: true }).waitFor({ timeout: 20000 })
    await main.whenIdle()
    expect(await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')).toBe(main.id)
    const matches = JSON.parse(await scaffold.ctx.sessionCoordinator.search(main, 'Review episode')) as { sessions: { sessionId: string }[] }
    expect(matches.sessions.length).toBeGreaterThan(0)
    workerId = matches.sessions[0]!.sessionId
    await vi.waitFor(async () => {
      expect(await page.locator(`[data-row-key="session:${mainId}"]`).count()).toBe(0)
      expect(await page.locator(`[data-row-key="session:${workerId}"]`).count()).toBe(1)
    })
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('relays results in chat and opens the worker through its native sidebar row without task overlays', async () => {
    expect(await page.locator('[data-muse-coordination-cards]').count()).toBe(0)
    const workerRow = page.locator(`[data-row-key="session:${workerId}"]`)
    expect(await workerRow.locator('[data-task-status]').count()).toBe(0)
    const aria = await captureStableAria(page, '[data-muse-main-entry]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EXPECTED, aria, MODE)
    await mkdir(join(process.cwd(), '.artifacts'), { recursive: true })
    await page.screenshot({ path: join(process.cwd(), '.artifacts/muse-session-coordinator.png') })
    await workerRow.click()
    await page.getByText('Worker verification finished.', { exact: true }).waitFor()
    expect(await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')).toBe(workerId)
    expect(await page.locator('[data-muse-coordination-cards]').count()).toBe(0)
    await page.getByRole('button', { name: 'Muse Main Session', exact: true }).click()
    await page.getByText('The worker reviewed episode two and retained episode three; the result is ready for your review.', { exact: true }).waitFor()
  })

  it('opens the retained Main Session after reload while ordinary work remains listed', async () => {
    const workerRow = page.locator(`[data-row-key="session:${workerId}"]`)
    expect(await workerRow.locator('[data-task-status]').count()).toBe(0)
    await workerRow.click()
    await page.getByText('Worker verification finished.', { exact: true }).waitFor()
    expect(await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')).toBe(workerId)
    await page.reload({ waitUntil: 'load' })
    const entry = page.getByRole('button', { name: 'Muse Main Session', exact: true })
    await entry.waitFor({ timeout: 30000 })
    await expect.poll(async () => page.locator('[data-conversation-content]').getAttribute('data-conversation-session'), { timeout: 30000 })
      .toBe(mainId)
    await page.getByText('The worker reviewed episode two and retained episode three; the result is ready for your review.', { exact: true }).waitFor({ timeout: 20000 })
    await page.getByText('Review episode two; retain episode three.', { exact: true }).first().waitFor({ timeout: 20000 })
    await vi.waitFor(async () => {
      expect(await page.locator(`[data-row-key="session:${mainId}"]`).count()).toBe(0)
      expect(await page.locator(`[data-row-key="session:${workerId}"]`).count()).toBe(1)
    })
    expect(scaffold.ctx.agents.list().filter(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')).toHaveLength(1)
  })

  it('removes and restores its entry without task overlays or another worker execution', async () => {
    const ui = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ui-muse-session-coordinator')
    if (ui?.options.id === undefined) throw new Error('Task UI loader entry missing')
    const count = scaffold.ctx.agents.list().length
    scaffold.ctx.loader.remove(ui.id)
    await expect.poll(() => page.locator('[data-muse-main-entry]').count()).toBe(0)
    expect(await page.locator('[data-muse-coordination-cards]').count()).toBe(0)
    await scaffold.ctx.loader.create({ name: '@deepseek-ai/dsh-client-ui-session-coordinator' })
    await page.locator('[data-muse-main-entry]').waitFor()
    expect(await page.locator('[data-muse-coordination-cards]').count()).toBe(0)
    expect(await page.locator('[data-task-status]').count()).toBe(0)
    expect(await page.locator('[data-muse-main-entry]').count()).toBe(1)
    expect(scaffold.ctx.agents.list()).toHaveLength(count)
    expect(consoleTripwire.warnings).toEqual([])
    expect(consoleTripwire.pageErrors).toEqual([])
  })
})
