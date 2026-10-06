import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { MuseDesktopBridge, type MuseDesktopTunnelOptions } from '../src/desktop-bridge.ts'
import { MuseAccountService } from '../src/service.ts'
import { apply, Config } from '../src/index.ts'
import { writeMuseSession } from '../src/session.ts'
import type { Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'
import { afterEach, expect, it, vi } from 'vitest'

const discovery = vi.hoisted(() => ({ apply: vi.fn<(_ctx: Context, _config: McpConfig) => void>() }))
vi.mock('@deepseek-ai/dsh-mcp-client', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-mcp-client')>(),
  inject: [], apply: discovery.apply,
}))
const homes: string[] = [], contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  discovery.apply.mockClear()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers()
})
const catalog = { providers: [{ id: 'studio', name: 'Studio', models: [{ id: 'writer', name: 'Writer',
  contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] }] }
const baseUrl = 'https://muse.example'
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'muse-plugin-')); homes.push(home)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  return { ctx, home, sessionFile: join(home, 'session.json') }
}
async function host(ctx: Context, parts: 'bridge' | 'connection' | 'complete' = 'complete') {
  const tunnels: MuseDesktopTunnelOptions[] = [], stops: MuseDesktopTunnelOptions[] = []
  class Bridge extends MuseDesktopBridge {
    createTunnel(options: MuseDesktopTunnelOptions) {
      tunnels.push(options)
      return { start: async () => {}, stop: async () => { stops.push(options) } }
    }
  }
  await ctx.plugin(Bridge)
  if (parts !== 'bridge') {
    await ctx.plugin(MemoryCredentials)
    const auth = await BrowserAuth.create(ctx.root, ctx.credentials, 1)
    await ctx.plugin({ apply: (scope: Context) => { new HostConnectionService(scope, ['127.0.0.1'], auth) } })
  }
  if (parts === 'complete') {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: async (request, response) => {
      if (ctx.connection.authorizeIndex(request, response)) response.end('Host')
    } }))
  }
  return { tunnels, stops }
}

function account(ctx: Context): MuseAccountService {
  const service: unknown = ctx.get('museAccount')
  if (!(service instanceof MuseAccountService)) throw new Error('Account service was not mounted')
  return service
}

it('rejects a relative product account home before mounting account services or discovery', async () => {
  const { ctx } = await fixture()
  await expect(apply(ctx, Config({ baseUrl, accountHome: 'relative/account' }))).rejects.toThrow('accountHome must be absolute')
  expect(discovery.apply).not.toHaveBeenCalled()
})

it('mounts the account service and a credential-free child using the configured product home', async () => {
  const { ctx, home } = await fixture()
  vi.stubEnv('MUSE_HOME', home)
  await apply(ctx, Config({ baseUrl }))
  expect(await account(ctx).status({})).toEqual({ state: 'signed-out' })
  expect(discovery.apply).toHaveBeenCalledOnce()
  const configured = discovery.apply.mock.calls[0]?.[1]
  expect(configured).toMatchObject({ serverName: 'muse-account', transport: 'stdio', command: process.execPath,
    failOnStartupError: true, args: [fileURLToPath(new URL('../lib/types/mcp-server.js', import.meta.url))] })
  if (!configured || configured.transport !== 'stdio') throw new Error('Bundled stdio discovery was not mounted')
  const launch = JSON.parse(configured.env?.MUSE_ACCOUNT_CONFIG ?? '{}') as Record<string, unknown>
  expect(launch).toEqual({ baseUrl, accountHome: join(home, 'muse-account'), requestTimeoutMs: 15000 })
  expect(JSON.stringify(configured)).not.toContain('password')
  await expect(account(ctx).feedback({ sessionId: SessionId('missing'), target: { kind: 'session' }, includeDiagnostics: false }))
    .rejects.toMatchObject({ code: 'muse-feedback/sign-in-required' })
})

it.each(['none', 'bridge', 'connection'] as const)('refuses remote access before its complete Host provider composition exists (%s)', async (part) => {
  const { ctx, home } = await fixture()
  if (part !== 'none') await host(ctx, part)
  await expect(apply(ctx, Config({ baseUrl, accountHome: home, remoteAccess: true })))
    .rejects.toThrow('remoteAccess requires museDesktopBridge, connection and webServer providers')
  expect(discovery.apply).not.toHaveBeenCalled()
})

