/** Authored Session rendering of compact recorded Tool results. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, readPersistedEvents, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot, scrollIntoView } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/tool-details', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/tool-details/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/tool-details/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'tool-details-web-e2e'
const PROMPT = 'Show a goal, a to-do list, and reminders.'
const CURRENT_TOOLS = ['schedule_create', 'schedule_view', 'schedule_edit', 'schedule_list', 'schedule_edit'] as const
const CURRENT_TITLE = 'Weekly release review'

/** A keyless model script; every scheduled-task result comes from the real Host tools. */
class CurrentScheduleAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  taskId: ScheduleId | undefined

  constructor(private readonly createdId: () => Promise<ScheduleId>) { super() }

  override async listModels(provider: string) { return [{ provider, id: 'cards', name: `${provider}/cards` }] }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.length
    this.requests.push(options)
    if (index >= CURRENT_TOOLS.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CURRENT_SCHEDULE_DETAILS_DONE' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (index > 0 && this.taskId === undefined) this.taskId = await this.createdId()
    const args = index === 0
      ? { title: CURRENT_TITLE, prompt: 'Review the release', rrule: 'DTSTART:20990914T010000Z\nRRULE:FREQ=DAILY;COUNT=1', target: 'this_session' }
      : index === 1 ? { id: this.taskId }
        : index === 2 ? { id: this.taskId, action: 'update', active: false }
          : index === 3 ? { limit: 100, offset: 0 }
            : { id: this.taskId, action: 'delete' }
    const name = CURRENT_TOOLS[index]
    if (name === undefined) throw new Error('Current Schedule script omitted a tool')
    const id = ToolCallId(`current-schedule-${index + 1}`), argumentsJson = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

describe.skipIf(MODE === 'record')('web e2e: compact Tool details', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let recordedCalls: { callId: string; name: string }[]

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    recordedCalls = parseSessionLog(fixture).filter(event => event.type === 'tool/call')
      .map(event => ({ callId: event.data.callId, name: event.data.name }))
    expect(recordedCalls).toHaveLength(45)
    expect(new Set(recordedCalls.map(call => call.callId)).size).toBe(recordedCalls.length)
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    const skillRow = page.locator('[data-tool="create_goal"]')
    await expandOwningTurnProcess(page, skillRow)
    await skillRow.waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('expands every recorded tool through its keyed renderer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-tool-details'))
    // `[data-chat-call-id]` scopes the keyed tool cells: the Schedule client's
    // turn-tail create card carries the same `data-tool` marker without being
    // one of the keyed call views this case walks.
    const rows = page.locator('[data-chat-call-id] [data-tool]')
    await expect.poll(() => rows.evaluateAll(elements => elements.map(element => ({
      callId: element.closest('[data-chat-call-id]')?.getAttribute('data-chat-call-id'),
      name: element.getAttribute('data-tool'),
    })))).toEqual(recordedCalls)
    for (const row of await rows.all()) {
      await row.getByRole('button', { expanded: false }).first().click()
      expect(await row.getByRole('listitem').count()).toBeGreaterThan(0)
      expect(await row.locator('[class*="ioCard"]').count()).toBe(0)
      expect(await row.getByRole('button', { name: 'Inspect', exact: true }).count()).toBe(1)
    }
    const changedTodos = page.locator('[data-tool="todo_write"]').nth(1)
    await changedTodos.getByText('1 added · 1 updated · 1 removed', { exact: true }).waitFor()
    for (const summary of await page.locator('[data-tool] details > summary').all()) await summary.click()
    await page.locator('[data-tool="create_goal"]').getByText('Awaiting continuation', { exact: true }).waitFor()
    const schema = page.locator('[data-tool="cordis_inspect_list"] pre').first()
    await expect.poll(() => schema.textContent()).toContain('"properties"')
    const callIds = recordedCalls.map(call => call.callId)
    const snapshots = await Promise.all(callIds.map(id =>
      captureStableAria(page, `[data-chat-call-id="${id}"] [data-tool]`, scaffold.workspaceCwd)))
    const snapshot = snapshots.join('\n')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    await page.setViewportSize({ width: 360, height: 800 })
    const cards = page.locator('[data-chat-call-id] [data-tool="schedule_create"]')
    expect(await cards.count()).toBe(recordedCalls.filter(call => call.name === 'schedule_create').length)
    for (const card of await cards.all()) {
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    const reminders = page.locator('[data-chat-call-id="details-call-6"] [data-tool="schedule_list"]')
    await scrollIntoView(reminders)
    const list = reminders.getByRole('list').first()
    await list.evaluate((element) => {
      const second = element.children[1]!
      element.scrollTop += second.getBoundingClientRect().top - element.getBoundingClientRect().top
    })
    expect(await list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const geometry = await reminders.evaluate((element) => {
      const title = element.querySelector('ul')!.children[1]!.querySelector('[class*="heading"] > span')!.getBoundingClientRect()
      const inspect = element.querySelector('[class*="inspectButton"]')!.getBoundingClientRect()
      return {
        verticalOverlap: Math.min(title.bottom, inspect.bottom) - Math.max(title.top, inspect.top),
        horizontalGap: inspect.left - title.right,
      }
    })
    expect(geometry.verticalOverlap).toBeGreaterThan(0)
    expect(geometry.horizontalGap).toBeGreaterThanOrEqual(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'ui.expected.md'])
  })

})

