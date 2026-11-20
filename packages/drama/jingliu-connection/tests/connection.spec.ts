import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import JingliuConnection, { type Config } from '../src/index.ts'
import { requestJson } from '@deepseek-ai/dsh-workbench-connection'
import { JINGLIU, studioOrigin } from '../src/http.ts'

afterEach(() => vi.unstubAllEnvs())

type Reply = [number, unknown]
const challenge = 'C'.repeat(43)

async function fixture(route: (req: IncomingMessage) => Reply | Promise<Reply>) {
  const requests: IncomingMessage[] = []
  const bodies: string[] = []
  const reply = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    requests.push(req)
    bodies.push(Buffer.concat(chunks).toString('utf8'))
    const [status, value] = await route(req)
    if (Buffer.isBuffer(value)) {
      res.writeHead(status, { 'content-type': 'image/png' })
      res.end(value)
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  const server = createServer((req, res) => { void reply(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  return { origin: 'http://127.0.0.1:' + String((server.address() as AddressInfo).port), requests, bodies }
}

async function mount(config: Config, loadAccount = true) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const commands = new Map<string, CommandDefinition>()
  const account = { id: 'muse-login-a' }
  const grant = vi.fn(async (audience: string, proof: string) => {
    expect(audience).toBe('jingliu')
    expect(proof).toBe(challenge)
    return { code: 'once-' + account.id, expiresIn: 60, accountId: account.id }
  })
  const mounted = vi.fn(async (_audience: string, _owner: string, url: URL, init: RequestInit) => await fetch(url, init))
  class Commands extends Service {
    constructor(parent: Context) { super(parent, 'commands') }
    register(command: CommandDefinition) {
      commands.set(command.name, command)
      return () => commands.delete(command.name)
    }
  }
  class Account extends Service {
    constructor(parent: Context) { super(parent, 'museAccount') }
    async workbenchIdentity() {
      if (!account.id) throw Object.assign(new Error('signed out'), { code: 'invalid-credentials' })
      return account.id
    }
    workbenchGrant = grant
    requestMountedWorkbench = mounted
  }
  await ctx.plugin(Commands).await()
  if (loadAccount) await ctx.plugin(Account).await()
  const fiber = ctx.plugin(JingliuConnection, config)
  await fiber.await()
  const command = async (name: string, owner: string) => {
    const definition = commands.get(name)
    if (!definition) throw new Error('Missing command')
    return await definition.handler({
      agent: { session: { id: owner } }, rawInput: '', signal: new AbortController().signal,
    } as CommandInvocation)
  }
  return { ctx, commands, command, account, grant, mounted, fiber }
}

function authenticated(req: IncomingMessage): Reply {
  switch (req.url) {
    case '/fwp/v2/auth/muse/challenge': return [200, { challenge, requestId: 'request' }]
    case '/fwp/v2/auth/muse/exchange': return [200, { token: 'private-session', user: { id: 45 } }]
    case '/fwp/v2/desktop-agent/tools': return [200, { tools: [] }]
    case '/fwp/v2/auth/logout': return [200, {}]
    default: return [404, {}]
  }
}

it('exchanges a Muse login once across concurrent tools and the login command and revokes the scoped connection', async () => {
  const { origin, requests, bodies } = await fixture(authenticated)
  const { ctx, commands, command, grant, fiber } = await mount({ studioOrigin: origin })
  const [scope, second, result] = await Promise.all([ctx.jingliuConnection.connection(), ctx.jingliuConnection.connection(), command('jingliu-login', 'a')])
  expect(scope).toBe(second)
  expect(result.text).toBe('已使用当前 Muse 账号连接镜流。')
  expect(await scope.request('/desktop-agent/tools')).toEqual({ tools: [] })
  expect(requests.map(req => [req.url, req.method])).toEqual([
    ['/fwp/v2/auth/muse/challenge', 'POST'], ['/fwp/v2/auth/muse/exchange', 'POST'], ['/fwp/v2/desktop-agent/tools', 'GET'],
  ])
  expect(requests.map(req => req.headers.authorization)).toEqual([undefined, undefined, 'Bearer private-session'])
  expect(JSON.parse(bodies[1]!)).toEqual({ requestId: 'request', code: 'once-muse-login-a' })
  expect(grant).toHaveBeenCalledTimes(1)
  await command('jingliu-logout', 'a')
  await expect(scope.request('/desktop-agent/tools')).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  expect(requests.length).toBe(4)
  const next = await ctx.jingliuConnection.connection()
  expect(next.identity).toBe(scope.identity)
  expect(grant).toHaveBeenCalledTimes(2)
  await fiber.dispose()
  expect(commands.size).toBe(0)
})

it('stops signed-out and switched accounts before a workflow write and discards a response after an account switch', async () => {
  const started = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const { origin, requests } = await fixture(async (req) => {
    if (req.url === '/fwp/v2/projects') {
      started.resolve(undefined)
      await finish.promise
      return [200, { privateProject: 'original' }]
    }
    return authenticated(req)
  })
  const { ctx, account } = await mount({ studioOrigin: origin })
  const scope = await ctx.jingliuConnection.connection()
  const pending = scope.request('/projects')
  await started.promise
  account.id = 'muse-login-b'
  finish.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  await expect(scope.request('/jobs', { method: 'POST' })).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  expect(requests.length).toBe(3)
  const next = await ctx.jingliuConnection.connection()
  expect(next).not.toBe(scope)
  account.id = ''
  await expect(next.request('/jobs', { method: 'POST' })).rejects.toMatchObject({ code: 'JINGLIU_SIGN_IN_REQUIRED' })
  expect(requests.map(req => req.url)).not.toContain('/fwp/v2/jobs')
})

it('discards the in-memory tool session when Muse announces a login change', async () => {
  const { origin, requests } = await fixture(authenticated)
  const { ctx, grant } = await mount({ studioOrigin: origin })
  const original = await ctx.jingliuConnection.connection()
  ctx.emit('muse-account/session-changed')
  await expect(original.request('/jobs', { method: 'POST' })).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  expect(requests).toHaveLength(2)
  await ctx.jingliuConnection.connection()
  expect(grant).toHaveBeenCalledTimes(2)
})

it('rejects an account change while issuing a grant before the exchange and recovers for the new login', async () => {
  const { origin, requests } = await fixture(authenticated)
  const { ctx, grant, account } = await mount({ studioOrigin: origin })
  grant.mockImplementationOnce(async () => {
    account.id = 'new-login'
    return { code: 'once', expiresIn: 60, accountId: account.id }
  })
  await expect(ctx.jingliuConnection.connection()).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  expect(requests.map(req => req.url)).toEqual(['/fwp/v2/auth/muse/challenge'])
  expect(await ctx.jingliuConnection.connection()).toHaveProperty('identity')
})

it('reports missing Muse login without contacting the workbench and rejects malformed workbench challenges', async () => {
  const { origin, requests } = await fixture(() => [200, { challenge: 'malformed', requestId: 'request' }])
  const missing = await mount({ studioOrigin: origin }, false)
  await expect(missing.ctx.jingliuConnection.connection()).rejects.toMatchObject({ code: 'JINGLIU_SIGN_IN_REQUIRED' })
  expect(requests).toHaveLength(0)
  const { ctx, grant } = await mount({ studioOrigin: origin })
  await expect(ctx.jingliuConnection.connection()).rejects.toMatchObject({ code: 'JINGLIU_INVALID_CHALLENGE' })
  expect(grant).not.toHaveBeenCalled()
})

it('does not expose a grant echoed in a failed login response', async () => {
  const { origin } = await fixture(req => req.url === '/fwp/v2/auth/muse/exchange'
    ? [403, { detail: { code: 'once-muse-login-a', message: 'once-muse-login-a rejected' } }] : authenticated(req))
  const { ctx } = await mount({ studioOrigin: origin })
  await expect(ctx.jingliuConnection.connection()).rejects.toMatchObject({
    status: 403, code: 'JINGLIU_MUSE_EXCHANGE_FAILED', message: '镜流未授权当前 Muse 账号，请管理员核对账号绑定和角色。',
  })
})

it('renews a rejected tool token on the next connection without replaying a mutation', async () => {
  const { origin, requests } = await fixture(req => req.url === '/fwp/v2/jobs' ? [401, {}] : authenticated(req))
  const { ctx, grant } = await mount({ studioOrigin: origin })
  const scope = await ctx.jingliuConnection.connection()
  await expect(scope.request('/jobs', { method: 'POST' })).rejects.toMatchObject({ status: 401 })
  await expect(scope.request('/jobs', { method: 'POST' })).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  await ctx.jingliuConnection.connection()
  expect(grant).toHaveBeenCalledTimes(2)
  expect(requests.filter(req => req.url === '/fwp/v2/jobs')).toHaveLength(1)
})

it('stops a previously approved request on a changed local session', async () => {
  vi.stubEnv('MUSE_JINGLIU_SESSION_TOKEN', 'first-session')
  const { origin, requests } = await fixture(() => [200, { user: { id: 7 } }])
  const { ctx } = await mount({ studioOrigin: origin, localPreviewToken: true })
  const scope = await ctx.jingliuConnection.connection()
  vi.stubEnv('MUSE_JINGLIU_SESSION_TOKEN', 'second-session')
  await expect(scope.request('/desktop-agent/tool', { method: 'POST' })).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  expect(requests.length).toBe(1)
})

it('preserves an upstream confirmation requirement and confines authenticated routes to the configured deployment', async () => {
  const { origin, requests } = await fixture(() => [409, { detail: { code: 'needs_confirm', message: '替换剧本？' } }])
  await expect(requestJson(JINGLIU, origin + '/fwp/v2', '/desktop-agent/tool', 1000)).rejects.toMatchObject({ status: 409, code: 'needs_confirm', message: '替换剧本？' })
  await expect(requestJson(JINGLIU, origin + '/fwp/v2', '/../other', 1000)).rejects.toMatchObject({ code: 'JINGLIU_PATH_INVALID' })
  expect(requests.length).toBe(1)
  expect(() => studioOrigin('http://jingliu.test')).toThrow()
  expect(() => studioOrigin('https://user@jingliu.test')).toThrow()
})

it('reads routes and media of the studio mounted on the Muse gateway with the Muse login', async () => {
  const png = Buffer.from('png-bytes')
  const { origin, requests } = await fixture((req) => {
    switch (req.url) {
      case '/jingliu/fwp/v2/auth/me': return [200, { user: { id: 45 } }]
      case '/jingliu/fwp/v2/projects': return [200, { projects: [] }]
      case '/jingliu/fwp/media/a.png': return [200, png]
      case '/jingliu/fwp/media/b.png': return [200, { not: 'an image' }]
      default: return [404, {}]
    }
  })
  const { ctx, command, grant, mounted } = await mount({ studioOrigin: origin + '/jingliu' })
  const signal = new AbortController().signal
  const scope = await ctx.jingliuConnection.connection()
  expect(await scope.request('/projects')).toEqual({ projects: [] })
  expect(await ctx.jingliuConnection.thumbnail('/fw/media/a.png', signal)).toBe('data:image/png;base64,' + png.toString('base64'))
  await expect(ctx.jingliuConnection.thumbnail('/fwp/media/b.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_MEDIA' })
  await expect(ctx.jingliuConnection.thumbnail('/fw/media/missing.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_UNAVAILABLE', status: 404 })
  await expect(ctx.jingliuConnection.thumbnail('/other/a.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_MEDIA' })
  expect(grant).not.toHaveBeenCalled()
  expect(mounted.mock.calls.map(([audience, owner, url]) => [audience, owner, url.pathname])).toEqual([
    ['jingliu', 'muse-login-a', '/jingliu/fwp/v2/auth/me'], ['jingliu', 'muse-login-a', '/jingliu/fwp/v2/projects'],
    ['jingliu', 'muse-login-a', '/jingliu/fwp/media/a.png'], ['jingliu', 'muse-login-a', '/jingliu/fwp/media/b.png'],
    ['jingliu', 'muse-login-a', '/jingliu/fwp/media/missing.png'],
  ])
  expect(requests.map(req => req.headers.authorization)).toEqual([undefined, undefined, undefined, undefined, undefined])
  expect((await command('jingliu-logout', 'a')).text).toBe('本次镜流工具连接已结束。下次调用会使用当前 Muse 账号。')
  expect(requests).toHaveLength(5)
  await expect(scope.request('/projects')).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
})
