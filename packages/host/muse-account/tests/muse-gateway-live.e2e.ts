/** Explicit real account login, relay inference and logout through the built Muse plugin. */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readMuseSession } from '../src/session.ts'
import { oldSessionFixture, waitForIdle } from './model-routing-fixture.ts'
import { assertMuseLivePrivacy, MUSE_LIVE_LIMITS, museGatewayLiveConfig, museGatewayLiveTransport } from './muse-gateway-live-fixture.ts'

const live = museGatewayLiveConfig(process.env)

it.skipIf(!live)('uses one ordinary Muse account for real text, a private tool challenge, and verified logout', { timeout: 240_000, retry: 0 }, async () => {
  if (!live) throw new Error('Muse live gateway configuration is required')
  const home = await mkdtemp(join(tmpdir(), 'muse-gateway-live-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const scenario = new AbortController()
  const deadline = setTimeout(() => { scenario.abort() }, MUSE_LIVE_LIMITS.scenarioTimeoutMs)
  onTestFinished(() => { clearTimeout(deadline) })
  const transport = museGatewayLiveTransport(live, globalThis.fetch, scenario.signal)
  vi.stubGlobal('fetch', transport.fetcher)
  onTestFinished(() => { vi.unstubAllGlobals() })
  const fixture = await oldSessionFixture(false, home)
  onTestFinished(async () => { scenario.abort(); await transport.dispose() })
  const account = createRequire(import.meta.url)(fileURLToPath(new URL('../lib/index.js', import.meta.url))) as typeof import('../src/index.ts')
  fixture.ctx.loader.builtins['muse-gateway-live-built'] = account
  const id = await fixture.ctx.loader.create({ name: 'cordis:muse-gateway-live-built', config: {
    baseUrl: live.baseUrl, accountHome: home, remoteAccess: false, modelRefreshMs: 3_600_000, requestTimeoutMs: 30_000,
  } })
  await fixture.ctx.loader.await()
  await fixture.ctx.loader.resolve(id).fiber?.await()
  const service: unknown = fixture.ctx.get('museAccount')
  if (!(service instanceof account.MuseAccountService)) throw new Error('Built Muse account service did not activate')
  let logoutVerified = false
  let agent: Agent | undefined
  try {
    const login = await service.login({ username: live.username, password: live.password, registerIfMissing: false })
    if (login.status.state !== 'signed-in' || login.status.username !== live.username || login.status.admin === true) {
      throw new Error('Live acceptance requires its ordinary dedicated Muse account')
    }
    const session = await readMuseSession(join(home, 'session.json'), live.baseUrl)
    if (!session) throw new Error('Muse account login did not save its isolated session')
    await expect(readFile(join(home, 'model-access.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const provider = `muse-cloud-${live.provider}`
    expect((await fixture.ctx.llm.listModels(provider)).some(model => model.id === live.model)).toBe(true)
    agent = await fixture.driver.create(SessionId('muse-gateway-live'), {
      provider, model: live.model, maxTokens: MUSE_LIVE_LIMITS.maxTokens,
    }, { cwd: home })
    const textMarker = `MUSE_TEXT_${randomBytes(16).toString('hex')}`
    let idle = waitForIdle(fixture.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `Reply with exactly ${textMarker} and nothing else.` }], source: { kind: 'user' } }))
    await idle
    const first = agent.session.deriveMessages().filter(message => message.role === 'assistant').at(-1)
    expect(first?.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()).toBe(textMarker)

    const challenge = `MUSE_TOOL_${randomBytes(32).toString('hex')}`
    let toolCalls = 0
    fixture.ctx.effect(() => fixture.ctx.tools.register(defineContentToolFixture({
      name: 'muse_live_challenge', description: 'Read the current private acceptance marker.', parameters: {},
      execute: async () => { toolCalls++; return [{ type: 'text', text: challenge }] },
    })))
    idle = waitForIdle(fixture.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Call muse_live_challenge exactly once. After it returns, reply with only its exact returned text.' }], source: { kind: 'user' } }))
    await idle
    const events = agent.session.snapshotEvents()
    const failures = events.flatMap(event => event.type === 'turn/end' && event.data.reason.kind === 'error' ? [event.data.reason.error.code] : [])
    if (failures.length > 0) throw new Error(`Muse live turn failed: ${failures.join(',')}; transport=${JSON.stringify(transport.statistics())}`)
    expect(events.filter(event => event.type === 'turn/end')).toMatchObject([
      { data: { reason: { kind: 'completed' } } }, { data: { reason: { kind: 'completed' } } },
    ])
    expect(toolCalls).toBe(1)
    expect(events.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'text' && block.text === challenge))).toBe(true)
    const last = agent.session.deriveMessages().filter(message => message.role === 'assistant').at(-1)
    expect(last?.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()).toBe(challenge)
    expect(transport.statistics().calls).toBe(MUSE_LIVE_LIMITS.calls)
    assertMuseLivePrivacy(JSON.stringify(events), [live.username, live.password, session.cookie, session.cookie.slice(session.cookie.indexOf('=') + 1)])

    expect(await service.logout()).toEqual({ state: 'signed-out' })
    expect(await service.status({ verify: false })).toEqual({ state: 'signed-out' })
    expect(fixture.ctx.llm.listProviders().some(item => item.id === provider)).toBe(false)
    for (const file of ['session.json', 'model-access.json']) await expect(readFile(join(home, file))).rejects.toMatchObject({ code: 'ENOENT' })
    const rejected = await transport.fetcher(new URL('/api/muse.account', live.baseUrl), { headers: { cookie: session.cookie }, redirect: 'manual' })
    await rejected.body?.cancel()
    expect([303, 401]).toContain(rejected.status)
    logoutVerified = true
    process.stdout.write(`${JSON.stringify({ scenario: 'muse-gateway-live', transport: 'relay', provider: live.provider, model: live.model,
      modelRequests: transport.statistics().calls, toolCalls, sessionPrivacy: 'passed', logout: 'verified' })}\n`)
  } finally {
    scenario.abort()
    clearTimeout(deadline)
    if (agent) agent.cancel({ kind: 'user' })
    await transport.dispose()
    await agent?.whenIdle()
    try {
      await service.logout()
    } finally {
      try {
        const cookie = transport.issuedCookie()
        if (!logoutVerified && cookie) {
          const response = await transport.fetcher(new URL('/logout', live.baseUrl), {
            method: 'POST', headers: { cookie, origin: live.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(),
          })
          await response.body?.cancel()
        }
      } finally {
        await fixture.ctx.fiber.dispose()
      }
    }
  }
})
