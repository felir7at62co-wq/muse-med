/** Mobile task, question and file delivery through the shipped Web profile and real Bot Sessions. */
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium, webkit, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE, writeComposerDraft } from './support.ts'

const PROVIDER = 'muse-mobile-session-fixture'
const MODEL = 'mobile-reply'
const EXPECTED = join(REPO_ROOT, 'apps/web/tests/expected/muse-mobile-session')
const SOURCE = join(REPO_ROOT, 'third_party/plugins/ds-bot')
const MODE = webSnapshotMode()
const VIEWPORTS = [{ engine: 'webkit', width: 390, height: 844 }, { engine: 'chromium', width: 412, height: 915 }]

interface AccountFixture {
  base: string
  alice: string
  connect(
    cookie: string, host: string, cookieHeader: string, id: string,
    metadata: { deviceName: string; platform: string },
  ): Promise<{ deviceId: string }>
}
interface FixtureModule {
  fixture(
    owner: { after(cleanup: () => Promise<void>): void }, options: Record<string, never>, browserOrigin: boolean,
  ): Promise<AccountFixture>
}

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

  constructor(private readonly workspace: string) { super() }

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
    if (marker === undefined) { yield* textChunks('手机测试 Bot 已就绪'); return }
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
        file_path: join(this.workspace, `${marker}.html`),
        content: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>手机验收结果</title><h1>${marker} 执行完成</h1><p>这份结果由电脑上的原生文件工具创建。</p></html>`,
      }, 1)
      return
    }
    if (stage === 1) {
      const text = `已生成结果文件：\`${marker}.html\`。请确认是否继续查看。`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield* callChunks(marker, 'ask_user', {
        question: `${marker} 结果已生成，继续查看吗？`,
        options: [{ label: '继续查看结果' }, { label: '暂时不用' }],
      }, 1)
      return
    }
    if (stage === 2) {
      yield* callChunks(marker, 'present', { files: [{ path: join(this.workspace, `${marker}.html`), description: '手机确认后的本地 HTML 结果' }] })
      return
    }
    if (stage === 3) {
      yield* textChunks(`已收到手机确认，${marker} 任务完成。结果文件：\`${marker}.html\``)
      return
    }
    throw new Error(`Unexpected repeated mobile model step: ${marker}/${stage}`)
  }
}

/** Build the current Bot client in an owned profile package without rewriting tracked generated files. */
async function botPackage(root: string, workspace: string): Promise<string> {
  const target = join(root, 'ds-bot')
  await cp(SOURCE, target, { recursive: true, filter: path => !/(?:^|[/\\])(?:node_modules|test|dev|\.git)(?:[/\\]|$)/u.test(path) })
  const modules = join(target, 'node_modules')
  await mkdir(modules)
  await symlink(join(REPO_ROOT, 'node_modules/@deepseek-ai'), join(modules, '@deepseek-ai'), 'junction')
  const deepView = join(REPO_ROOT, 'third_party/plugins/toolchain/node_modules/deep-view')
  try { await readFile(join(deepView, 'package.json')) } catch {
    throw new Error('Mobile Session e2e requires the pinned community toolchain; run pnpm --dir third_party/plugins/toolchain install --frozen-lockfile --ignore-scripts')
  }
  await symlink(deepView, join(modules, 'deep-view'), 'junction')
  const result = await build({
    absWorkingDir: SOURCE, entryPoints: ['src/client/index.js'], bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
    nodePaths: [join(REPO_ROOT, 'third_party/plugins/toolchain/node_modules'), join(REPO_ROOT, 'node_modules')],
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], treeShaking: false, charset: 'utf8', write: false, logLevel: 'silent',
  })
  if (result.warnings.length) throw new Error(result.warnings.map(warning => warning.text).join('\n'))
  await writeFile(join(target, 'client.js'), `window.__ModuleLoader__.load({id:'ds-bot',factory:(require)=>{const module={exports:{}};\n${result.outputFiles[0]!.text}\nreturn Object.defineProperty({...module.exports},Symbol.toStringTag,{value:'Module'});}});\n`)
  await writeFile(join(target, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'muse-bot', name: 'ds-bot', config: {
    home: join(root, 'team'), workspace, agentPreset: 'standard', mainAgentPreset: 'standard', ensureMuseSpecialist: false,
    contextManagement: 'host', goals: 'host', memoryReview: false, autoSessionBots: false, github: false, updateCheck: false,
  } }] }]))
  return target
}

