/** Account catalog, real provider parser, tool loop, and browser UI over local SSE. */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MuseModels } from '../../../packages/host/muse-account/src/models.ts'
import { writeMuseSession } from '../../../packages/host/muse-account/src/session.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage } from './support.ts'

const CASES = [
  { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 1_050_000,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'], labels: ['Low', 'Medium', 'High', 'Xhigh', 'Max'] },
  { model: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', contextWindow: 1_048_576,
    levels: ['low', 'medium', 'high'], labels: ['Low', 'Medium', 'High'] },
]

it.each(CASES)('selects $model efforts and renders provider reasoning through a tool continuation', async (target) => {
  const firstSummary = 'LOCAL_PROVIDER_SUMMARY: checking the requested value.'
  const secondSummary = 'LOCAL_PROVIDER_SUMMARY: the tool returned the expected value.'
  const summaryDelivered = Promise.withResolvers<undefined>()
  const releaseSummary = Promise.withResolvers<undefined>()
  const toolEntered = Promise.withResolvers<undefined>()
  const releaseTool = Promise.withResolvers<undefined>()
  const requests: Record<string, unknown>[] = []
  const failures: unknown[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      void (async () => {
        const parsed: unknown = JSON.parse(body)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid local request')
        requests.push(parsed as Record<string, unknown>)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const event = (data: unknown) => { res.write(`data: ${JSON.stringify(data)}\n\n`) }
        if (requests.length === 1) {
          event({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: firstSummary }, finish_reason: null }] })
          summaryDelivered.resolve(undefined)
          await releaseSummary.promise
          event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'local-tool-1', type: 'function',
            function: { name: 'yunying_probe', arguments: '{}' } }] }, finish_reason: null }] })
          event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 475_010, completion_tokens: 25, total_tokens: 475_035 } })
        } else if (requests.length === 2) {
          event({ choices: [{ index: 0, delta: { reasoning_content: secondSummary }, finish_reason: null }] })
          event({ choices: [{ index: 0, delta: { content: 'LOCAL_TOOL_COMPLETE: 17' }, finish_reason: null }] })
          event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 222, completion_tokens: 30, total_tokens: 252 } })
        } else throw new Error('Unexpected local model call')
        event({ choices: [], usage: { cost_currency: 'CNY', cost_rmb: 0.01, balance_rmb: 1 } })
        res.end('data: [DONE]\n\n')
      })().catch((error: unknown) => { failures.push(error); res.destroy() })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing local address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const scaffold = await launchWebScaffold()
  let account: MuseModels | undefined
  const browser = await chromium.launch()
  try {
    const sessionFile = join(scaffold.harnessHome, 'local-account', 'session.json')
    await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=local-fixture', username: 'local-fixture' })
    const providers = [{ id: 'yunying', name: '云映', models: CASES.map(model => ({
      id: model.model, name: model.name, contextWindow: model.contextWindow, maxTokens: 1024,
      input: ['text'], reasoningEfforts: Object.fromEntries(model.levels.map(level => [level, level])),
    })) }]
    account = new MuseModels(scaffold.ctx, { baseUrl, sessionFile, requestTimeoutMs: 10_000,
      fetcher: async () => Response.json({ providers, transport: 'relay' }) })
    await account.refresh()
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'muse-cloud-yunying', model: target.model })
    scaffold.ctx.effect(() => scaffold.ctx.tools.register(defineContentToolFixture({
      name: 'yunying_probe', description: 'Return a fixed local test value.', parameters: {},
      async execute() {
        toolEntered.resolve(undefined)
        await releaseTool.promise
        return [{ type: 'text', text: 'LOCAL_TOOL_RESULT: 17' }]
      },
    })))
    const events: SessionEvent[] = []
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    const modelPane = page.getByRole('menuitem', { name: /^Model/ })
    if (await modelPane.count() > 0) await modelPane.click()
    await page.getByRole('menuitemradio', { name: target.name, exact: true }).click()
    for (const [index, label] of target.labels.entries()) {
      await trigger.click()
      await page.getByRole('menuitem', { name: /^Effort/ }).click()
      await expect.poll(() => page.getByRole('menuitemradio').allTextContents()).toEqual(['Default', ...target.labels])
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
      await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBe(target.levels[index])
    }
    expect(requests).toHaveLength(0)
    const settled = scaffold.whenTurnSettled(30_000)
    const input = page.locator('[data-composer-input]').first()
    await input.fill('Use yunying_probe once and report its result.')
    await input.press('Enter')
    await summaryDelivered.promise
    const reasoning = page.locator('[data-variant="think"]').first()
    await expandOwningTurnProcess(page, reasoning)
    await reasoning.waitFor()
    const toggle = reasoning.getByRole('button')
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    await reasoning.getByText(firstSummary, { exact: true }).waitFor()
    releaseSummary.resolve(undefined)
    await toolEntered.promise
    await page.getByText('yunying_probe', { exact: false }).first().waitFor()
    releaseTool.resolve(undefined)
    await settled
    await page.getByText('LOCAL_TOOL_COMPLETE: 17', { exact: true }).waitFor()
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request).toMatchObject({ model: target.model, reasoning_effort: target.levels.at(-1) })
      expect(request).toHaveProperty(target.model === 'gpt-6.1-sol' ? 'max_completion_tokens' : 'max_tokens', 1024)
    }
    if (target.model === 'gemini-3.1-pro') {
      expect(requests[0]).toHaveProperty('extra_body.google.thinking_config.include_thoughts', true)
    }
    expect(JSON.stringify(requests[1]?.messages)).toContain('LOCAL_TOOL_RESULT: 17')
    expect(JSON.stringify(requests[1]?.messages)).toContain(firstSummary)
    const messages = events.filter(event => event.type === 'assistant/message')
    expect(messages.map(event => event.data.usage?.inputTokens)).toEqual([475_010, 222])
    expect(JSON.stringify(events)).toContain(secondSummary)
    expect(failures).toEqual([])
    expect(console.pageErrors).toEqual([])
  } finally {
    releaseSummary.resolve(undefined)
    releaseTool.resolve(undefined)
    await browser.close()
    try { await account?.dispose(); await scaffold.close() } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
    }
  }
}, 120_000)