it.skipIf(MODE === 'record')('renders five current Schedule tool results after actual Host operations', async () => {
  const current = await launchWebScaffold()
  let currentBrowser: Browser | undefined
  let handle: Awaited<ReturnType<typeof current.ctx.agents.create>> | undefined
  try {
    const adapter = new CurrentScheduleAdapter(async () => {
      const task = (await current.ctx.schedule.catalog()).find(entry => entry.title === CURRENT_TITLE)
      if (task === undefined) throw new Error('The real schedule_create did not store the task')
      return task.id
    })
    current.ctx.effect(() => current.ctx.llm.registerAdapter(['tool-details-current'], adapter), 'Current Schedule card adapter')
    handle = await current.ctx.agents.create({
      sessionId: SessionId('tool-details-current-schedule'), meta: { cwd: current.workspaceCwd },
      agentOptions: { provider: 'tool-details-current', model: 'cards' },
      setup: ctx => current.ctx.agentPresets.mount(ctx).then(() => undefined),
    })
    const workspace = await current.ctx.workspaceRegistry.create(current.workspaceCwd)
    await workspace.attachSession(handle.agent.id)
    handle.agent.session.append('session/title', { title: 'Current Schedule tool cards', messageSeqs: [], source: { kind: 'user' } })
    const active = await current.ctx.schedule.create({ title: 'Review the build and open the demo', prompt: 'Review the build',
      timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
      target: { kind: 'session', sessionId: handle.agent.id } }, handle.agent.id)
    const ended = await current.ctx.schedule.create({ title: 'Share the demo link', prompt: 'Share the demo',
      timing: { kind: 'rrule', rrule: 'DTSTART:20990910T010000Z\nRRULE:FREQ=DAILY;COUNT=1' },
      target: { kind: 'session', sessionId: handle.agent.id } }, handle.agent.id)
    const domain = current.ctx.storageDomain.get('schedule')
    if (domain === undefined) throw new Error('The actual Schedule domain is not open')
    const stored = domain.table('tasks').get(ended.id)
    if (typeof stored !== 'object' || stored === null) throw new Error('The list-state fixture was not persisted')
    // This is a stored UI-state fixture; it does not claim that a model ran the ended task.
    await domain.table('tasks').put(ended.id, { ...stored, status: 'ended' })
    const settled = current.whenTurnSettled()
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Create a release review task, view it, pause it, list all tasks, then delete the task you created.' }], source: { kind: 'user' } }))
    expect(await settled).toBe(handle.agent.id)
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(6)
    const events = handle.agent.session.snapshotEvents()
    const expected = CURRENT_TOOLS.map((name, index) => ({ callId: `current-schedule-${index + 1}`, name }))
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.map(event => ({ callId: event.data.callId, name: event.data.name }))).toEqual(expected)
    const results = events.filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data.message.toolCallId)).toEqual(expected.map(call => call.callId))
    expect(results.every(event => !event.data.message.isError)).toBe(true)
    if (adapter.taskId === undefined) throw new Error('No real task identity was returned')
    expect(await current.ctx.schedule.view({ id: adapter.taskId })).toEqual({ id: adapter.taskId, code: 'schedule_not_found' })
    expect(await current.ctx.schedule.catalog()).toMatchObject([{ id: active.id, status: 'active' }, { id: ended.id, status: 'ended' }])
    await expect(current.ctx.sessions.flush(handle.agent.session)).resolves.toBe(true)
    const durable = await readPersistedEvents(current, handle.agent.id)
    expect(durable.filter(event => event.type === 'tool/call' || event.type === 'tool/result'))
      .toEqual(events.filter(event => event.type === 'tool/call' || event.type === 'tool/result'))
    await handle.dispose()
    handle = undefined
    currentBrowser = await chromium.launch()
    const currentPage = await newEnglishPage(currentBrowser), console = watchConsole(currentPage)
    await currentPage.goto(current.authenticatedUrl, { waitUntil: 'load' })
    const group = currentPage.getByRole('treeitem').first()
    await group.waitFor()
    const sessionRow = currentPage.getByRole('treeitem', { name: /Current Schedule tool cards/ })
    await expect.poll(async () => {
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
      return sessionRow.isVisible()
    }, { timeout: 30_000 }).toBe(true)
    await sessionRow.click()
    const first = currentPage.locator('[data-chat-call-id="current-schedule-1"] [data-tool]')
    await expandOwningTurnProcess(currentPage, first)
    const rows = currentPage.locator('[data-chat-call-id] [data-tool]')
    await expect.poll(() => rows.evaluateAll(elements => elements.map(element => ({
      callId: element.closest('[data-chat-call-id]')?.getAttribute('data-chat-call-id'), name: element.getAttribute('data-tool'),
    })))).toEqual(expected)
    for (const row of await rows.all()) {
      await row.getByRole('button', { expanded: false }).first().click()
      expect(await row.getByRole('listitem').count()).toBeGreaterThan(0)
      expect(await row.locator('[class*="ioCard"]').count()).toBe(0)
      expect(await row.getByRole('button', { name: 'Inspect', exact: true }).count()).toBe(1)
    }
    const summaries = [`Create automation task ${CURRENT_TITLE}`, `View automation task ${CURRENT_TITLE}`,
      `Edit automation task ${CURRENT_TITLE}`, 'List automation tasks 3 automation tasks', `Edit automation task ${adapter.taskId}`]
    for (const [index, name] of summaries.entries()) {
      expect(await rows.nth(index).getByRole('button', { name, exact: true, expanded: true }).count()).toBe(1)
    }
    for (const [index, status] of [[1, 'Enabled'], [2, 'Enabled'], [3, 'Paused']] as const) {
      const row = currentPage.locator(`[data-chat-call-id="current-schedule-${index}"] [data-tool]`)
      await row.getByRole('listitem').getByText(CURRENT_TITLE, { exact: true }).waitFor()
      expect(await row.getByRole('term').allTextContents()).toEqual(['Scheduled for', 'Repeat', 'Status'])
      expect((await row.getByRole('definition').allTextContents()).map(text => text.replace(/\s+/g, ' ')))
        .toEqual(['Sep 14, 2099, 09:00:00 AM GMT+8', 'Custom', status])
    }
    const listed = currentPage.locator('[data-chat-call-id="current-schedule-4"] [data-tool]')
    expect(await listed.getByRole('listitem').count()).toBe(3)
    const activeDate = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'short', day: 'numeric' })
      .format(new Date(active.scheduledAt))
    const listItems = [
      [active.title, `${activeDate}, 09:00:00 AM GMT+8`, 'Every day at 09:00 (Asia/Shanghai)', 'Enabled'],
      [CURRENT_TITLE, 'Sep 14, 2099, 09:00:00 AM GMT+8', 'Custom', 'Paused'],
      [ended.title, 'Sep 10, 2099, 09:00:00 AM GMT+8', 'Custom', 'Ended'],
    ] as const
    for (const [index, [title, ...definitions]] of listItems.entries()) {
      const item = listed.getByRole('listitem').nth(index)
      await item.getByText(title, { exact: true }).waitFor()
      expect(await item.getByRole('term').allTextContents()).toEqual(['Scheduled for', 'Repeat', 'Status'])
      expect((await item.getByRole('definition').allTextContents()).map(text => text.replace(/\s+/g, ' '))).toEqual(definitions)
    }
    const deleted = currentPage.locator('[data-chat-call-id="current-schedule-5"] [data-tool]')
    expect(await deleted.getByRole('term').allTextContents()).toEqual(['Status'])
    expect(await deleted.getByRole('definition').allTextContents()).toEqual(['Deleted'])
    await deleted.getByRole('listitem').getByText(adapter.taskId, { exact: true }).waitFor()
    await currentPage.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await currentPage.setViewportSize({ width: 360, height: 800 })
    await currentPage.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor()
    for (const row of await rows.all()) {
      await scrollIntoView(row)
      const geometry = await row.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, viewport: innerWidth,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
      })
      expect(geometry.left).toBeGreaterThanOrEqual(0)
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport)
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
    }
    if (process.env.DSH_UI_EVIDENCE_DIR !== undefined) {
      await mkdir(process.env.DSH_UI_EVIDENCE_DIR, { recursive: true })
      await currentPage.screenshot({ path: join(process.env.DSH_UI_EVIDENCE_DIR, 'current-schedule-cards-narrow.png'), fullPage: true })
      for (const [index, row] of (await rows.all()).entries()) {
        await row.screenshot({ path: join(process.env.DSH_UI_EVIDENCE_DIR, `current-schedule-card-${index + 1}-narrow.png`) })
      }
      for (const [index, item] of (await listed.getByRole('listitem').all()).entries()) {
        await item.screenshot({ path: join(process.env.DSH_UI_EVIDENCE_DIR, `current-schedule-list-item-${index + 1}-narrow.png`) })
      }
    }
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally {
    try { await currentBrowser?.close() } finally {
      try { await handle?.dispose() } finally { await current.close() }
    }
  }
}, 60_000)