/** Capture stable native facts rather than generated UUIDs, wall clocks or progress timing. */
function nativeFacts(events: readonly SessionEvent[], marker: string) {
  const start = events.findIndex(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes(`${marker}：生成一份本地`)))
  const task = events.slice(start)
  return {
    originalMessages: task.filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes(`${marker}：生成一份本地`))).length,
    questionAnswers: task.filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('继续查看结果'))).length,
    tools: task.flatMap(event => event.type === 'tool/call' ? [event.data.name] : []),
    toolErrors: task.flatMap(event => event.type === 'tool/result' ? [event.data.message.isError] : []),
    turns: task.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : []),
    finalReply: task.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('已收到手机确认'))),
  }
}

describe.skipIf(MODE === 'record')('Muse mobile native Session round trip', () => {
  let root: string
  let workspace: string
  let scaffold: WebScaffold | undefined
  let chromiumBrowser: Browser | undefined
  let webkitBrowser: Browser | undefined
  let account: AccountFixture
  let deviceId: string
  let adapter: MobileSessionAdapter
  const cleanup: (() => Promise<void>)[] = []

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'muse-mobile-native-'))
    workspace = join(root, 'workspace'); await mkdir(workspace)
    const plugin = await botPackage(root, workspace)
    const overlay = join(root, 'mobile.overlay.json')
    await writeFile(overlay, JSON.stringify([{ id: 'ui-settings-models', config: { welcomeNotice: false } }]))
    scaffold = await launchWebScaffold({ firstUse: true, profile: { hmr: false, packages: [{ dir: plugin, enabled: true }] },
      extraOverlayPath: [join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml'), overlay] })
    adapter = new MobileSessionAdapter(workspace)
    scaffold.ctx.effect(() => scaffold!.ctx.llm.registerAdapter([PROVIDER], adapter), 'mobile native Session fixture')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    const fixtureUrl = new URL('../../../services/muse-accounts/desktop-test-fixture.mjs', import.meta.url)
    const fixtureModule = await import(fixtureUrl.href) as FixtureModule
    account = await fixtureModule.fixture({ after: close => cleanup.push(close) }, {}, true)
    const exchange = await fetch(scaffold.authenticatedUrl, { redirect: 'manual' })
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
    if (cookie === undefined) throw new Error('Mobile fixture Host cookie exchange failed')
    deviceId = randomUUID()
    await account.connect(account.alice, scaffold.baseUrl, cookie, deviceId, { deviceName: '手机验收电脑', platform: 'darwin' })
    chromiumBrowser = await chromium.launch()
    webkitBrowser = await webkit.launch()
  })

  afterAll(async () => {
    adapter?.releaseAll()
    await Promise.all([chromiumBrowser?.close(), webkitBrowser?.close()])
    for (const close of cleanup.reverse()) await close()
    await scaffold?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it.each(VIEWPORTS)('$engine runs and confirms one native task at $width × $height without resending after reconnection', async ({ engine, ...viewport }) => {
    const browser = engine === 'webkit' ? webkitBrowser : chromiumBrowser
    const context = await browser!.newContext({ viewport, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const marker = `MOBILE_SESSION_${viewport.width}`
    try {
      if (engine === 'webkit') {
        // The HTTP gateway fixture's Secure account cookie requires HTTPS in WebKit.
        // Its browser case uses the same authenticated Host without changing cookie policy.
        await page.goto(scaffold!.authenticatedUrl)
        await page.goto(`${scaffold!.baseUrl}/?mobile=1`)
      } else {
        await page.goto(account.base + '/login')
        await page.locator('input[name="username"]').fill('alice')
        await page.locator('input[name="password"]').fill('password')
        await Promise.all([
          page.waitForURL(url => url.pathname.startsWith('/desktop/')),
          page.locator('form button').click(),
        ])
        await page.goto(`${account.base}/desktop/${deviceId}/?mobile=1`)
      }
      await page.locator('button[data-bot-id]').first().waitFor({ state: 'attached', timeout: 30_000 })
      await page.locator('button[data-bot-id][aria-current="page"]').first().waitFor({ state: 'attached', timeout: 30_000 })
      const botId = await page.locator('button[data-bot-id]').first().getAttribute('data-bot-id')
      if (botId === null) throw new Error('Mobile Bot row has no native Session identifier')
      const row = page.locator(`button[data-bot-id="${botId}"]`).filter({ visible: true }).first()
      if (!await row.count()) await page.getByRole('button', { name: /展开侧边栏|打开侧边栏|Expand sidebar|Open sidebar/u }).first().click()
      await page.locator(`button[data-bot-id="${botId}"]`).filter({ visible: true }).first().click()
      await expect.poll(() => page.locator('[data-sidebar-drawer]').getAttribute('data-sidebar-collapsed')).toBe('true')
      await page.getByRole('button', { name: /展开侧边栏|打开侧边栏|Expand sidebar|Open sidebar/u }).first().click()
      await page.locator(`button[data-bot-id="${botId}"]`).filter({ visible: true }).first().evaluate((element) => {
        const button = element as HTMLButtonElement
        button.click()
        button.click()
      })
      await expect.poll(() => page.locator('[data-sidebar-drawer]').getAttribute('data-sidebar-collapsed')).toBe('true')
      expect(await page.locator(`button[data-bot-id="${botId}"][aria-current="page"]`).count()).toBe(1)
      const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
      await writeComposerDraft(page, composer, `${marker}：生成一份本地 HTML 结果，向我确认后再交付。`)
      await composer.press('Enter')
      await page.getByText(`正在执行 ${marker}`, { exact: true }).waitFor({ timeout: 30_000 })
      await expect.poll(() => adapter.holds.has(marker)).toBe(true)
      const agent = scaffold!.ctx.agents.get(SessionId(botId))
      expect(agent?.status).toBe('running')
      await context.setOffline(true)
      expect(agent?.status).toBe('running')
      await context.setOffline(false)
      await page.reload({ waitUntil: 'load' })
      await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30_000 })
      expect(agent?.status).toBe('running')
      expect(nativeFacts(agent!.session.snapshotEvents(), marker).originalMessages).toBe(1)
      adapter.release(marker)
      await page.getByRole('button', { name: '继续查看结果', exact: true }).waitFor({ timeout: 30_000 })
      await page.getByRole('button', { name: '继续查看结果', exact: true }).click()
      await page.getByText(`已收到手机确认，${marker} 任务完成。结果文件：`, { exact: false }).waitFor({ timeout: 30_000 })
      await expect.poll(() => agent?.status).toBe('idle')
      const html = await readFile(join(workspace, `${marker}.html`), 'utf8')
      expect(html).toContain(`${marker} 执行完成`)
      const resultButton = page.getByRole('button', { name: new RegExp(`在侧边栏预览 .*${marker}\\.html`, 'u') })
      await resultButton.click()
      await page.frameLocator('iframe').getByRole('heading', { name: `${marker} 执行完成` }).waitFor({ timeout: 15_000 })
      const facts = {
        viewport,
        ...nativeFacts(agent!.session.snapshotEvents(), marker),
        requestStages: adapter.requests.filter(request => request.marker === marker).map(request => request.stage),
        previewHeading: await page.frameLocator('iframe').getByRole('heading').textContent(),
      }
      const expectedPath = join(EXPECTED, `${viewport.width}.expected.json`)
      if (MODE === 'refresh') { await mkdir(EXPECTED, { recursive: true }); await writeFile(expectedPath, JSON.stringify(facts, null, 2) + '\n') }
      else expect(facts).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
      expect(facts.originalMessages).toBe(1)
      expect(facts.questionAnswers).toBe(1)
      expect(facts.tools).toEqual(['write', 'ask_user', 'present'])
      expect(facts.toolErrors).toEqual([false, false, false])
      expect(facts.turns).toEqual(['completed', 'completed'])
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
