/** Real Web composition: native workers, owner-only task resources and reversible UI. */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-session-coordinator'
import type {} from '@deepseek-ai/dsh-agent-team'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold, type WebConsoleTripwire } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./muse-session-coordinator.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/muse-session-coordinator/navigation.expected.md', import.meta.url))
const REPORT_EXPECTED = fileURLToPath(new URL('./expected/muse-session-coordinator/report.expected.md', import.meta.url))
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
    await mkdir(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'episode-two-review.md'), '# Episode two review\n\nEpisode three remains unchanged.\n')
    const adapter = new MockAdapter([
      textResponse('Main Session is ready to assign the task.'),
      toolCallResponse('present-web-review', 'present', {
        files: [{ path: 'episode-two-review.md', description: 'Episode two review notes' }],
      }),
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
        expect(options.tools?.map(tool => tool.name)).toContain('coordinator_show_report')
        return toolCallResponse('show-web-report', 'coordinator_show_report', {})
      },
      textResponse('The worker reviewed episode two and retained episode three; the result is ready for your review.'),
    ])
    vi.spyOn(adapter, 'listModels').mockResolvedValue([{ provider: 'coordination-fixture', id: 'mock', name: 'Coordination fixture' }])
    scaffold.ctx.llm.registerAdapter(['coordination-fixture'], adapter)
    expect((await scaffold.ctx.sessionController.modelCatalog()).groups.find(group => group.id === 'coordination-fixture'))
      .toMatchObject({ models: [{ id: 'mock' }] })
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
      arguments: { request_key: 'web-review-episode-2', cwd: join(scaffold.workspaceCwd, 'workspace'),
        title: 'Review episode two and retain episode three — verify all previously accepted scene boundaries',
        instructions: 'Review episode two. Do not change episode three. Present the existing fixture review notes, then report the result.', reason: 'Fresh isolated review context' },
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

  it('keeps the Main Session routing-only while exposing official Team controls in execution Sessions', async () => {
    const main = scaffold.ctx.agents.list().find(agent => agent.id === mainId)
    const worker = scaffold.ctx.agents.list().find(agent => agent.id === workerId)
    if (main === undefined || worker === undefined) throw new Error('Coordination Sessions are not live')
    const denied = await executeToolFixture(scaffold.ctx, { agent: main, name: 'team_task_create',
      arguments: { subject: 'Main must delegate this work' }, callId: ToolCallId('main-team-denial'), signal: new AbortController().signal })
    expect(denied.isError).toBe(true)
    await page.getByRole('button', { name: /^Select model/u }).click()
    expect(await page.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).count()).toBe(0)
    expect(await page.locator('[data-subagent-action]').count()).toBe(0)
    await page.keyboard.press('Escape')

    await scaffold.ctx.agentTeams.setEnabled(worker, true)
    const task = await scaffold.ctx.agentTeams.createTask(worker, {
      subject: 'Verify episode continuity together', description: 'Keep shared work inside the execution Session.',
    })
    await page.locator(`[data-row-key="session:${workerId}"]`).click()
    await page.getByText('Worker verification finished.', { exact: true }).waitFor()
    await page.getByRole('button', { name: /^Select model/u }).click()
    const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
    await toggle.waitFor()
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '0 subagents', exact: true }).click()
    await page.locator('[data-team-panel]').getByText(task.subject, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Muse Main Session', exact: true }).click()
    await page.getByText('The worker reviewed episode two and retained episode three; the result is ready for your review.', { exact: true }).waitFor()
    expect(await page.locator('[data-subagent-action], [data-team-panel]').count()).toBe(0)
  })

  it('shows the actual worker report and delivered file inline with usable actions in both themes and narrow layouts', async () => {
    const report = page.locator('[data-muse-coordination-report]')
    await report.waitFor({ timeout: 20000 })
    await report.getByText('Current status', { exact: false }).waitFor()
    expect(await report.getByText('The worker reviewed episode two and retained episode three.', { exact: true }).count()).toBe(1)
    expect(await report.getByRole('button', { name: 'Episode two review notes', exact: true }).count()).toBe(1)
    const aria = await captureStableAria(page, '[data-muse-coordination-report]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(REPORT_EXPECTED, aria, MODE)
    await report.getByRole('button', { name: 'Open execution chat', exact: true }).click()
    await page.getByText('Worker verification finished.', { exact: true }).waitFor()
    expect(await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')).toBe(workerId)
    await page.getByRole('button', { name: 'Muse Main Session', exact: true }).click()
    await report.waitFor()
    await report.getByRole('button', { name: 'Episode two review notes', exact: true }).click()
    await page.getByText('Episode three remains unchanged.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await mkdir(join(process.cwd(), '.artifacts', 'muse-main-reports'), { recursive: true })
    try {
      const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
      if (await collapse.isVisible()) await collapse.click()
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'dark' ? '' : null)
        for (const width of [1280, 520]) {
          await page.setViewportSize({ width, height: 960 })
          await report.scrollIntoViewIfNeeded()
          const bounds = await report.boundingBox()
          expect(bounds).not.toBeNull()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
          await report.getByRole('button', { name: 'Open execution chat', exact: true }).click({ trial: true })
          await page.screenshot({ path: join(process.cwd(), '.artifacts', 'muse-main-reports', `${theme}-${width}.png`), animations: 'disabled' })
        }
      }
    } finally {
      await page.setViewportSize({ width: 1280, height: 960 })
      await page.emulateMedia({ colorScheme: 'light' })
      const expand = page.getByRole('button', { name: 'Open sidebar', exact: true })
      if (await expand.isVisible()) await expand.click()
    }
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
    const report = page.locator('[data-muse-coordination-report]')
    await report.waitFor({ timeout: 20000 })
    expect(await report.getByRole('button', { name: 'Episode two review notes', exact: true }).count()).toBe(1)
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

  it('keeps a real reconciliation receipt readable while delivery waits, then follows its verified result', async () => {
    const main = scaffold.ctx.agents.list().find(agent => agent.id === mainId)
    if (main === undefined) throw new Error('Main Session is not live')
    let showReport = true
    const reported = new Set<string>()
    const adapter = new MockAdapter(Array.from({ length: 30 }, () => (options: GenerateOptions) => {
      const human = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user')
      if (options.tools?.some(tool => tool.name === 'coordinator_dispatch')) {
        if (showReport && JSON.stringify(human?.content).includes('Show reconciliation status')) {
          showReport = false
          return toolCallResponse('show-reconciliation', 'coordinator_show_report', {})
        }
        return textResponse('Task status received.')
      }
      const brief = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'muse-coordination')
      if (brief?.source?.kind === 'muse-coordination' && brief.source.revision === 2 && !reported.has(brief.source.taskId)) {
        reported.add(brief.source.taskId)
        return toolCallResponse('report-reconciliation', 'coordinator_report', { task_id: brief.source.taskId,
          revision: 2, outcome: 'completed', summary: 'Existing work verified without replaying the business command.' })
      }
      return textResponse('Existing work retained.')
    }))
    scaffold.ctx.llm.registerAdapter(['reconciliation-fixture'], adapter)
    main.model.select({ provider: 'reconciliation-fixture', model: 'mock' })
    const initial = await scaffold.ctx.sessionCoordinator.dispatch(main, { key: 'web-reconciliation', title: 'Verify existing work',
      instructions: 'Inspect the existing work only.', reason: 'Reconciliation UI fixture' })
    const workerId = initial.attempts.at(-1)!.sessionId
    const worker = scaffold.ctx.agents.get(workerId)!
    await worker.whenIdle()
    await expect.poll(() => scaffold.ctx.sessionCoordinator.list(main.id).find(task => task.id === initial.id)?.attempts.at(-1)?.status)
      .toBe('needs-report')
    worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Retain episode three and verify existing work.' }] }))
    await worker.whenIdle()
    await expect.poll(() => scaffold.ctx.sessionCoordinator.list(main.id).find(task => task.id === initial.id)?.attempts.at(-1)?.status)
      .toBe('needs-report')
    await main.whenIdle()
    const log = await scaffold.ctx.sessionQuery.readSession(workerId)
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const resolveAgent = scaffold.ctx.sessionController.resolveAgent.bind(scaffold.ctx.sessionController)
    let resolutions = 0
    const resolve = vi.spyOn(scaffold.ctx.sessionController, 'resolveAgent').mockImplementation(async (...args) => {
      if (args[0] === workerId && ++resolutions === 2) { ready.resolve(undefined); await release.promise }
      return resolveAgent(...args)
    })
    const operation = scaffold.ctx.sessionCoordinator.reconcile(main, { key: 'web-reconciliation-check', taskId: initial.id,
      expectedRevision: 1, expectedWorkerSeq: log.events.at(-1)!.seq,
      instructions: 'Verify the existing work and report its state.', reason: 'User clarified the retained scope' })
    try {
      await ready.promise
      main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show reconciliation status.' }] }))
      await main.whenIdle()
      const report = page.locator(`[data-report-task="${initial.id}"][data-report-revision="2"]`).last()
      await report.getByText('Preparing reconciliation', { exact: true }).waitFor()
      expect(await report.getByText('Worker completed', { exact: true }).count()).toBe(0)
      await report.getByRole('button', { name: 'Open execution chat', exact: true }).click({ trial: true })
      await mkdir(join(process.cwd(), '.artifacts', 'muse-main-reconciliation'), { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await report.scrollIntoViewIfNeeded()
        await report.screenshot({ path: join(process.cwd(), '.artifacts', 'muse-main-reconciliation', `${theme}.png`) })
      }
    } finally {
      release.resolve(undefined)
      resolve.mockRestore()
      await operation
      await page.emulateMedia({ colorScheme: 'light' })
    }
    await worker.whenIdle()
    await expect.poll(() => scaffold.ctx.sessionCoordinator.list(main.id).find(task => task.id === initial.id)?.attempts.at(-1)?.status)
      .toBe('completed')
    const report = page.locator(`[data-report-task="${initial.id}"][data-report-revision="2"]`).last()
    await report.getByText('Existing work verified without replaying the business command.', { exact: true }).waitFor()
    expect(consoleTripwire.pageErrors).toEqual([])
  })
})
