/** Opt-in acceptance of real packaged card plugins in the native Muse Main preset. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-coordinator'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { launchWebScaffold, watchConsole, type WebConsoleTripwire, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT } from './support.ts'

const deepView = process.env.MUSE_MAIN_DEEP_VIEW_PACKAGE
const visualize = process.env.MUSE_MAIN_VISUALIZE_PACKAGE
const enabled = deepView !== undefined && visualize !== undefined
const resident = ['show_view', 'visualize', 'coordinator_show_report', 'coordinator_display_skill']
const frameSelector = 'iframe[title="Main budget card"]:visible'
const fragment = '<section><h2>Main budget draft</h2><button onclick="dshViz.prompt(\'Continue with this reviewed plan\')">Bring plan into chat</button></section>'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

describe.skipIf(!enabled)('packaged Main display tools (set MUSE_MAIN_DEEP_VIEW_PACKAGE and MUSE_MAIN_VISUALIZE_PACKAGE)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let main: Agent
  let other: Agent
  let adapter: MockAdapter
  let consoleTripwire: WebConsoleTripwire
  let screenshots: string
  let privateRoot: string
  const responses: ConstructorParameters<typeof MockAdapter>[0] = []

  const composer = () => page.locator('[data-composer-input][contenteditable="true"]').last()
  const frame = () => page.locator(frameSelector).last().contentFrame()

  async function select(agent: Agent): Promise<void> {
    if (agent === main) await page.getByRole('button', { name: 'Muse Main Session', exact: true }).click()
    else await page.locator(`[data-row-key="session:${agent.id}"]`).click()
    await vi.waitFor(async () => {
      expect(await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')).toBe(agent.id)
    })
  }

  async function run(agent: Agent, text: string, script: ConstructorParameters<typeof MockAdapter>[0]): Promise<void> {
    responses.push(...script)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await agent.whenIdle()
  }

  async function post(body: Record<string, unknown>): Promise<{ ok: boolean; value: unknown; code?: string }> {
    const raw: unknown = await page.evaluate(async (payload) => {
      const response = await fetch('api/deep-view', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      })
      const value: unknown = await response.json()
      return value
    }, body)
    if (!record(raw) || typeof raw.ok !== 'boolean') throw new Error('Deep View returned an invalid response')
    const code = record(raw.error) && typeof raw.error.code === 'string' ? raw.error.code : undefined
    return { ok: raw.ok, value: raw.value, ...(code === undefined ? {} : { code }) }
  }

  async function pending(agent: Agent): Promise<Record<string, unknown>> {
    let value: Record<string, unknown> | undefined
    await expect.poll(async () => {
      const response = await post({ op: 'pending', sessionId: agent.id })
      if (response.ok && record(response.value)) value = response.value
      return typeof value?.id === 'string'
    }).toBe(true)
    if (value === undefined) throw new Error('Expected an active packaged card')
    return value
  }

  const answers = (agent: Agent) => agent.session.snapshotEvents().filter((event) => {
    if (event.type !== 'user/message') return false
    // The packaged JavaScript plugin contributes a kind outside the workspace's static source map.
    const kind: string = event.data.source.kind
    return kind === 'deep-view-reply'
  })

  beforeAll(async () => {
    if (deepView === undefined || visualize === undefined) throw new Error('Both reviewed unpacked package paths are required')
    privateRoot = await mkdtemp(join(tmpdir(), 'muse-main-display-profile-'))
    const harnessHome = join(privateRoot, 'home')
    const privateOverlay = join(privateRoot, 'cards.overlay.yml')
    await writeFile(privateOverlay, JSON.stringify([{ id: 'deep-view', config: { home: join(privateRoot, 'deep-view') } }]))
    scaffold = await launchWebScaffold({ firstUse: true, harnessHome, profile: { hmr: false, packages: [
      { dir: deepView, enabled: true }, { dir: visualize, enabled: true },
      { dir: fileURLToPath(new URL('../../../packages/session/session-coordinator', import.meta.url)) },
      { dir: fileURLToPath(new URL('../../../packages/client/ui-session-coordinator', import.meta.url)) },
    ] }, extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./muse-session-coordinator.overlay.yml', import.meta.url)),
      privateOverlay,
    ] })
    adapter = new MockAdapter(responses)
    vi.spyOn(adapter, 'listModels').mockResolvedValue([{ provider: 'main-display-fixture', id: 'mock', name: 'Main display fixture' }])
    scaffold.ctx.llm.registerAdapter(['main-display-fixture'], adapter)
    await scaffold.ctx.sessionController.modelCatalog()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoleTripwire = watchConsole(page)
    await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
    const artifactRoot = join(REPO_ROOT, '.artifacts', 'muse-main-display-cards')
    await mkdir(artifactRoot, { recursive: true })
    screenshots = await mkdtemp(join(artifactRoot, 'acceptance-'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await vi.waitFor(() => {
      expect(scaffold.ctx.agents.list().some(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')).toBe(true)
    }, { timeout: 15000 })
    const found = scaffold.ctx.agents.list().find(agent => scaffold.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')
    if (found === undefined) throw new Error('Native Main Session is unavailable')
    main = found
    main.model.select({ provider: 'main-display-fixture', model: 'mock' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await vi.waitFor(async () => {
      const id = await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')
      expect(id).not.toBeNull()
      expect(id).not.toBe(main.id)
    }, { timeout: 15000 })
    const otherId = await page.locator('[data-conversation-content]').getAttribute('data-conversation-session')
    if (otherId === null || otherId === main.id) throw new Error('Expected an independent ordinary Session')
    const ordinary = await scaffold.ctx.sessionController.resolveAgent(SessionId(otherId))
    if ('error' in ordinary) throw ordinary.error
    other = ordinary.agent
    other.model.select({ provider: 'main-display-fixture', model: 'mock' })
    await run(other, 'Keep this display conversation separate from Main.', [textResponse('Independent display Session is ready.')])
    await scaffold.ctx.sessionController.rename({ sessionId: other.id, title: 'Independent display Session' })
    await select(main)
    for (const name of ['bash', 'skill']) {
      const denied = await executeToolFixture(scaffold.ctx, { agent: main, name,
        arguments: name === 'skill' ? { name: 'visualize' } : { command: 'echo forbidden' },
        callId: ToolCallId(`main-${name}-denied`), signal: new AbortController().signal })
      expect(denied.isError).toBe(true)
    }
    await run(main, 'Main display entry is ready.', [textResponse('Main display entry is ready.')])
    expect(scaffold.ctx.agents.get(main.id)).toBe(main)
    expect('roots' in scaffold.ctx.agents).toBe(false)
  }, 120000)

  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { if (privateRoot !== undefined) await rm(privateRoot, { recursive: true, force: true }) }
    }
    if (screenshots !== undefined) {
      await writeFile(join(screenshots, 'console.json'), JSON.stringify(consoleTripwire, null, 2) + '\n')
    }
  })

  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail' || page === undefined || screenshots === undefined) return
    await page.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true, animations: 'disabled' })
    await writeFile(join(screenshots, 'failure.aria.txt'), await page.locator('body').ariaSnapshot())
  })

  it('loads the packaged display Skill and keeps visualization prompts inside the existing Main draft', async () => {
    await run(main, 'Show a draft card for this plan.', [
      (options) => {
        expect(options.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(resident))
        for (const forbidden of ['bash', 'skill']) expect(options.tools?.map(tool => tool.name)).not.toContain(forbidden)
        return toolCallResponse('main-display-skill', 'coordinator_display_skill', {})
      },
      (options) => {
        expect(options.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(resident))
        const instructions = options.messages.findLast(message => message.role === 'tool' && message.toolCallId === ToolCallId('main-display-skill'))
        expect(JSON.stringify(instructions?.content)).toContain('# Visualize')
        expect(JSON.stringify(instructions?.content)).toContain('dshViz')
        return toolCallResponse('main-visualize', 'visualize', { title: 'Main budget card', fragment, mode: 'inline' })
      },
      textResponse('The plan card is ready.'),
    ])
    await frame().getByRole('heading', { name: 'Main budget draft', exact: true }).waitFor()
    expect(await page.locator(frameSelector).last().getAttribute('sandbox')).toBe('allow-scripts')
    const requests = adapter.requests.length
    const messages = main.session.snapshotEvents().filter(event => event.type === 'user/message').length
    await frame().getByRole('button', { name: 'Bring plan into chat', exact: true }).click()
    await expect.poll(() => composer().innerText()).toBe('Continue with this reviewed plan')
    expect(adapter.requests).toHaveLength(requests)
    expect(main.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(messages)
    await composer().fill('Keep the user’s unfinished Main draft')
    await frame().getByRole('button', { name: 'Bring plan into chat', exact: true }).click()
    await expect.poll(() => composer().innerText()).toBe('Keep the user’s unfinished Main draft')
    await select(other)
    await composer().fill('Independent Session draft')
    await select(main)
    await expect.poll(() => composer().innerText()).toBe('Keep the user’s unfinished Main draft')
    await page.reload({ waitUntil: 'load' })
    await frame().getByRole('heading', { name: 'Main budget draft', exact: true }).waitFor()
    await expect.poll(() => composer().innerText()).toBe('Keep the user’s unfinished Main draft')
    await select(other)
    await expect.poll(() => composer().innerText()).toBe('Independent Session draft')
    await select(main)
    await composer().fill('')
    expect(await page.locator('[data-muse-coordination-cards], [data-muse-task-row-status]').count()).toBe(0)
    expect(consoleTripwire.pageErrors).toEqual([])
    await page.screenshot({ path: join(screenshots, 'main-visualize-light.png'), fullPage: true, animations: 'disabled' })
  }, 90000)

  it('answers a packaged choice and form in the original Main exactly once', async () => {
    await select(main)
    await run(main, 'Choose the next production step.', [toolCallResponse('main-options', 'show_view', {
      title: 'Main production choice', await_reply: true,
      view: { type: 'options', id: 'production-lane', options: [{ label: 'Review first' }, { label: 'Prepare assets' }] },
    })])
    const record = await pending(main)
    const choice = page.getByRole('group', { name: 'Main production choice', exact: true }).last()
    await choice.getByRole('button', { name: 'Review first', exact: true }).waitFor({ state: 'visible' })
    expect(await choice.getByRole('button', { name: 'Review first', exact: true }).isEnabled()).toBe(true)
    const otherAnswers = answers(other).length
    responses.push(textResponse('Main received the production choice.'))
    await choice.getByRole('button', { name: 'Review first', exact: true }).click()
    await page.getByText('Main received the production choice.', { exact: true }).waitFor()
    await main.whenIdle()
    expect(answers(main)).toHaveLength(1)
    expect(answers(other)).toHaveLength(otherAnswers)
    const requests = adapter.requests.length
    const same = await post({ op: 'reply', sessionId: main.id, viewId: record.id,
      action: 'production-lane', values: { selected: ['Review first'] } })
    expect(same.ok).toBe(true)
    const conflicting = await post({ op: 'reply', sessionId: main.id, viewId: record.id,
      action: 'production-lane', values: { selected: ['Prepare assets'] } })
    expect(conflicting).toMatchObject({ ok: false, code: 'deep-view/answer-conflict' })
    await main.whenIdle()
    expect(adapter.requests).toHaveLength(requests)
    expect(answers(main)).toHaveLength(1)
    await run(main, 'Collect the brief details.', [toolCallResponse('main-form', 'show_view', {
      title: 'Main production brief', await_reply: true,
      view: { type: 'form', id: 'brief', fields: [{ id: 'episode', label: 'Episode' }], submitLabel: 'Send brief', cancelLabel: 'Cancel brief' },
    })])
    await pending(main)
    const form = page.getByRole('group', { name: 'Main production brief', exact: true }).last()
    await form.getByRole('textbox', { name: 'Episode', exact: true }).fill('Episode 2')
    responses.push(textResponse('Main received Episode 2.'))
    await form.getByRole('button', { name: 'Send brief', exact: true }).click()
    await page.getByText('Main received Episode 2.', { exact: true }).waitFor()
    expect(answers(main)).toHaveLength(2)
    expect(JSON.stringify(answers(main))).toContain('Episode 2')
    expect(answers(other)).toHaveLength(otherAnswers)
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('group', { name: 'Main production brief', exact: true }).last().waitFor()
    expect(await page.getByRole('group', { name: 'Main production choice', exact: true }).count()).toBeGreaterThan(0)
    expect(answers(main)).toHaveLength(2)
    expect(consoleTripwire.pageErrors).toEqual([])
    await page.screenshot({ path: join(screenshots, 'main-answered-cards.png'), fullPage: true, animations: 'disabled' })
  }, 90000)

  it('cancels and revokes pending cards without delivering answers to another Session', async () => {
    await run(main, 'Ask for optional notes.', [toolCallResponse('main-cancel', 'show_view', {
      title: 'Optional Main notes', await_reply: true,
      view: { type: 'form', id: 'optional-notes', fields: [{ id: 'notes', label: 'Notes' }], cancelLabel: 'Skip notes' },
    })])
    await pending(main)
    responses.push(textResponse('Main received the cancellation.'))
    await page.getByRole('group', { name: 'Optional Main notes', exact: true }).last().getByRole('button', { name: 'Skip notes' }).click()
    await page.getByText('Main received the cancellation.', { exact: true }).waitFor()
    expect(JSON.stringify(answers(main).at(-1))).toContain('canceled')
    const mainAnswers = answers(main).length
    await run(other, 'Keep this separate choice open.', [toolCallResponse('other-options', 'show_view', {
      title: 'Independent choice', await_reply: true, view: { type: 'options', id: 'independent', options: [{ label: 'Other only' }] },
    })])
    const otherPending = await pending(other)
    await run(main, 'Ask a question that will be superseded.', [toolCallResponse('main-stale', 'show_view', {
      title: 'Superseded Main choice', await_reply: true, view: { type: 'options', id: 'stale', options: [{ label: 'Old decision' }] },
    })])
    const stale = await pending(main)
    await page.getByRole('group', { name: 'Superseded Main choice', exact: true }).last().waitFor()
    responses.push(textResponse('The newer Main request replaced that question.'))
    await composer().fill('Use this newer requirement instead.')
    await composer().press('Enter')
    await page.getByText('The newer Main request replaced that question.', { exact: true }).waitFor()
    await expect.poll(async () => (await post({ op: 'pending', sessionId: main.id })).value).toBeNull()
    expect(await post({ op: 'reply', sessionId: main.id, viewId: stale.id, action: 'stale', values: { selected: ['Old decision'] } }))
      .toMatchObject({ ok: false, code: 'deep-view/stale' })
    expect(answers(main)).toHaveLength(mainAnswers)
    expect((await pending(other)).id).toBe(otherPending.id)
    await select(other)
    await page.getByRole('group', { name: 'Independent choice', exact: true }).last().waitFor()
    const beforeDismiss = adapter.requests.length
    await page.getByRole('group', { name: 'Independent choice', exact: true }).last().getByRole('button', { name: 'Dismiss view', exact: true }).click()
    await expect.poll(async () => (await post({ op: 'pending', sessionId: other.id })).value).toBeNull()
    expect(answers(other)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(beforeDismiss)
    await select(main)
    await page.reload({ waitUntil: 'load' })
    expect(await page.getByRole('group', { name: 'Superseded Main choice', exact: true }).count()).toBe(0)
    expect(await page.locator('[data-muse-coordination-cards], [data-muse-task-row-status]').count()).toBe(0)
    expect(consoleTripwire.pageErrors).toEqual([])
    expect(consoleTripwire.warnings).toEqual([])
    expect(responses).toHaveLength(0)
    const mainRequests = adapter.requests.filter(options => options.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === 'Main display entry is ready.')))
    expect(mainRequests.length).toBeGreaterThan(0)
    for (const options of mainRequests) {
      expect(options.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(resident))
      for (const forbidden of ['bash', 'skill']) expect(options.tools?.map(tool => tool.name)).not.toContain(forbidden)
    }
    await writeFile(join(screenshots, 'acceptance.json'), JSON.stringify({
      mainSession: main.id, isolatedSession: other.id, nativeRegistry: true, realPackagedPlugins: true,
      residentSchemas: resident, mainRequestsChecked: mainRequests.length, displaySkillLoaded: true, promptDraftOnly: true,
      userDraftRetained: true,
      answeredInOriginalMain: true, duplicateIdempotent: true, cancellation: true, newerMessageRevocation: true,
      pendingSessionIsolation: true, reloadReplaysCards: true,
    }, null, 2) + '\n')
  }, 90000)
})
