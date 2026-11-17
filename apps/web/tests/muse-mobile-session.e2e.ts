/** Mobile task, question and file delivery through ordinary native Sessions. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, webkit, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

const PROVIDER = 'muse-mobile-session-fixture'
const MODEL = 'mobile-reply'
const EXPECTED = join(REPO_ROOT, 'apps/web/tests/expected/muse-mobile-session')
const MODE = webSnapshotMode()
const VIEWPORTS = [{ engine: 'webkit', width: 390, height: 844 }, { engine: 'chromium', width: 412, height: 915 }]

/** Provider-neutral chunks keep every model step in the native Session log. */
function textChunks(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

/** Emit a native tool invocation through the model stream. */
function callChunks(marker: string, name: string, args: object, index = 0): StreamChunk[] {
  const id = ToolCallId(`${marker}-${name}`)
  const argumentsText = JSON.stringify(args)
  return [{ type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsText },
    { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

/** Only the model seam is scripted; the Agent loop, tool execution, cards and persistence are shipped code. */
class MobileSessionAdapter extends LlmAdapter {
  readonly stages = new Map<string, number>()
  readonly holds = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>()
  readonly requests: { marker: string; stage: number }[] = []

  constructor(private readonly workspaceRoot: string) { super() }

  private workspaceOf(marker: string): string {
    return join(this.workspaceRoot, `mobile-${marker.slice('MOBILE_SESSION_'.length)}`)
  }

  override async listModels(provider: string) { return [{ provider, id: MODEL, name: 'Mobile fixture' }] }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: 'Mobile fixture', context: { contextWindow: 128_000 } }
  }

  release(marker: string): void { this.holds.get(marker)?.resolve(undefined) }
  releaseAll(): void { for (const hold of this.holds.values()) hold.resolve(undefined) }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.system?.startsWith('REVIEW_POLICY\n')) {
      yield* textChunks(JSON.stringify({ risk: 'low', decision: 'allow', reason: 'Creates the requested fixture result in its workspace.' }))
      return
    }
    const markers = options.messages.flatMap(message => message.role === 'user'
      ? message.content.flatMap(block => block.type === 'text' ? [...block.text.matchAll(/MOBILE_SESSION_(390|412)/gu)].map(match => match[0]) : []) : [])
    const marker = markers.at(-1)
    if (marker === undefined) { yield* textChunks('移动端测试会话已就绪'); return }
    const stage = this.stages.get(marker) ?? 0
    this.requests.push({ marker, stage })
    this.stages.set(marker, stage + 1)
    if (stage === 0) {
      const hold = Promise.withResolvers<undefined>(); this.holds.set(marker, hold)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `正在执行 ${marker}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `正在执行 ${marker}` } }
      await hold.promise
      yield* callChunks(marker, 'write', {
        file_path: join(this.workspaceOf(marker), `${marker}.html`),
        content: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>手机验收结果</title><h1>${marker} 执行完成</h1><p>这份结果由电脑上的原生文件工具创建。</p></html>`,
      }, 1)
      return
    }
    if (stage === 1) {
      const text = `已生成结果文件：\`${marker}.html\`。请确认是否继续查看。`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield* callChunks(marker, 'ask_user_question', {
        questions: [{ id: `continue-${marker}`, question: `${marker} 结果已生成，继续查看吗？`, header: '确认结果',
          options: [{ label: '继续查看结果' }, { label: '暂时不用' }] }],
      }, 1)
      return
    }
    if (stage === 2) {
      yield* callChunks(marker, 'present', { files: [{ path: join(this.workspaceOf(marker), `${marker}.html`), description: '手机确认后的本地 HTML 结果' }] })
      return
    }
    if (stage === 3) {
      yield* textChunks(`已收到手机确认，${marker} 任务完成。结果文件：\`${marker}.html\``)
      return
    }
    throw new Error(`Unexpected repeated mobile model step: ${marker}/${stage}`)
  }
}

/** Capture stable native facts rather than generated UUIDs, wall clocks or progress timing. */
function nativeFacts(events: readonly SessionEvent[], marker: string) {
  const isTaskMessage = (event: SessionEvent): boolean => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text.includes(marker))
  const start = events.findIndex(isTaskMessage)
  const task = start < 0 ? [] : events.slice(start)
  return {
    originalMessages: task.filter(isTaskMessage).length,
    questionAnswers: task.filter(event => event.type === 'tool/result'
      && JSON.stringify(event.data.message.content).includes('继续查看结果')).length,
    tools: task.flatMap(event => event.type === 'tool/call' ? [event.data.name] : []),
    toolErrors: task.flatMap(event => event.type === 'tool/result' ? [event.data.message.isError] : []),
    turns: task.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : []),
    finalReply: task.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('已收到手机确认'))),
  }
}

