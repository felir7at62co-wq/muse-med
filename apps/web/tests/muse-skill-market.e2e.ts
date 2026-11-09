/** Actual Skill publication, activation and optional client lifecycle through browser interactions. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-muse-market'
import type {} from '@deepseek-ai/dsh-muse-market/activation'
import type {} from '@deepseek-ai/dsh-muse-market/cloud'
import type { MarketManifest } from '@deepseek-ai/dsh-muse-market'
import type { MarketPublication } from '@deepseek-ai/dsh-muse-market/cloud'
import { parseMarketPublicationId } from '@deepseek-ai/dsh-muse-market/cloud'
import { marketDigest, readMarketPackage } from '@deepseek-ai/dsh-muse-market/package'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, revealNavigationDrawer, connectFreshWorkspaceZh, writeComposerDraft } from './support.ts'

const fixtureDirectory = fileURLToPath(new URL('./fixtures/muse-skill-market/', import.meta.url))
const marketPackage = join(REPO_ROOT, 'packages/host/muse-market')
const uiPackage = join(REPO_ROOT, 'packages/client/ui-muse-market')
const expected = fileURLToPath(new URL('./expected/muse-skill-market/behavior.expected.md', import.meta.url))
type Role = 'creator' | 'admin' | 'reader'
interface Archive {
  readonly manifest: MarketManifest
  readonly bytes: Buffer
  readonly sha256: string
  readonly body: string
}
interface MarketBrowserStack {
  readonly root: string
  readonly origin: string
  readonly roles: Readonly<Record<Role, { readonly id: string; readonly username: string }>>
  readonly password: string
  readonly publisherId: string
  readonly publication: MarketPublication
  readonly localArchive: Archive
  readonly localArchiveV2: Archive
  readonly cloudArchive: Archive
  readonly authorName: string
  readonly authorBody: string
  readonly authorFiles: Readonly<Record<string, Buffer>>
  logoutReceipts(): readonly { readonly method: string; readonly path: string; readonly status: number }[]
  tenantStarts(): number
  login(role: Role): Promise<void>
}
declare module '@deepseek-ai/cordis' {
  interface Context { marketBrowserStack: MarketBrowserStack }
}

const localProvider = 'market-browser-keyless'
class BindingAdapter extends LlmAdapter {
  calls = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128000 })
  }
  override async *stream(): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'The first task has bound its selected Skill version.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The first task has bound its selected Skill version.' } }
    yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture() {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    profile: { packages: [{ dir: fixtureDirectory, enabled: true }, { dir: marketPackage }, { dir: uiPackage }], hmr: false },
    replayFixture: fileURLToPath(new URL('./fixtures/model-badge/session.v4.jsonl', import.meta.url)), replayProvidersOnly: true,
  })
  const owned: { browser?: Browser } = {}
  let stop = (): void => {}
  let stopAdapter = (): void => {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally { stop(); stopAdapter(); await scaffold.close() }
  })
  const stack = scaffold.ctx.get('marketBrowserStack')
  if (stack === undefined) throw new Error('The real Skill-market browser fixture did not provide its deployment facts')
  let modelCalls = 0
  const adapter = new BindingAdapter()
  stopAdapter = scaffold.ctx.llm.registerAdapter([localProvider], adapter)
  stop = scaffold.ctx.on('llm/stream', (options, next) => {
    if (options.provider === localProvider) return next()
    modelCalls++; throw new Error('Skill-market UI must not call a paid model')
  })
  const artifacts = join(REPO_ROOT, '.artifacts/pr-integration-20261105/130-market-M4-browser')
  await mkdir(artifacts, { recursive: true })
  const evidence = await mkdtemp(join(artifacts, 'acceptance-'))
  const browser = owned.browser = await chromium.launch()
  return { scaffold, stack, evidence, browser, modelCalls: () => modelCalls, localModelCalls: () => adapter.calls }
}

const marketNavigation = (page: Page) => page.getByRole('navigation').getByRole('button', { name: /Skill.*市场|技能市场|Skill.*market/i })
const panel = (page: Page) => page.locator('[data-muse-skill-market]')
const tab = (root: Locator, name: string) => root.getByRole('tab', { name, exact: true }).or(root.getByRole('button', { name, exact: true }))

async function openMarket(page: Page, language: 'zh' | 'en' = 'zh'): Promise<Locator> {
  await revealNavigationDrawer(page, language)
  await marketNavigation(page).click()
  const root = panel(page)
  await expect.poll(() => root.count()).toBe(1)
  await root.waitFor({ state: 'visible' })
  return root
}

async function createAgent(scaffold: WebScaffold): Promise<AgentHandle> {
  return await scaffold.ctx.agents.create({
    sessionId: SessionId(randomUUID()), meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
    agentOptions: { provider: localProvider, model: 'keyless-scene' },
    setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
  })
}

async function readSkill(scaffold: WebScaffold, agent: Agent, archive: Archive, enabled: boolean): Promise<void> {
  const definition = await scaffold.ctx.skills.get(archive.manifest.skills[0]!.name, { cwd: scaffold.workspaceCwd, scope: agent })
  if (!enabled) { expect(definition).toBeUndefined(); return }
  expect(definition?.source).toBe('muse-market')
  expect(definition?.content).toBe(archive.body)
  expect(definition?.resourceBase?.kind).toBe('directory')
  if (definition?.resourceBase?.kind !== 'directory') throw new Error('The enabled market Skill has no physical bundle directory')
  expect(await readFile(join(definition.resourceBase.path, 'references/rules.md'), 'utf8')).toBe('Preserve the source scene order.\n')
  expect(await readFile(join(definition.resourceBase.path, 'examples/scene.bin'))).toEqual(Buffer.from([0, 255, 1, 128]))
}

async function proveSkill(scaffold: WebScaffold, archive: Archive, enabled: boolean): Promise<void> {
  const handle = await createAgent(scaffold)
  try { await readSkill(scaffold, handle.agent, archive, enabled) } finally { await handle.dispose() }
}

async function layout(root: Locator) {
  return await root.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const controls = Array.from(element.querySelectorAll<HTMLElement>('button, input:not([type="file"]), select, textarea'))
      .filter(control => control.getClientRects().length > 0)
    return { controls: controls.length, noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
      pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      controlsFit: controls.every((control) => {
        const rect = control.getBoundingClientRect()
        return rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
          && rect.left >= -1 && rect.right <= innerWidth + 1
      }) }
  })
}

async function screenshots(browser: Browser, scaffold: WebScaffold, evidence: string): Promise<unknown[]> {
  const result: unknown[] = []
  for (const language of ['zh', 'en'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1280, 420]) {
    await scaffold.ctx.settings.update('locale', { preference: language })
    await scaffold.ctx.settings.update('ui-theme', { preference: theme })
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: language === 'zh' ? 'zh-CN' : 'en-US',
      colorScheme: theme, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage(), messages = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const root = await openMarket(page, language)
      const collapse = page.getByRole('button', { name: language === 'zh' ? '收起侧边栏' : 'Collapse sidebar', exact: true })
      if (await collapse.isVisible()) await collapse.click()
      await page.setViewportSize({ width, height: 960 })
      await page.evaluate(() => document.fonts.ready)
      await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(language === 'zh' ? 'zh-CN' : 'en')
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(theme === 'dark')
      await expect.poll(async () => {
        const facts = await layout(root)
        return facts.controls > 0 && facts.noHorizontalOverflow && facts.pageFits && facts.controlsFit
      }, { message: `Skill market ${language}/${theme}/${width}` }).toBe(true)
      const file = `native-${language}-${theme}-${width}.png`
      await page.screenshot({ path: join(evidence, file), fullPage: true, animations: 'disabled' })
      result.push({ language, theme, width, file: join(evidence, file), ...await layout(root) })
      expect(messages.pageErrors).toEqual([])
    } finally { await context.close() }
  }
  return result
}

it('imports exact disabled archives, activates real Skill bodies and restores the optional market plugin without duplicate controls', async () => {
  const f = await fixture(), { scaffold, stack } = f
  const page = await f.browser.newPage({ viewport: { width: 1280, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const messages = watchConsole(page)
  const nativeResponses: { path: string; status: number; body: string }[] = []
  const nativeReads = new Set<Promise<void>>()
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (!path.includes('/api/museMarket') && !(path === '/api' && response.request().postData()?.includes('museMarket'))) return
    const read = response.text().then((body) => { nativeResponses.push({ path, status: response.status(), body: body.slice(0, 8192) }) },
      (error: unknown) => { nativeResponses.push({ path, status: response.status(), body: String(error) }) })
    nativeReads.add(read)
    void read.finally(() => { nativeReads.delete(read) })
  })
  const originalDefaults = await scaffold.ctx.museMarketActivation.defaults()
  const retained: AgentHandle[] = []
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await writeComposerDraft(page, composer, 'Preserved screenplay draft')
    expect(await composer.innerText()).toBe('Preserved screenplay draft')
    const root = await openMarket(page)
    await tab(root, '已安装').click()
    await expect.poll(() => root.getByRole('button', { name: '刷新', exact: true }).isEnabled()).toBe(true)
    await root.locator('input[type="file"]').setInputFiles({ name: 'local-scene-review.zip', mimeType: 'application/zip',
      buffer: stack.localArchive.bytes })
    const local = root.locator(`[data-market-local="${stack.localArchive.sha256}"]`)
    await local.waitFor()
    const installed = await scaffold.ctx.museMarket.installed()
    expect(installed).toHaveLength(1)
    expect(installed[0]?.enabled).toBe(false)
    expect(installed[0]?.release.sha256).toBe(stack.localArchive.sha256)
    expect(await scaffold.ctx.museMarketActivation.defaults()).toEqual(originalDefaults)
    await proveSkill(scaffold, stack.localArchive, false)
    const exported = await scaffold.ctx.museMarket.exportPackage(installed[0]!.release.id)
    expect(Buffer.from(exported.base64, 'base64')).toEqual(stack.localArchive.bytes)
    await local.getByRole('button', { name: '设为新会话默认版本', exact: true }).click()
    await page.getByRole('dialog', { name: '设为新会话默认版本', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    expect(await scaffold.ctx.museMarketActivation.defaults()).toEqual(originalDefaults)
    await local.getByRole('button', { name: '设为新会话默认版本', exact: true }).click()
    await page.getByRole('dialog', { name: '设为新会话默认版本', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarketActivation.defaults()).defaults[0]?.releaseId)
      .toBe(installed[0]!.release.id)
    await proveSkill(scaffold, stack.localArchive, true)
    const old = await createAgent(scaffold)
    retained.push(old)
    const blank = await createAgent(scaffold)
    retained.push(blank)
    old.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Retain the first selected Skill version for this scene.' }],
      source: { kind: 'user' } }), 'next-turn', true)
    await old.agent.whenIdle()
    const oldBinding = await scaffold.ctx.museMarketActivation.binding({ sessionId: old.agent.id })
    expect(oldBinding.phase).toBe('bound')
    expect(oldBinding.releases.map(item => item.release.id)).toEqual([installed[0]!.release.id])
    expect(old.agent.session.snapshotEvents().filter(event => event.type === 'muse-market/bound')).toHaveLength(1)
    expect((await scaffold.ctx.museMarketActivation.binding({ sessionId: blank.agent.id })).phase).toBe('blank')
    const defaultsV1 = await scaffold.ctx.museMarketActivation.defaults()
    await expect.poll(() => root.locator('input[type="file"]').isEnabled()).toBe(true)
    await root.locator('input[type="file"]').setInputFiles({ name: 'local-scene-review-v2.zip', mimeType: 'application/zip',
      buffer: stack.localArchiveV2.bytes })
    const versionTwo = root.locator(`[data-market-local="${stack.localArchiveV2.sha256}"]`)
    await versionTwo.waitFor()
    expect(await scaffold.ctx.museMarketActivation.defaults()).toEqual(defaultsV1)
    await versionTwo.getByRole('button', { name: '设为新会话默认版本', exact: true }).click()
    await page.getByRole('dialog', { name: '设为新会话默认版本', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarketActivation.defaults()).defaults[0]?.releaseId)
      .toBe(stack.localArchiveV2.sha256)
    expect(await scaffold.ctx.museMarketActivation.binding({ sessionId: old.agent.id })).toEqual(oldBinding)
    await readSkill(scaffold, old.agent, stack.localArchive, true)
    const blankV2 = await scaffold.ctx.museMarketActivation.binding({ sessionId: blank.agent.id })
    expect(blankV2.phase).toBe('blank')
    expect(blankV2.releases.map(item => item.release.id)).toEqual([stack.localArchiveV2.sha256])
    await readSkill(scaffold, blank.agent, stack.localArchiveV2, true)
    await proveSkill(scaffold, stack.localArchiveV2, true)
    await versionTwo.getByRole('button', { name: '停用新会话默认版本', exact: true }).click()
    await page.getByRole('dialog', { name: '停用新会话默认版本', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarketActivation.defaults()).defaults).toEqual([])
    await proveSkill(scaffold, stack.localArchiveV2, false)
    await readSkill(scaffold, old.agent, stack.localArchive, true)
    expect(await scaffold.ctx.museMarketActivation.binding({ sessionId: old.agent.id })).toEqual(oldBinding)
    const beforeCloudInstall = await scaffold.ctx.museMarketActivation.defaults()
    await tab(root, '发现').click()
    const cloud = root.locator(`[data-market-publication="${stack.publication.id}"]`)
    await cloud.waitFor()
    await cloud.getByRole('button', { name: '安装此版本', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarket.installed()).length).toBe(3)
    const cloudInstalled = (await scaffold.ctx.museMarket.installed()).find(item => item.release.sha256 === stack.cloudArchive.sha256)
    expect(cloudInstalled?.enabled).toBe(false)
    expect(await scaffold.ctx.museMarketActivation.defaults()).toEqual(beforeCloudInstall)
    await proveSkill(scaffold, stack.cloudArchive, false)
    await tab(root, '创作者中心').click()
    const creator = root.getByRole('region', { name: '制作与上传 Skill', exact: true })
    await creator.waitFor()
    await creator.getByRole('combobox', { name: '本地 Skill', exact: true }).selectOption(stack.authorName)
    for (const [label, value] of [['发布标识', 'browser-authored-package'], ['显示名称', 'Browser-authored review'],
      ['介绍', 'Review the original events and motives.'], ['版本号', '1.0.0'], ['授权协议', 'MIT'], ['分类', 'writing']]) {
      await creator.getByLabel(label!, { exact: true }).fill(value!)
    }
    await creator.getByLabel('使用前提', { exact: true }).fill('The original scene.')
    await creator.getByLabel('使用示例', { exact: true }).fill('Review this supplied scene.')
    await creator.getByRole('button', { name: '生成本地发布包', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarket.installed())
      .filter(item => item.release.manifest.name === 'browser-authored-package').length).toBe(1)
    const authored = (await scaffold.ctx.museMarket.installed()).find(item => item.release.manifest.name === 'browser-authored-package')!
    expect(authored.enabled).toBe(false)
    expect(await scaffold.ctx.museMarketActivation.defaults()).toEqual(beforeCloudInstall)
    await creator.getByRole('combobox', { name: '选择已安装的发布包', exact: true }).selectOption(authored.release.id)
    const preparingDownload = page.waitForEvent('download')
    await creator.getByRole('button', { name: '导出发布包', exact: true }).click()
    const preparedDownload = await preparingDownload, preparedPath = join(f.evidence, 'native-authored.zip')
    await preparedDownload.saveAs(preparedPath)
    const preparedBytes = await readFile(preparedPath)
    expect(marketDigest(preparedBytes)).toBe(authored.release.id)
    const contents = readMarketPackage(preparedBytes, scaffold.ctx.museMarket.publicationStorage().limits)
    for (const [path, bytes] of Object.entries(stack.authorFiles)) {
      expect(Buffer.from(contents.files[`skills/${stack.authorName}/${path}`]!)).toEqual(bytes)
    }
    await creator.getByRole('combobox', { name: '发布团队', exact: true }).selectOption(stack.publisherId)
    await creator.getByRole('button', { name: '上传私有草稿', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarketCloud.catalog('', true))
      .filter(item => item.manifest.name === 'browser-authored-package').length).toBe(1)
    const authoredDraft = (await scaffold.ctx.museMarketCloud.catalog('', true))
      .find(item => item.manifest.name === 'browser-authored-package')!
    expect(authoredDraft).toMatchObject({ status: 'draft', revision: 1, sha256: authored.release.id })
    expect(await scaffold.ctx.museMarketActivation.defaults()).toEqual(beforeCloudInstall)
    await stack.login('reader')
    await root.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarketCloud.identity()).publishers).toEqual([])
    await expect.poll(() => root.locator(`[data-market-publication="${authoredDraft.id}"]`).count()).toBe(0)
    await tab(root, '已安装').click()
    await root.locator(`[data-market-local="${stack.cloudArchive.sha256}"]`)
      .getByRole('button', { name: '移除本地版本', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarket.installed()).length).toBe(3)
    expect((await scaffold.ctx.museMarketCloud.getPublication(stack.publication.id)).sha256).toBe(stack.cloudArchive.sha256)
    expect(await scaffold.ctx.museMarketActivation.defaults()).toEqual(beforeCloudInstall)
    const ui = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ui-muse-market')
    if (ui === undefined) throw new Error('The optional UI Loader row is missing')
    await ui.update({ disabled: true }); await scaffold.ctx.loader.await()
    await expect.poll(() => panel(page).count()).toBe(0)
    await expect.poll(() => marketNavigation(page).count()).toBe(0)
    await expect.poll(() => composer.isVisible()).toBe(true)
    expect(await composer.innerText()).toBe('Preserved screenplay draft')
    expect(await scaffold.ctx.museMarket.installed()).toHaveLength(3)
    expect(await scaffold.ctx.museMarketActivation.defaults()).toEqual(beforeCloudInstall)
    await ui.update({ disabled: false }); await scaffold.ctx.loader.await()
    await expect.poll(() => marketNavigation(page).count()).toBe(1)
    await openMarket(page)
    expect(await panel(page).count()).toBe(1)
    expect(await marketNavigation(page).count()).toBe(1)
    const responsive = await screenshots(f.browser, scaffold, f.evidence)
    expect(f.modelCalls()).toBe(0)
    expect(f.localModelCalls()).toBe(1)
    expect(stack.tenantStarts()).toBe(0)
    expect(messages.pageErrors).toEqual([])
    await writeFile(join(f.evidence, 'native-proof.json'), JSON.stringify({
      importedDisabled: true, originalZipPreserved: true, cloudInstallDisabled: true,
      actualSkillBodyAndResourcesRead: true, defaultDisableRemovedSkill: true,
      importingV2DidNotChangeV1Default: true, explicitModalCasSelectedV2: true,
      executedSessionPinnedToV1AfterSwitchAndDisable: true, blankAndFreshAgentsReadV2: true,
      actualFilesystemSkillPreparedThroughForm: true, preparedExportPreservedOriginalResources: true,
      explicitNativeUploadCreatedOnlyPrivateDraft: true, creatorDraftHiddenAfterReaderSwitch: true,
      removedLocalCopyDidNotRemoveCloudPublication: true,
      cloudInstallDidNotChangeDefaults: true, uiUnloadPreservedLocalStorage: true,
      uiReenableRoots: 1, uiReenableNavigation: 1, externalModelCalls: f.modelCalls(), localModelCalls: f.localModelCalls(),
      tenantStarts: stack.tenantStarts(), responsive,
    }, null, 2) + '\n')
    await mkdir(dirname(expected), { recursive: true })
    await compareOrRefreshGolden(expected,
      '# Skill market browser behavior\n\n- ZIP import and cloud installation retain exact archives and remain disabled.\n- An explicit default loads the real Skill body, text references and binary resources in a new agent scope.\n- Importing V2 preserves the V1 default; an explicit confirmation selects V2 through compare-and-swap.\n- An executed Session retains V1 after the switch and disable; a blank Session and a fresh agent read V2.\n- Disabling removes the default from new agents, while installation does not change defaults.\n- A real filesystem Skill is prepared through the creator form, exported with its original text and binary resources, and explicitly uploaded as a private draft.\n- A creator draft disappears when a different reader account refreshes the page.\n- UI disable restores the original composer draft and preserves stored releases; re-enable restores one page and navigation entry.\n- Both languages and both themes fit at 1280px and 420px.\n- One scripted local model completion binds V1; no external model calls or cloud tenant starts occur.', webSnapshotMode())
  } catch (error) {
    await Promise.allSettled([...nativeReads])
    await writeFile(join(f.evidence, 'native-api.json'), JSON.stringify({ responses: nativeResponses,
      installed: await scaffold.ctx.museMarket.installed(), defaults: await scaffold.ctx.museMarketActivation.defaults() }, null, 2) + '\n')
    await page.screenshot({ path: join(f.evidence, 'native-failure.png'), fullPage: true, animations: 'disabled' })
    await writeFile(join(f.evidence, 'native-failure.aria.txt'), await page.locator('body').ariaSnapshot())
    await writeFile(join(f.evidence, 'native-failure.console.json'), JSON.stringify(messages, null, 2) + '\n')
    throw error
  } finally { for (const handle of retained.reverse()) await handle.dispose() }
}, 180000)

async function browserLogin(context: BrowserContext, stack: MarketBrowserStack, role: Role): Promise<void> {
  const response = await context.request.post(stack.origin + '/login', {
    form: { username: stack.roles[role].username, password: stack.password }, headers: { origin: stack.origin }, maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
}

async function paint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) }))
}

it('retains one uncertain browser upload across account switches and discards late private replies after logout', async () => {
  const f = await fixture(), { stack, scaffold } = f
  const context = await f.browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage(), messages = watchConsole(page)
  const uploads: { key: string | undefined; account: string | undefined; id: string; status: number }[] = []
  let abortFirst = true
  const releasePrivate = Promise.withResolvers<undefined>(), privateRead = Promise.withResolvers<MarketPublication['id']>()
  const privateDelivered = Promise.withResolvers<undefined>()
  let gatePrivate = false, heldPrivateCanceled = false
  const routeErrors: unknown[] = []
  const logoutNetwork: { event: string; path: string; status?: number; failure?: string }[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/logout') logoutNetwork.push({ event: request.method(), path: request.url() })
  })
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/logout') {
      logoutNetwork.push({ event: 'response', path: response.url(), status: response.status() })
    }
  })
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/logout') {
      const failure = request.failure()?.errorText
      logoutNetwork.push({ event: 'failed', path: request.url(), ...(failure === undefined ? {} : { failure }) })
    }
  })
  try {
    await browserLogin(context, stack, 'creator')
    await page.goto(stack.origin + '/market', { waitUntil: 'load' })
    const root = page.locator('#market-root')
    await root.waitFor()
    await expect.poll(() => page.locator('#publisher-select option').count()).toBeGreaterThan(0)
    await page.locator('#publisher-select').selectOption(stack.publisherId)
    await page.route('**/api/market/v1/uploads', async (route) => {
      const response = await route.fetch()
      const value: unknown = await response.json()
      if (typeof value !== 'object' || value === null || !('id' in value)) throw new Error('The actual upload returned no publication id')
      const headers = route.request().headers(), id = parseMarketPublicationId(value.id)
      uploads.push({ key: headers['idempotency-key'], account: headers['x-muse-market-account'], id, status: response.status() })
      if (abortFirst) { abortFirst = false; await route.abort('failed') }
      else await route.fulfill({ response })
    })
    await page.locator('#archive-input').setInputFiles({ name: 'local-scene-review.zip', mimeType: 'application/zip',
      buffer: stack.localArchive.bytes })
    await expect.poll(() => page.locator('#upload-button').isEnabled()).toBe(true)
    await page.locator('#upload-button').click()
    await expect.poll(() => uploads.length).toBe(1)
    expect(uploads[0]?.status).toBe(201)
    expect(uploads[0]?.account).toBe(stack.roles.creator.id)
    await expect.poll(() => page.locator('#upload-retry').isVisible()).toBe(true)
    const original = uploads[0]!
    expect(original.key).toMatch(/^[A-Za-z0-9_-]{8,100}$/u)
    await browserLogin(context, stack, 'reader')
    await page.locator('#catalog-refresh').click()
    await expect.poll(() => page.locator('#upload-retry').isDisabled()).toBe(true)
    await page.getByText('原上传仍保留，请切回原账号后恢复；当前账号不会复用它', { exact: false }).waitFor()
    expect(await page.locator('#archive-input').evaluate((element: HTMLInputElement) => element.files?.[0]?.name))
      .toBe('local-scene-review.zip')
    expect(uploads).toHaveLength(1)
    await browserLogin(context, stack, 'creator')
    await page.locator('#catalog-refresh').click()
    await expect.poll(() => page.locator('#upload-retry').isEnabled()).toBe(true)
    await page.locator('#upload-retry').click()
    await expect.poll(() => uploads.length).toBe(2)
    expect(uploads[1]).toEqual(original)
    const result = page.locator('#draft-result')
    await result.getByRole('button', { name: '提交审核', exact: true }).waitFor()
    expect((await scaffold.ctx.museMarketCloud.getPublication(parseMarketPublicationId(original.id))).status).toBe('draft')
    await result.getByRole('button', { name: '提交审核', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.museMarketCloud.getPublication(parseMarketPublicationId(original.id))).status)
      .toBe('pending')
    await page.route('**/api/market/v1/catalog?**', async (route) => {
      if (!gatePrivate || new URL(route.request().url()).searchParams.get('mine') !== 'true') { await route.continue(); return }
      gatePrivate = false
      try {
        const response = await route.fetch()
        const value: unknown = await response.json()
        if (typeof value !== 'object' || value === null || !('items' in value) || !Array.isArray(value.items)
          || !value.items.some((item: unknown) => typeof item === 'object' && item !== null && 'id' in item && item.id === original.id)) {
          throw new Error('The delayed real private catalog does not contain the pending publication')
        }
        privateRead.resolve(parseMarketPublicationId(original.id))
        await releasePrivate.promise
        try { await route.fulfill({ response }) }
        catch (error) {
          if (route.request().failure() === null && !page.isClosed()) throw error
          heldPrivateCanceled = true
        }
      } catch (error) { routeErrors.push(error); privateRead.reject(error) }
      finally { privateDelivered.resolve(undefined) }
    })
    gatePrivate = true
    await page.locator('#market-tabs [data-tab="mine"]').click()
    expect(await privateRead.promise).toBe(original.id)
    const previousLogouts = stack.logoutReceipts().length
    await page.locator('#market-logout').click()
    await expect.poll(() => stack.logoutReceipts().slice(previousLogouts)).toEqual([{ method: 'POST', path: '/logout', status: 303 }])
    await expect.poll(() => page.locator('#market-logout').isVisible()).toBe(false)
    releasePrivate.resolve(undefined)
    await privateDelivered.promise
    await paint(page)
    await expect.poll(() => page.locator('#catalog-refresh').isEnabled()).toBe(true)
    await expect.poll(() => page.locator('#catalog-list').getAttribute('aria-busy')).toBe('false')
    expect(await page.locator(`[data-publication-id="${original.id}"]`).count()).toBe(0)
    expect(await page.locator('#draft-result').innerText()).toBe('')
    expect((await context.request.get(stack.origin + '/api/market/v1/catalog?mine=true')).status()).toBe(401)
    expect(routeErrors).toEqual([])
    await browserLogin(context, stack, 'reader')
    await page.locator('#catalog-refresh').click()
    await page.locator('#market-tabs [data-tab="public"]').click()
    const published = page.locator(`#catalog-list article[data-publication-id="${stack.publication.id}"]`)
    await published.waitFor()
    const saved = page.waitForEvent('download')
    await published.locator('[data-action="download"]').click()
    const download = await saved, downloaded = join(f.evidence, 'verified-cloud.zip')
    await download.saveAs(downloaded)
    expect(await readFile(downloaded)).toEqual(stack.cloudArchive.bytes)
    let extraDownloads = 0
    page.on('download', () => { extraDownloads++ })
    await page.route(`**/api/market/v1/releases/${stack.publication.id}/download`, async (route) => {
      const response = await route.fetch(), bytes = Buffer.from(await response.body())
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
      await route.fulfill({ response, body: bytes })
    })
    await published.locator('[data-action="download"]').click()
    await expect.poll(() => page.locator('#market-status[data-kind="error"]').textContent()).toBe('ZIP 未通过校验，未开始下载')
    await paint(page)
    expect(extraDownloads).toBe(0)
    await page.reload({ waitUntil: 'load' })
    await page.locator(`#catalog-list article[data-publication-id="${stack.publication.id}"]`).waitFor()
    await expect.poll(() => page.locator('#market-identity').textContent()).toBe('当前账号尚未加入发布团队，请联系管理员')
    expect(await page.locator('#publisher-select').isDisabled()).toBe(true)
    expect(await page.locator('#upload-button').isDisabled()).toBe(true)
    const responsive: unknown[] = []
    for (const language of ['zh', 'en']) for (const theme of ['light', 'dark']) for (const width of [1280, 420]) {
      await page.locator('#market-language').selectOption(language)
      await page.locator('#market-theme').selectOption(theme)
      await page.setViewportSize({ width, height: 960 })
      await page.evaluate(() => document.fonts.ready)
      await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(language === 'zh' ? 'zh-CN' : language)
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(theme)
      await expect.poll(async () => {
        const facts = await layout(root)
        return facts.controls > 0 && facts.noHorizontalOverflow && facts.pageFits && facts.controlsFit
      }).toBe(true)
      const file = `standalone-${language}-${theme}-${width}.png`
      await page.screenshot({ path: join(f.evidence, file), fullPage: true, animations: 'disabled' })
      responsive.push({ language, theme, width, file: join(f.evidence, file), ...await layout(root) })
    }
    expect(f.modelCalls()).toBe(0); expect(stack.tenantStarts()).toBe(0)
    expect(extraDownloads).toBe(0)
    expect(messages.pageErrors).toEqual([])
    await writeFile(join(f.evidence, 'standalone-proof.json'), JSON.stringify({ uploads,
      actualCommittedUploadReplyLost: true, originalAttemptSurvivedAccountSwitch: true, readerDidNotReuseCreatorAttempt: true,
      explicitRetryReturnedOriginalPublication: true, explicitSubmitOnly: true, actualPrivateReplyHeldThroughLogout: true,
      latePrivateReplyNotDisplayed: true, heldPrivateCanceled, verifiedDownloadExactBytes: true,
      logoutReceipts: stack.logoutReceipts(), logoutNetwork,
      corruptDownloadStartedNoFile: true, extraDownloads, responsive, modelCalls: f.modelCalls(), tenantStarts: stack.tenantStarts(),
    }, null, 2) + '\n')
  } catch (error) {
    await writeFile(join(f.evidence, 'standalone-network.json'), JSON.stringify({ logoutNetwork, logoutReceipts: stack.logoutReceipts() }, null, 2) + '\n')
    await page.screenshot({ path: join(f.evidence, 'standalone-failure.png'), fullPage: true, animations: 'disabled' })
    await writeFile(join(f.evidence, 'standalone-failure.aria.txt'), await page.locator('body').ariaSnapshot())
    await writeFile(join(f.evidence, 'standalone-failure.console.json'), JSON.stringify(messages, null, 2) + '\n')
    throw error
  } finally {
    releasePrivate.resolve(undefined)
    await context.close()
  }
}, 180000)
