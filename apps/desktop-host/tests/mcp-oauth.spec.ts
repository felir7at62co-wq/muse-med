/** Exercise the panel's OAuth listener and single-use code through its Cordis-owned gateway. */
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import http, { type Server } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface OAuthStartResult {
  flowId: string
  authUrl: string
  redirectUri: string
  expiresInSeconds: number
}

interface OAuthPollResult {
  status: 'pending' | 'done' | 'failed'
  serverName: string
  expiresAt?: number | null
  header?: string
  error?: string
}

interface GatewayFixture {
  readRows(): Promise<{
    path: string
    raw: string
    managed: { name: string; config: { transport: string; serverName: string; url: string } }[]
    external: never[]
    foreign: { entries: never[]; raw: string }
  }>
  dshHomeOf(): string
  patchPath(): string
  writeAuthHeader(serverName: string, value: string | undefined, signal?: AbortSignal): Promise<void>
  oauthStart(payload: unknown): Promise<OAuthStartResult>
  oauthPoll(payload: unknown): Promise<OAuthPollResult>
}

interface GatewayConstructor {
  new(ctx: Context): GatewayFixture
  readonly prototype: GatewayFixture
}

// The panel owns a separate compiler program; load its real source without adding it to the Host aggregate.
const gatewayUrl = new URL('../../../third_party/plugins/dsh-skill-mcp-panel/src/mcp/gateway.ts', import.meta.url).href
const oauthUrl = new URL('../../../third_party/plugins/dsh-skill-mcp-panel/src/oauth.ts', import.meta.url).href
const { McpManagerGateway }: { McpManagerGateway: GatewayConstructor } = await import(gatewayUrl)
const { oauthFile }: { oauthFile(home: string): string } = await import(oauthUrl)

const originalFetch = globalThis.fetch
const metadata = {
  authorization_endpoint: 'https://oauth-fixture.invalid/authorize',
  token_endpoint: 'https://oauth-fixture.invalid/token',
  registration_endpoint: 'https://oauth-fixture.invalid/register',
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  globalThis.fetch = originalFetch
})