describe.skipIf(MODE === 'record')('Muse mobile native Session round trip', () => {
  let scaffold: WebScaffold | undefined
  let chromiumBrowser: Browser | undefined
  let webkitBrowser: Browser | undefined
  let adapter: MobileSessionAdapter

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ firstUse: true })
    adapter = new MobileSessionAdapter(scaffold.workspaceCwd)
    scaffold.ctx.effect(() => scaffold!.ctx.llm.registerAdapter([PROVIDER], adapter), 'mobile native Session fixture')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    chromiumBrowser = await chromium.launch()
    webkitBrowser = await webkit.launch()
  })

  afterAll(async () => {
    adapter?.releaseAll()
    await Promise.all([chromiumBrowser?.close(), webkitBrowser?.close()])
    await scaffold?.close()
  })

  it.each(VIEWPORTS)('$engine runs and confirms one native task at $width × $height without resending after reconnection', async ({ engine, ...viewport }) => {
    const marker = `MOBILE_SESSION_${viewport.width}`
    const workspacePath = join(scaffold!.workspaceCwd, `mobile-${viewport.width}`)
    await mkdir(workspacePath, { recursive: true })
    const workspace = await scaffold!.ctx.workspaceRegistry.create(workspacePath)
    const sessionId = SessionId(randomUUID())
    await scaffold!.ctx.sessionController.create({ sessionId, workspaceId: workspace.id })
    const agent = scaffold!.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Mobile Session was not registered as an ordinary Agent')
    const browser = engine === 'webkit' ? webkitBrowser : chromiumBrowser
    const context = await browser!.newContext({ viewport, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true })
    const page = await context.newPage()
    try {
      await page.addInitScript((id) => {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
      }, sessionId)
      const url = new URL(scaffold!.authenticatedUrl)
      url.searchParams.set('mobile', '1')
      await page.goto(url.href, { waitUntil: 'load' })
      const conversation = page.locator(`[data-conversation-session="${sessionId}"]`)
      await conversation.waitFor({ state: 'visible', timeout: 30_000 })
      const composer = conversation.locator('[data-composer-input][contenteditable="true"]')
      await composer.waitFor({ state: 'visible', timeout: 30_000 })
      await composer.click()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type(`请生成一份本地 HTML 结果，向我确认后再交付。${marker}`, { delay: 20 })
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await page.getByText(`正在执行 ${marker}`, { exact: true }).waitFor({ timeout: 30_000 })
      await expect.poll(() => adapter.holds.has(marker)).toBe(true)
      expect(agent?.status).toBe('running')
      await context.setOffline(true)
      expect(agent?.status).toBe('running')
      await context.setOffline(false)
      await page.reload({ waitUntil: 'load' })
      await page.locator(`[data-conversation-session="${sessionId}"] [data-composer-input][contenteditable="true"]`)
        .waitFor({ timeout: 30_000 })
      expect(agent?.status).toBe('running')
      expect(nativeFacts(agent.session.snapshotEvents(), marker).originalMessages).toBe(1)
      adapter.release(marker)
      const question = page.locator('[data-question-key]')
      await question.waitFor({ timeout: 30_000 })
      await question.getByRole('radio', { name: '继续查看结果', exact: true }).click()
      await question.getByRole('button', { name: '提交', exact: true }).click()
      await page.getByText(`已收到手机确认，${marker} 任务完成。结果文件：`, { exact: false }).waitFor({ timeout: 30_000 })
      await expect.poll(() => agent?.status).toBe('idle')
      const html = await readFile(join(workspacePath, `${marker}.html`), 'utf8')
      expect(html).toContain(`${marker} 执行完成`)
      const resultButton = page.getByRole('button', { name: new RegExp(`在侧边栏预览 .*${marker}\\.html`, 'u') })
      await resultButton.click()
      await page.frameLocator('iframe').getByRole('heading', { name: `${marker} 执行完成` }).waitFor({ timeout: 15_000 })
      const facts = {
        viewport,
        ...nativeFacts(agent.session.snapshotEvents(), marker),
        requestStages: adapter.requests.filter(request => request.marker === marker).map(request => request.stage),
        previewHeading: await page.frameLocator('iframe').getByRole('heading').textContent(),
      }
      const expectedPath = join(EXPECTED, `${viewport.width}.expected.json`)
      if (MODE === 'refresh') { await mkdir(EXPECTED, { recursive: true }); await writeFile(expectedPath, JSON.stringify(facts, null, 2) + '\n') }
      else expect(facts).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
      expect(facts.originalMessages).toBe(1)
      expect(facts.questionAnswers).toBe(1)
      expect(facts.tools).toEqual(['write', 'ask_user_question', 'present'])
      expect(facts.toolErrors).toEqual([false, false, false])
      expect(facts.turns).toEqual(['completed'])
      expect(facts.requestStages).toEqual([0, 1, 2, 3])
    } catch (error) {
      await mkdir(join(REPO_ROOT, '.playwright-mcp/mobile-native'), { recursive: true })
      await page.screenshot({ path: join(REPO_ROOT, '.playwright-mcp/mobile-native', `${viewport.width}-failure.png`) })
      await writeFile(join(REPO_ROOT, '.playwright-mcp/mobile-native', `${viewport.width}-failure.txt`), await page.locator('body').innerText())
      throw error
    } finally {
      adapter.release(marker)
      await context.close()
      await expect.poll(() => scaffold!.ctx.agents.list().every(agent => agent.status === 'idle'), { timeout: 15_000 }).toBe(true)
    }
  })
})
