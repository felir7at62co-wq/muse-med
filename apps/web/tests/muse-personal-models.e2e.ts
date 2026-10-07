/** Muse personal-model discovery, persistence and selection through an owned local provider. */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile, mkdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, writeComposerDraft } from './support.ts'

it('discovers a personal model in Muse, retains it after restart and selects it for requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-custom-review-'))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let server: Server | undefined
  const requests: { model: string; authorization?: string | undefined }[] = []
  let continuationRequests = 0
  try {
    server = createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'personal-review-model', name: 'Personal Review Model', contextWindow: 262144, max_tokens: 32768 }] }))
        return
      }
      if (request.url === '/api/desktop-models/providers') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ providers: [{ id: 'review-cloud', name: 'Review Cloud', models: [{
          id: 'cloud-review-model', name: 'Cloud Review', contextWindow: 262144, maxTokens: 32768,
          input: ['text'], reasoningEfforts: false,
        }] }] }))
        return
      }
      if (request.url === '/api/muse.account') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ username: 'review-account' }))
        return
      }
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      request.once('end', () => {
        const value = JSON.parse(body) as { model: string; messages: { content: string | { text?: string }[] }[] }
        requests.push({ model: value.model, authorization: request.headers.authorization })
        const continuing = value.messages.some(message => typeof message.content === 'string'
          ? message.content.includes('MUSE_CONTINUATION_PROBE')
          : message.content.some(block => block.text?.includes('MUSE_CONTINUATION_PROBE')))
        const segment = continuing ? ['FIRST_PROBE_PART', 'SECOND_PROBE_PART', 'FINAL_PROBE_PART'][continuationRequests++] : 'LOCAL_PROBE_OK'
        if (segment === undefined) throw new Error('Unexpected extra continuation request')
        const finish = continuing && continuationRequests < 3 ? 'length' : 'stop'
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: segment }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`,
          'data: [DONE]', '', '',
        ].join('\n\n'))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('No fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    const endpoint = `${origin}/v1`
    const accountHome = join(home, 'muse-account')
    await mkdir(accountHome, { mode: 0o700 })
    await writeFile(join(accountHome, 'session.json'), JSON.stringify({ baseUrl: origin,
      cookie: '__Host-muse=review-session', username: 'review-account', revision: 'review-revision',
    }), { mode: 0o600 })
    const overlay = join(home, 'review.patch.json')
    await writeFile(overlay, JSON.stringify([{ insert: [
      { id: 'muse-account', name: '@deepseek-ai/dsh-muse-account', config: { baseUrl: origin, accountHome, remoteAccess: false } },
      { id: 'ui-muse-account', name: '@deepseek-ai/dsh-client-ui-muse-account', config: { feedbackUrl: 'https://example.invalid/feedback' } },
    ] }]))
    const launchOptions = { harnessHome: home, deepSeekMissingCredential: true,
      extraOverlayPath: [join(REPO_ROOT, 'apps/desktop-host/config/defaults.cordis.patch.yml'), overlay,
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
      extraInstallAnchors: [join(REPO_ROOT, 'apps/desktop-host/package.json')],
    }
    scaffold = await launchWebScaffold(launchOptions)
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1, productName: 'muse-med' } })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'MUSE 账号', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).click()
    await dialog.getByRole('tab', { name: '自定义模型 API' }).click()
    const custom = dialog.getByRole('tabpanel', { name: '自定义模型 API' })
    await custom.getByLabel('Provider ID').fill('muse-personal-review')
    await custom.getByLabel('显示名称').fill('Personal Review')
    await custom.getByLabel('API 地址').fill(endpoint)
    await custom.getByLabel('API 密钥', { exact: true }).fill('synthetic-review-key')
    await custom.getByRole('button', { name: '获取可用模型', exact: true }).click()
    const available = page.getByRole('dialog', { name: '选择要添加的模型', exact: true })
    await available.getByRole('checkbox', { name: /personal-review-model/ }).check()
    await available.getByRole('button', { name: '添加所选', exact: true }).click()
    expect(await custom.getByLabel('模型 ID 1').inputValue()).toBe('personal-review-model')
    await custom.getByRole('button', { name: '创建提供商', exact: true }).click()
    await dialog.getByRole('button', { name: '编辑 Personal Review (muse-personal-review)', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '编辑 Personal Review (muse-personal-review)', exact: true }).click()
    await dialog.getByText('自定义设置', { exact: true }).click()
    expect(await dialog.getByLabel('模型 ID 1').inputValue()).toBe('personal-review-model')
    const stored = await readFile(join(home, 'profiles/scaffold/cordis.patch.yml'), 'utf8')
    expect(stored).toContain('muse-personal-review:')
    expect(stored).toContain('personal-review-model')
    expect(stored).not.toContain('synthetic-review-key')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Personal Review Model', exact: true }).click()
    await expect.poll(() => scaffold!.ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: 'muse-personal-review', model: 'personal-review-model',
    })
    await browser.close()
    browser = undefined
    await scaffold.close()
    await unlink(join(home, 'profiles/scaffold/node_modules/@deepseek-ai/dsh-desktop-host'))
    scaffold = await launchWebScaffold(launchOptions)
    await expect.poll(() => scaffold!.ctx.llm.listProviders().some(provider => provider.id === 'muse-cloud-review-cloud')).toBe(true)
    expect(await scaffold.ctx.llm.listModels('muse-personal-review')).toMatchObject([{ id: 'personal-review-model' }])
    expect((await scaffold.ctx.sessionController.modelCatalog()).groups.some(group => group.id === 'muse-personal-review'
      && group.models.some(model => model.id === 'personal-review-model'))).toBe(true)
    expect((await scaffold.ctx.credentials.describe(credentialRef('MUSE_PERSONAL_REVIEW_API_KEY'))).configured).toBe(true)
    const chunks = []
    for await (const chunk of scaffold.ctx.llm.stream({ provider: 'muse-personal-review', model: 'personal-review-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Run the local review probe.' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
    expect(requests).toEqual([{ model: 'personal-review-model', authorization: 'Bearer synthetic-review-key' }])

    browser = await chromium.launch()
    const continuedPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await continuedPage.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1, productName: 'muse-med' } })
    })
    await continuedPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(continuedPage, scaffold.workspaceCwd)
    const composer = continuedPage.locator('[data-composer-input][contenteditable="true"]')
    await writeComposerDraft(continuedPage, composer, 'MUSE_CONTINUATION_PROBE: finish the three segments.')
    await composer.press('Enter')
    await continuedPage.getByText('FINAL_PROBE_PART', { exact: true }).waitFor()
    await expect.poll(() => scaffold!.ctx.agents.list().every(agent => agent.status === 'idle')).toBe(true)
    const active = scaffold.ctx.agents.list().find(agent => agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && event.data.content.some(block => block.type === 'text' && block.text.includes('MUSE_CONTINUATION_PROBE'))))
    expect(active).toBeDefined()
    const events = active!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'output-continuation')).toHaveLength(2)
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([{ turn: 1, reason: { kind: 'completed' } }])
    expect(await continuedPage.getByText('已达到输出 token 上限', { exact: false }).count()).toBe(0)
    expect(continuationRequests).toBe(3)
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        try {
          server?.closeAllConnections()
          if (server?.listening) await new Promise<void>((resolve, reject) => {
            server!.close((error) => { if (error) reject(error); else resolve() })
          })
        } finally {
          await rm(home, { recursive: true, force: true })
        }
      }
    }
  }
})