/** Isolate files and listeners; external requests never leave this process. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'muse-oauth-lifecycle-'))
  const ctx = new Context()
  let gateway!: GatewayFixture
  const servers: Server[] = []
  const createServer = http.createServer
  vi.spyOn(http, 'createServer').mockImplementation((...args: Parameters<typeof createServer>) => {
    const server = createServer(...args)
    servers.push(server)
    return server
  })
  syncBuiltinESMExports()
  const fiber = ctx.plugin((scope) => { gateway = new McpManagerGateway(scope) })
  await fiber
  gateway.readRows = async () => ({ path: '', raw: '', managed: [
    { name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'streamable-http', serverName: 'fixture', url: 'https://oauth-fixture.invalid/mcp' } },
  ], external: [], foreign: { entries: [], raw: '' } })
  gateway.dshHomeOf = () => home
  let headerWrites = 0
  gateway.writeAuthHeader = async () => { headerWrites += 1 }
  const tokenRequested = Promise.withResolvers<RequestInit | undefined>()
  const tokenResponse = Promise.withResolvers<Response>()
  const polls: Promise<unknown>[] = []
  const poll = gateway.oauthPoll.bind(gateway)
  gateway.oauthPoll = (input) => {
    const pending = poll(input)
    polls.push(pending)
    return pending
  }
  let tokenCalls = 0
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    assert.match(String(input), /^https:\/\/oauth-fixture\.invalid\//u)
    if (!String(input).endsWith('/token')) return Response.json(metadata)
    tokenCalls += 1
    tokenRequested.resolve(init)
    return tokenResponse.promise
  })
  return {
    ctx, fiber, gateway, home, servers, tokenRequested, tokenResponse,
    tokenCalls: () => tokenCalls,
    headerWrites: () => headerWrites,
    async start() { return gateway.oauthStart({ serverName: 'fixture', clientId: 'fixture-client' }) },
    async authorize(start: { authUrl: string; redirectUri: string }) {
      const callback = new URL(start.redirectUri)
      callback.searchParams.set('code', 'fixture-code')
      callback.searchParams.set('state', new URL(start.authUrl).searchParams.get('state')!)
      await originalFetch(callback)
    },
    async close() {
      tokenResponse.resolve(Response.json({ access_token: 'fixture-access', expires_in: 3600 }))
      await Promise.allSettled(polls)
      await fiber.dispose()
      await ctx.fiber.dispose()
      for (const server of servers) if (server.listening) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => { server.close(() => resolve()) })
      }
      await rm(home, { recursive: true, force: true })
    },
  }
}

describe('MCP OAuth recovery', () => {
  it('closes the listener when dynamic registration rejects', async () => {
    const f = await fixture()
    try {
      globalThis.fetch = vi.fn(async (input) => {
        assert.match(String(input), /^https:\/\/oauth-fixture\.invalid\//u)
        if (String(input).endsWith('/register')) throw new Error('fixture registration rejected')
        return Response.json(metadata)
      })
      await expect(f.gateway.oauthStart({ serverName: 'fixture' })).rejects.toThrow('fixture registration rejected')
      expect(f.servers).toHaveLength(1)
      expect(f.servers[0]!.listening).toBe(false)
    } finally { await f.close() }
  })

  it('closes the listener when authorization URL construction fails', async () => {
    const f = await fixture()
    try {
      globalThis.fetch = vi.fn(async () => Response.json({ token_endpoint: metadata.token_endpoint }))
      await expect(f.start()).rejects.toThrow('authorization_endpoint')
      expect(f.servers).toHaveLength(1)
      expect(f.servers[0]!.listening).toBe(false)
    } finally { await f.close() }
  })

  it('expires abandoned listeners without requiring a client poll', async () => {
    const f = await fixture()
    try {
      vi.useFakeTimers()
      const start = await f.gateway.oauthStart({ serverName: 'fixture', clientId: 'fixture-client', timeoutSeconds: 30 })
      expect(f.servers[0]!.listening).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.servers[0]!.listening).toBe(false)
      expect(await f.gateway.oauthPoll({ flowId: start.flowId })).toMatchObject({ status: 'failed' })
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(f.gateway.oauthPoll({ flowId: start.flowId })).rejects.toThrow('不存在')
    } finally { vi.useRealTimers(); await f.close() }
  })

  it('redeems a code once for overlapping polls and retains the same terminal answer', async () => {
    const f = await fixture()
    try {
      const start = await f.start()
      await f.authorize(start)
      const first = f.gateway.oauthPoll({ flowId: start.flowId })
      await f.tokenRequested.promise
      const second = f.gateway.oauthPoll({ flowId: start.flowId })
      expect(f.tokenCalls()).toBe(1)
      f.tokenResponse.resolve(Response.json({ access_token: 'fixture-access', expires_in: 3600 }))
      const result = await first
      expect(result).toMatchObject({ status: 'done' })
      expect(await second).toEqual(result)
      expect(await f.gateway.oauthPoll({ flowId: start.flowId })).toEqual(result)
      expect(f.headerWrites()).toBe(1)
      expect(f.servers[0]!.listening).toBe(false)
      expect(JSON.parse(await readFile(oauthFile(f.home), 'utf8')).servers.fixture.accessToken).toBe('fixture-access')
    } finally { await f.close() }
  })

  it('unload closes a pending flow and the retained gateway refuses new work', async () => {
    const f = await fixture()
    try {
      await f.start()
      await f.fiber.dispose()
      expect(f.servers[0]!.listening).toBe(false)
      await expect(f.start()).rejects.toThrow()
    } finally { await f.close() }
  })

  it('isolates flow identities between gateway instances', async () => {
    const f = await fixture()
    const otherCtx = new Context()
    const other = new McpManagerGateway(otherCtx)
    try {
      const start = await f.start()
      await expect(other.oauthPoll({ flowId: start.flowId })).rejects.toThrow('不存在')
    } finally { await otherCtx.fiber.dispose(); await f.close() }
  })

  it('cancels registration during unload before a flow can be published', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    try {
      globalThis.fetch = vi.fn(async (input, init) => {
        if (!String(input).endsWith('/register')) return Response.json(metadata)
        const signal = init?.signal
        assert.ok(signal)
        entered.resolve(undefined)
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => { cancelled.resolve(undefined); reject(signal.reason) }, { once: true })
        })
      })
      const started = f.gateway.oauthStart({ serverName: 'fixture' })
      const rejected = expect(started).rejects.toThrow('面板已卸载')
      await entered.promise
      await f.fiber.dispose()
      await cancelled.promise
      await rejected
      expect(f.servers[0]!.listening).toBe(false)
      expect(f.headerWrites()).toBe(0)
    } finally { await f.close() }
  })

  it('aborts and drains an in-flight exchange without writing a header', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    try {
      globalThis.fetch = vi.fn(async (input, init) => {
        if (!String(input).endsWith('/token')) return Response.json(metadata)
        const signal = init?.signal
        assert.ok(signal)
        entered.resolve(undefined)
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => { cancelled.resolve(undefined); reject(signal.reason) }, { once: true })
        })
      })
      const start = await f.start()
      await f.authorize(start)
      const poll = f.gateway.oauthPoll({ flowId: start.flowId })
      await entered.promise
      await f.fiber.dispose()
      await cancelled.promise
      expect(await poll).toMatchObject({ status: 'failed' })
      expect(f.headerWrites()).toBe(0)
      expect(f.servers[0]!.listening).toBe(false)
      await expect(readFile(oauthFile(f.home))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.close() }
  })

  it('keeps disposal pending until an admitted header write settles', async () => {
    const f = await fixture()
    const writing = Promise.withResolvers<undefined>()
    const finishWrite = Promise.withResolvers<undefined>()
    try {
      f.gateway.writeAuthHeader = async () => { writing.resolve(undefined); await finishWrite.promise }
      const start = await f.start()
      await f.authorize(start)
      const poll = f.gateway.oauthPoll({ flowId: start.flowId })
      await f.tokenRequested.promise
      f.tokenResponse.resolve(Response.json({ access_token: 'fixture-access' }))
      await writing.promise
      let disposed = false
      const disposing = f.fiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      finishWrite.resolve(undefined)
      await disposing
      expect(await poll).toMatchObject({ status: 'failed' })
      expect(f.servers[0]!.listening).toBe(false)
    } finally { finishWrite.resolve(undefined); await f.close() }
  })

  it('does not admit a patch write when unloading during its row lookup', async () => {
    const f = await fixture()
    const reading = Promise.withResolvers<undefined>()
    const finishRead = Promise.withResolvers<undefined>()
    try {
      const start = await f.start()
      await f.authorize(start)
      const readRows = f.gateway.readRows.bind(f.gateway)
      f.gateway.readRows = async () => { reading.resolve(undefined); await finishRead.promise; return readRows() }
      f.gateway.patchPath = () => join(f.home, 'patch-must-not-be-created.yml')
      f.gateway.writeAuthHeader = McpManagerGateway.prototype.writeAuthHeader
      const poll = f.gateway.oauthPoll({ flowId: start.flowId })
      await f.tokenRequested.promise
      f.tokenResponse.resolve(Response.json({ access_token: 'fixture-access' }))
      await reading.promise
      const disposing = f.fiber.dispose()
      finishRead.resolve(undefined)
      await disposing
      expect(await poll).toMatchObject({ status: 'failed' })
      await expect(readFile(f.gateway.patchPath())).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { finishRead.resolve(undefined); await f.close() }
  })
})