it('exchanges the real loopback Host token for a cookie and stops the account tunnel on disposal', async () => {
  const { ctx, home, sessionFile } = await fixture()
  const { tunnels, stops } = await host(ctx)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('feedback-session'))
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Visible request' }] }), { surfaceOp: 'append' })
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=account-private' })
  const fetchHost = fetch
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === '127.0.0.1') return await fetchHost(input, init)
    if (url.pathname === '/api/desktop-models/providers') return Response.json(catalog)
    if (url.pathname === '/api/me') return Response.json({ username: 'alice' })
    if (url.pathname === '/api/muse.feedback') {
      if (typeof init?.body !== 'string') throw new Error('Missing feedback body')
      const value: unknown = JSON.parse(init.body)
      if (typeof value !== 'object' || value === null) throw new Error('Feedback body must be a JSON object')
      return Response.json({ ...value, id: 'a'.repeat(32), revision: 1, username: 'alice' }, { status: 201 })
    }
    throw new Error('Unexpected fixture request')
  }))
  const warn = vi.spyOn(ctx.logger, 'warn')
  await apply(ctx, Config({ baseUrl, accountHome: home, remoteAccess: true }))
  expect(await account(ctx).status({})).toMatchObject({ state: 'signed-in', username: 'alice' })
  expect(tunnels).toHaveLength(1)
  expect(tunnels[0]?.localPort).toBe(ctx.webServer.port)
  expect(tunnels[0]?.loopbackCookie).toMatch(/^dsh-auth-/)
  expect(tunnels[0]?.serverUrl).toBe('wss://muse.example/api/desktop/connect')
  tunnels[0]?.onState('online')
  expect(warn).not.toHaveBeenCalled()
  tunnels[0]?.onState('rejected')
  expect(warn).toHaveBeenCalledWith('Muse desktop connection was rejected; verify your account and connected computer.')
  expect(await account(ctx).feedback({ sessionId: session.id, target: { kind: 'session' }, includeDiagnostics: true }))
    .toEqual({ id: 'a'.repeat(32), revision: 1 })
  await expect(account(ctx).feedback({ sessionId: SessionId('missing'), target: { kind: 'session' }, includeDiagnostics: false }))
    .rejects.toMatchObject({ code: 'muse-feedback/invalid-input' })
  await ctx.fiber.dispose()
  expect(stops).toEqual(tunnels)
})

it.each(['http', 'no-cookie'] as const)('reports local Host bootstrap failure and can refresh again (%s)', async (failure) => {
  const { ctx, home, sessionFile } = await fixture()
  const { tunnels } = await host(ctx)
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=account-private' })
  let failed = true
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== '127.0.0.1') return Response.json(catalog)
    return failed ? new Response(null, { status: failure === 'http' ? 500 : 303,
      ...(failure === 'http' ? { headers: { 'set-cookie': 'host=private; Path=/' } } : {}) })
      : new Response(null, { status: 303, headers: { 'set-cookie': 'host=private; Path=/' } })
  }))
  const warn = vi.spyOn(ctx.logger, 'warn')
  await apply(ctx, Config({ baseUrl, accountHome: home, remoteAccess: true }))
  await expect(account(ctx).status({})).rejects.toMatchObject({ code: 'muse-account/storage-failed' })
  expect(warn).toHaveBeenCalledWith('Muse desktop connection is unavailable; open account settings to retry.')
  expect(tunnels).toHaveLength(0)
  failed = false
  expect(await account(ctx).status({})).toMatchObject({ state: 'signed-in', username: 'alice' })
  expect(tunnels).toHaveLength(1)
})

it('continues catalog polling after a bounded failure and stops its owned timer on disposal', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { ctx, home, sessionFile } = await fixture()
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=account-private' })
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog))
  vi.stubGlobal('fetch', fetcher)
  const warn = vi.spyOn(ctx.logger, 'warn')
  await apply(ctx, Config({ baseUrl, accountHome: home, modelRefreshMs: 10000 }))
  await account(ctx).status({})
  const previous = fetcher.mock.calls.length
  fetcher.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_DETAIL'))
  await vi.advanceTimersByTimeAsync(10000)
  await account(ctx).status({})
  expect(fetcher.mock.calls.length).toBeGreaterThan(previous)
  expect(warn).toHaveBeenCalledWith('Muse model catalog is unavailable; open account settings to retry.')
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('PRIVATE_PROVIDER_DETAIL'))
  await ctx.fiber.dispose()
  const final = fetcher.mock.calls.length
  await vi.advanceTimersByTimeAsync(20000)
  expect(fetcher).toHaveBeenCalledTimes(final)
})

it('does not schedule another refresh when a pending catalog settles after disposal', async () => {
  const { ctx, home, sessionFile } = await fixture()
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=account-private' })
  let entered!: () => void, release!: () => void, settled!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const completed = new Promise<void>((resolve) => { settled = resolve })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
    entered(); await gate
    try { init?.signal?.throwIfAborted(); return Response.json(catalog) }
    finally { settled() }
  }))
  const timer = vi.spyOn(globalThis, 'setTimeout')
  await apply(ctx, Config({ baseUrl, accountHome: home }))
  await started
  await ctx.fiber.dispose()
  release(); await completed
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(timer).not.toHaveBeenCalledWith(expect.any(Function), 60000)
})
