import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import JingliuConnection, { type Config } from '../src/index.ts'
import { requestJson } from '@deepseek-ai/dsh-workbench-connection/transport'
import { isRecord, JINGLIU, studioOrigin } from '../src/http.ts'
import { readSelection } from '../src/project-selection.ts'

afterEach(() => vi.unstubAllEnvs())

type Reply = [number, unknown, (string | null)?]
const challenge = 'C'.repeat(43)

async function fixture(route: (req: IncomingMessage, body: string) => Reply | Promise<Reply>) {
  const requests: IncomingMessage[] = []
  const bodies: string[] = []
  const reply = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    requests.push(req)
    const body = Buffer.concat(chunks).toString('utf8')
    bodies.push(body)
    const [status, value, contentType = 'image/png'] = await route(req, body)
    if (Buffer.isBuffer(value)) {
      res.writeHead(status, contentType === null ? {} : { 'content-type': contentType })
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
  const identify = vi.fn(async () => {
    if (!account.id) throw Object.assign(new Error('signed out'), { code: 'invalid-credentials' })
    return account.id
  })
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
    workbenchIdentity = identify
    workbenchGrant = grant
    requestMountedWorkbench = mounted
  }
  await ctx.plugin(Commands).await()
  if (loadAccount) await ctx.plugin(Account).await()
  const fiber = ctx.plugin(JingliuConnection, config)
  await fiber.await()
  const command = async (name: string, owner: string, rawInput = '') => {
    const definition = commands.get(name)
    if (!definition) throw new Error('Missing command')
    return await definition.handler({
      agent: { session: { id: owner } }, rawInput, signal: new AbortController().signal,
    } as CommandInvocation)
  }
  return { ctx, commands, command, account, identify, grant, mounted, fiber }
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

it('reads routes and media of the studio mounted on the Muse gateway with the Muse login, through the Host when the studio cannot resolve media', async () => {
  const png = Buffer.from('png-bytes')
  const { origin, requests } = await fixture((req) => {
    switch (req.url) {
      case '/jingliu/fwp/v2/auth/me': return [200, { user: { id: 45 } }]
      case '/jingliu/fwp/v2/projects': return [200, { projects: [] }]
      case '/jingliu/fwp/media/generated/a.png': return [200, png]
      case '/jingliu/fwp/media/generated/b.png': return [200, { not: 'an image' }]
      default: return [404, {}]
    }
  })
  const { ctx, command, grant, mounted } = await mount({ studioOrigin: origin + '/jingliu' })
  const signal = new AbortController().signal
  const scope = await ctx.jingliuConnection.connection()
  expect(await scope.request('/projects')).toEqual({ projects: [] })
  expect(await ctx.jingliuConnection.thumbnail('/fw/media/generated/a.png', signal)).toEqual({ kind: 'inline', url: 'data:image/png;base64,' + png.toString('base64') })
  await expect(ctx.jingliuConnection.thumbnail('/fwp/media/generated/b.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_MEDIA' })
  await expect(ctx.jingliuConnection.thumbnail('/fw/media/generated/missing.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_NOT_FOUND' })
  await expect(ctx.jingliuConnection.thumbnail('/other/a.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_MEDIA' })
  expect(grant).not.toHaveBeenCalled()
  expect(mounted.mock.calls.map(([audience, owner, url]) => [audience, owner, url.pathname])).toEqual([
    ['jingliu', 'muse-login-a', '/jingliu/fwp/v2/auth/me'], ['jingliu', 'muse-login-a', '/jingliu/fwp/v2/projects'],
    ['jingliu', 'muse-login-a', '/jingliu/fwp/v2/media/resolve'], ['jingliu', 'muse-login-a', '/jingliu/fwp/media/generated/a.png'], ['jingliu', 'muse-login-a', '/jingliu/fwp/media/generated/b.png'],
    ['jingliu', 'muse-login-a', '/jingliu/fwp/media/generated/missing.png'],
  ])
  expect(requests.map(req => req.headers.authorization)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
  expect((await command('jingliu-logout', 'a')).text).toBe('本次镜流工具连接已结束。下次调用会使用当前 Muse 账号。')
  expect(requests).toHaveLength(6)
  await expect(scope.request('/projects')).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
})

const accountBalance = { unlimited: false, available_yuan: '12.50', used_fen: 250, held_fen: 125, enforced: false }
const time = '2026-11-20T12:00:00+00:00'
const hold = { ts: time, entry: 'hold', amount_fen: -125, note: 'Internal note' }

it('reads the signed-in user’s Jingliu balance and projects their newest ledger entries', async () => {
  const { origin, requests, bodies } = await fixture((req) => {
    switch (req.url) {
      case '/jingliu/fwp/v2/auth/me': return [200, { user: { id: 45 } }]
      case '/jingliu/fwp/v2/budget/me': return [200, accountBalance]
      case '/jingliu/fwp/v2/budget/users/45': return [200, { user_id: 45, ledger: [
        hold, { ts: time, entry: 'settle', amount_fen: 25 }, { ts: time, entry: 'private marker', amount_fen: 0 },
        ...Array.from({ length: 50 }, () => hold),
      ] }]
      default: return [404, {}]
    }
  })
  const { ctx, mounted } = await mount({ studioOrigin: origin + '/jingliu' })
  const details = await ctx.jingliuConnection.billingDetails(new AbortController().signal)
  expect(details.balance).toEqual({ unlimited: false, available: '12.50', usedFen: 250, heldFen: 125, enforced: false })
  expect(details.ledger?.slice(0, 3)).toEqual([
    { time, kind: 'hold', amountFen: -125 }, { time, kind: 'settle', amountFen: 25 }, { time, kind: 'other', amountFen: 0 },
  ])
  expect(details.ledger).toHaveLength(50)
  expect(requests.map(req => [req.method, req.url])).toEqual([
    ['GET', '/jingliu/fwp/v2/auth/me'],
    ['GET', '/jingliu/fwp/v2/auth/me'],
    ['GET', '/jingliu/fwp/v2/budget/me'],
    ['GET', '/jingliu/fwp/v2/budget/users/45'],
  ])
  expect(bodies).toEqual(['', '', '', ''])
  expect(mounted.mock.calls.map(([, owner]) => owner)).toEqual(Array(4).fill('muse-login-a'))
})

it('keeps a balance with a missing ledger and rejects an unverified or invalid detail response', async () => {
  let budget: Reply = [404, {}]
  const { origin } = await fixture((req) => {
    switch (req.url) {
      case '/jingliu/fwp/v2/auth/me': return [200, { user: { id: 45 } }]
      case '/jingliu/fwp/v2/budget/me': return [200, accountBalance]
      case '/jingliu/fwp/v2/budget/users/45': return budget
      default: return [404, {}]
    }
  })
  const { ctx } = await mount({ studioOrigin: origin + '/jingliu' })
  const signal = new AbortController().signal
  await expect(ctx.jingliuConnection.billingDetails(signal)).resolves.toMatchObject({ ledger: null })
  budget = [200, { user_id: 45, ledger: [] }]
  await expect(ctx.jingliuConnection.billingDetails(signal)).resolves.toMatchObject({ ledger: [] })
  budget = [200, { user_id: 46, ledger: [] }]
  await expect(ctx.jingliuConnection.billingDetails(signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
  budget = [200, { user_id: 45, ledger: [{ ...hold, amount_fen: 0.5 }] }]
  await expect(ctx.jingliuConnection.billingDetails(signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
  budget = [403, {}]
  await expect(ctx.jingliuConnection.billingDetails(signal)).rejects.toMatchObject({ status: 403 })
})

it('discards a Jingliu ledger when the Muse login changes during the read', async () => {
  const started = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const { origin } = await fixture(async (req) => {
    switch (req.url) {
      case '/jingliu/fwp/v2/auth/me': return [200, { user: { id: 45 } }]
      case '/jingliu/fwp/v2/budget/me': return [200, accountBalance]
      case '/jingliu/fwp/v2/budget/users/45': {
        started.resolve(undefined)
        await finish.promise
        return [200, { user_id: 45, ledger: [hold] }]
      }
      default: return [404, {}]
    }
  })
  const { ctx, account } = await mount({ studioOrigin: origin + '/jingliu' })
  const result = ctx.jingliuConnection.billingDetails(new AbortController().signal)
  await started.promise
  account.id = 'muse-login-b'
  finish.resolve(undefined)
  await expect(result).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
})

it('keeps thumbnails in the account cache and plays videos from the conversation workspace only on a Host with local media', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jingliu-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'jingliu-workspace-'))
  onTestFinished(async () => { await Promise.all([home, workspace].map(path => rm(path, { recursive: true, force: true }))) })
  vi.stubEnv('DSH_HOME', home)
  const png = Buffer.from('png-bytes')
  const mp4 = Buffer.from('mp4-bytes')
  const uploaded = { path: '/fw/media/uploads/story.png', size: png.length }
  let base = ''
  const { origin, requests, bodies } = await fixture((req) => {
    switch (req.url) {
      case '/jingliu/fwp/v2/auth/me': return [200, { user: { id: 45 } }]
      case '/jingliu/fwp/v2/media/resolve': return [200, { items: [
        { path: '/fw/media/generated/a.png', url: base + '/tos/a.png', size: png.length, etag: 'multi-2', content_type: 'image/png' },
        { path: '/fw/media/generated/v.mp4', url: base + '/tos/v.mp4', size: mp4.length, etag: 'multi-2', content_type: 'video/mp4' },
        { path: '/fw/media/generated/fallback.png', url: 'https://storage.invalid/fallback.png', size: png.length, etag: 'multi-2', content_type: 'image/png' },
      ] }]
      case '/jingliu/fwp/media/generated/fallback.png': return [200, png]
      case '/jingliu/fwp/v2/media/upload-url': return [200, { upload_url: base + '/tos/upload', path: uploaded.path, token: 'story-upload' }]
      case '/jingliu/fwp/v2/media/upload-complete': return [200, uploaded]
      case '/tos/upload': return [200, {}]
      case '/tos/a.png': return [200, png]
      case '/tos/v.mp4': return [200, mp4]
      default: return [404, {}]
    }
  })
  base = origin
  const { ctx } = await mount({ studioOrigin: origin + '/jingliu', localMedia: true, mediaHosts: [new URL(origin).host] })
  const signal = new AbortController().signal
  const request = { sessionId: SessionId('s1'), projectId: 'p1', path: '/fw/media/generated/v.mp4' }
  await expect(ctx.jingliuConnection.localVideo(request, signal)).rejects.toMatchObject({ code: 'JINGLIU_SESSION_REQUIRED' })
  const gone = new Error('Conversation was deleted')
  let cwd: string | undefined = workspace
  let deleted = false
  class Controller extends Service {
    constructor(parent: Context) { super(parent, 'sessionController') }
    resolveAgent = async () => deleted ? { error: gone } : { agent: { session: { header: { cwd } } } }
  }
  await ctx.plugin(Controller).await()
  const scope = await ctx.jingliuConnection.connection()
  const identity = scope.identity
  const thumbnail = join(home, 'jingliu', 'media', identity.slice(0, 32), 'generated', 'a.png')
  expect(await ctx.jingliuConnection.thumbnail('/fw/media/generated/a.png', signal)).toEqual({ kind: 'file', path: thumbnail })
  expect(await readFile(thumbnail)).toEqual(png)
  const count = requests.length
  expect(await ctx.jingliuConnection.thumbnail('/fwp/media/generated/a.png', signal)).toEqual({ kind: 'file', path: thumbnail })
  expect(requests).toHaveLength(count)
  deleted = true
  await expect(ctx.jingliuConnection.localVideo(request, signal)).rejects.toBe(gone)
  deleted = false
  cwd = undefined
  await expect(ctx.jingliuConnection.localVideo(request, signal)).resolves.toBeNull()
  cwd = workspace
  const video = join(workspace, 'jingliu', 'p1', 'generated', 'v.mp4')
  expect(await ctx.jingliuConnection.localVideo(request, signal)).toBe(video)
  expect(await readFile(video)).toEqual(mp4)
  await expect(ctx.jingliuConnection.localVideo({ ...request, path: '/fw/media/generated/a.png' }, signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_MEDIA' })
  await expect(ctx.jingliuConnection.localVideo({ ...request, projectId: '../p' }, signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
  await expect(ctx.jingliuConnection.thumbnail('/fw/media/generated/v.mp4', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_MEDIA' })
  if (!scope.media || !scope.download || !scope.place || !scope.upload) throw new Error('Local media capabilities are missing')
  await scope.media('/fw/media/generated/a.png', signal, async (response) => {
    expect(response.headers.get('content-type')).toBe('image/png')
  })
  const [saved] = (await scope.download([request.path], join(workspace, 'jingliu', 'p1'), signal)).values()
  if (!saved) throw new Error('Downloaded file is missing')
  expect(saved.file).toBe(video)
  const copy = join(workspace, 'view.mp4')
  await scope.place(saved, copy)
  expect(await readFile(copy)).toEqual(mp4)
  await expect(scope.upload(thumbnail, 'p1', signal)).resolves.toEqual(uploaded)
  expect(requests.slice(-3).map(req => [req.method, req.url])).toEqual([
    ['POST', '/jingliu/fwp/v2/media/upload-url'], ['PUT', '/tos/upload'], ['POST', '/jingliu/fwp/v2/media/upload-complete'],
  ])
  expect(bodies.at(-2)).toBe(png.toString('utf8'))

  const web = await mount({ studioOrigin: origin + '/jingliu', mediaHosts: [new URL(origin).host] })
  expect(await web.ctx.jingliuConnection.localVideo(request, signal)).toBeNull()
  expect(typeof (await web.ctx.jingliuConnection.connection()).download).toBe('undefined')
  await expect(web.ctx.jingliuConnection.thumbnail('/fw/media/generated/fallback.png', signal)).resolves.toEqual({
    kind: 'inline', url: 'data:image/png;base64,' + png.toString('base64'),
  })
  expect(requests.at(-1)?.url).toBe('/jingliu/fwp/media/generated/fallback.png')
})

it('creates and renames projects with the signed-in account and the current studio catalog', async () => {
  const customized = { id: 'film-2', title: '雨夜' }
  const withDefaults = { id: 'film-3', title: '晴天' }
  let created = 0
  const { origin, requests, bodies } = await fixture((req) => {
    switch (req.url) {
      case '/fwp/v2/projects':
        if (req.method === 'POST') {
          created += 1
          return [201, created === 1 ? customized : withDefaults]
        }
        return [200, { projects: [{ id: 'film-1', title: '灯火', episodes_count: 1, shots_total: 3, shots_done: 2, my_role: 'owner' }] }]
      case '/fwp/v2/production-modes': return [200, { modes: { drama: { styles: [{ key: 'urban' }] } }, aspects: ['9:16'], resolutions: ['1080p'] }]
      case '/fwp/v2/providers/image': return [200, { models: [{ id: 'ink' }] }]
      case '/fwp/v2/providers/video': return [200, { providers: [{ model_id: 'seed' }], generation_modes: { reference: '参考' } }]
      case '/fwp/v2/projects/film-2': return [200, { title: '暴雨夜' }]
      default: return authenticated(req)
    }
  })
  const { ctx } = await mount({ studioOrigin: origin })
  const api = ctx.jingliuConnection
  const { signal } = new AbortController()
  const input = { title: ' 雨夜 ', mode: 'drama', artStyle: 'urban', aspect: '9:16', resolution: '1080p', videoModel: 'seed', imageModel: 'ink', generationMode: 'reference' }

  await expect(api.listProjects(signal)).resolves.toMatchObject([{ id: 'film-1', title: '灯火', episodes: 1, shots: 3, completed: 2, role: 'owner' }])
  await expect(api.createProject({ ...input, title: ' ' }, signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
  await expect(api.createProject({ ...input, videoModel: 'withdrawn' }, signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
  await expect(api.createProject(input, signal)).resolves.toEqual(customized)
  await expect(api.createProject({ title: '晴天', mode: input.mode, artStyle: '', aspect: '', resolution: '', videoModel: '', imageModel: '', generationMode: '' }, signal))
    .resolves.toEqual(withDefaults)
  await expect(api.renameProject('film-2', ' 暴雨夜 ', signal)).resolves.toEqual({ id: 'film-2', title: '暴雨夜' })
  await expect(api.renameProject('film-2', ' 未确认 ', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
  await expect(api.renameProject('film-2', ' ', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })

  const writes = requests.flatMap((req, index) => req.headers.authorization && req.method !== 'GET'
    ? [[req.method, req.url, req.headers.authorization, JSON.parse(bodies[index]!)]] : [])
  expect(writes).toEqual([
    ['POST', '/fwp/v2/projects', 'Bearer private-session', { title: '雨夜', production_mode: 'drama', art_style: 'urban', base_aspect: '9:16',
      custom_settings: { video_model: 'seed', image_model: 'ink', generation_mode: 'reference', resolution: '1080p' } }],
    ['POST', '/fwp/v2/projects', 'Bearer private-session', { title: '晴天', production_mode: 'drama' }],
    ['PATCH', '/fwp/v2/projects/film-2', 'Bearer private-session', { title: '暴雨夜' }],
    ['PATCH', '/fwp/v2/projects/film-2', 'Bearer private-session', { title: '未确认' }],
  ])
})

it('sends shared library filters and pagination without forwarding invalid queries', async () => {
  const { origin, requests } = await fixture(req => req.url?.startsWith('/fwp/v2/library?') ? [200, {
    total: 1, items: [{ asset_id: 'asset-1', kind: 'prop', name: '桥灯', uses: 2, reference_only: true }],
  }] : authenticated(req))
  const { ctx } = await mount({ studioOrigin: origin })
  const api = ctx.jingliuConnection
  const { signal } = new AbortController()
  await expect(api.sharedAssets({ kind: 'prop', query: '灯 & 笼', offset: 24 }, signal)).resolves.toMatchObject({
    total: 1, items: [{ id: 'asset-1', name: '桥灯', kind: 'prop', referenceOnly: true, uses: 2 }],
  })
  await api.sharedAssets({ kind: 'all', query: '', offset: 0 }, signal)
  for (const [offset, query] of [[-1, ''], [0.5, ''], [0, '灯'.repeat(201)]] as const) {
    await expect(api.sharedAssets({ kind: 'all', query, offset }, signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
  }
  const filters = requests.slice(2).map(req => Object.fromEntries(new URL(req.url ?? '/', origin).searchParams))
  expect(filters).toEqual([{ limit: '24', offset: '24', q: '灯 & 笼', sort: 'uses', kind: 'prop' },
    { limit: '24', offset: '0', q: '', sort: 'uses' }])
})

it('writes only the changed project setting and confirms its stored value', async () => {
  const root = '/fwp/v2/projects/film-1'
  let hidePromptChips = false
  let character = 'pencil'
  let resolution = '720p'
  let studioSavesResolution = true
  const { origin, requests, bodies } = await fixture((req) => {
    switch (req.url) {
      case root + '/prefs':
        if (req.method === 'PUT') hidePromptChips = true
        return [200, { project_id: 'film-1', prefs: { prompt_chips_hidden: hidePromptChips } }]
      case root + '/image-model':
        if (req.method === 'PUT') character = 'ink'
        return [200, { by_kind: { character, location: 'pencil' }, models: [{ id: 'ink' }, { id: 'pencil' }] }]
      case root + '/resolution':
        if (req.method === 'PUT' && studioSavesResolution) resolution = '1080p'
        return [200, { resolution, tiers: ['720p', '1080p'] }]
      default: return authenticated(req)
    }
  })
  const { ctx } = await mount({ studioOrigin: origin })
  const api = ctx.jingliuConnection
  const { signal } = new AbortController()
  const preferences = { projectId: 'film-1', hidePromptChips: true }
  await expect(api.preferences('film-1', signal)).resolves.toEqual({ ...preferences, hidePromptChips: false })
  await expect(api.savePreferences(preferences, signal)).resolves.toEqual(preferences)
  await expect(api.saveOption('film-1', 'character', 'ink', signal)).resolves.toMatchObject({ character: 'ink', location: 'pencil' })
  await expect(api.saveOption('film-1', 'resolution', '1080p', signal)).resolves.toMatchObject({ resolution: '1080p' })
  studioSavesResolution = false
  await expect(api.saveOption('film-1', 'resolution', '', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
  await expect(api.saveOption('film-1', 'character', 'withdrawn', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
  expect(requests.flatMap((req, index) => req.method === 'PUT' ? [[req.url, JSON.parse(bodies[index]!)]] : [])).toEqual([
    [root + '/prefs', { prefs: { prompt_chips_hidden: true } }],
    [root + '/image-model', { models: { character: 'ink' } }],
    [root + '/resolution', { resolution: '1080p' }],
    [root + '/resolution', { resolution: '' }],
  ])
})

async function selectionHome() {
  const home = await mkdtemp(join(tmpdir(), 'jingliu-selection-'))
  vi.stubEnv('DSH_HOME', home)
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
}

it('shares a confirmed project with its assigned worker and hides it from another studio owner', async () => {
  await selectionHome()
  const film = { id: 'film-1', title: '灯火' }
  const otherFilm = { id: 'film-2', title: '雨夜' }
  let studioUser = 45
  const { origin } = await fixture((req) => {
    switch (req.url) {
      case '/jingliu/fwp/v2/auth/me': return [200, { user: { id: studioUser } }]
      case '/jingliu/fwp/v2/projects/film-1': return [200, film]
      case '/jingliu/fwp/v2/projects/film-2': return [200, otherFilm]
      default: return [404, {}]
    }
  })
  const { ctx, account } = await mount({ studioOrigin: origin + '/jingliu' })
  const inject = vi.fn<(message: UserMessage) => void>()
  const resolveAgent = vi.fn(async (_sessionId: SessionId) => ({ agent: { inject } }))
  await ctx.plugin(class Controller extends Service {
    constructor(parent: Context) { super(parent, 'sessionController') }
    resolveAgent = resolveAgent
  }).await()
  const api = ctx.jingliuConnection
  const router = SessionId('routing-session')
  const worker = SessionId('worker-session')
  const lifetime = new AbortController()
  const stream = api.watchProject(router, lifetime.signal)[Symbol.asyncIterator]()
  const workerStream = api.watchProject(worker, lifetime.signal)[Symbol.asyncIterator]()
  onTestFinished(async () => { lifetime.abort(); await Promise.all([stream.return?.(), workerStream.return?.()]) })
  const firstAccount = await api.connection()

  await expect(stream.next()).resolves.toEqual({ value: null, done: false })
  await expect(workerStream.next()).resolves.toEqual({ value: null, done: false })
  await expect(api.assignmentProject(router)).resolves.toBeNull()
  await expect(api.selectProject(router, film.id, lifetime.signal)).resolves.toEqual(film)
  await expect(stream.next()).resolves.toEqual({ value: film, done: false })
  expect(resolveAgent).toHaveBeenCalledWith(router)
  expect(inject).toHaveBeenCalledTimes(1)
  const message = inject.mock.calls[0]?.[0]
  expect(message?.source).toMatchObject({ kind: 'jingliu-project', form: 'notice' })
  const content = message?.content[0]
  expect(content?.type === 'text' && JSON.parse(content.text)).toMatchObject({ jingliu_project: film })

  const assignment = await api.assignmentProject(router)
  expect(assignment).toEqual({ ...film, owner: firstAccount.identity })
  if (!assignment) throw new Error('Project assignment is missing')
  await api.inheritProject(worker, assignment)
  await expect(workerStream.next()).resolves.toEqual({ value: film, done: false })
  await api.inheritProject(worker, assignment)
  await expect(api.assignmentProject(worker)).resolves.toEqual(assignment)
  await api.selectProject(worker, otherFilm.id, lifetime.signal)
  await expect(workerStream.next()).resolves.toEqual({ value: otherFilm, done: false })
  await expect(api.inheritProject(worker, assignment)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })

  account.id = 'muse-login-b'
  studioUser = 46
  ctx.emit('muse-account/session-changed')
  await expect(stream.next()).resolves.toEqual({ value: null, done: false })
  await expect(api.assignmentProject(router)).resolves.toBeNull()
  await expect(api.inheritProject(SessionId('new-worker'), assignment)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
  account.id = 'muse-login-a'
  studioUser = 45
  ctx.emit('muse-account/session-changed')
  await expect(stream.next()).resolves.toEqual({ value: film, done: false })

  const closed = stream.next()
  lifetime.abort()
  await expect(closed).resolves.toMatchObject({ done: true })
})

it('never confirms a project from the previous account when resolving the conversation overlaps a login change', async () => {
  await selectionHome()
  const film = { id: 'film-1', title: '灯火' }
  const { origin } = await fixture(req => req.url === '/fwp/v2/projects/film-1' ? [200, film] : authenticated(req))
  const { ctx, account } = await mount({ studioOrigin: origin })
  const started = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  onTestFinished(() => { resume.resolve(undefined) })
  const inject = vi.fn()
  await ctx.plugin(class Controller extends Service {
    constructor(parent: Context) { super(parent, 'sessionController') }
    async resolveAgent() {
      started.resolve(undefined)
      await resume.promise
      return { agent: { inject } }
    }
  }).await()
  const { signal } = new AbortController()
  const session = SessionId('routing-session')
  const pending = ctx.jingliuConnection.selectProject(session, film.id, signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  await started.promise
  account.id = 'muse-login-b'
  ctx.emit('muse-account/session-changed')
  resume.resolve(undefined)
  await rejected
  await expect(readSelection(session)).resolves.toBeNull()
  expect(inject).not.toHaveBeenCalled()
})

it('withholds the confirmation notice when the login changes after storing the original owner’s selection', async () => {
  await selectionHome()
  const film = { id: 'film-1', title: '灯火' }
  let userId = 45
  const { origin } = await fixture((req) => {
    switch (req.url) {
      case '/jingliu/fwp/v2/auth/me': return [200, { user: { id: userId } }]
      case '/jingliu/fwp/v2/projects/film-1': return [200, film]
      default: return [404, {}]
    }
  })
  const { ctx, account, identify } = await mount({ studioOrigin: origin + '/jingliu' })
  const api = ctx.jingliuConnection
  const session = SessionId('routing-session')
  const before = await api.connection()
  const inject = vi.fn<(message: UserMessage) => void>()
  await ctx.plugin(class Controller extends Service {
    constructor(parent: Context) { super(parent, 'sessionController') }
    async resolveAgent() {
      identify.mockImplementationOnce(async () => account.id).mockImplementationOnce(async () => {
        const saved = await readSelection(session)
        if (saved?.owner === before.identity) {
          account.id = 'muse-login-b'
          userId = 46
          ctx.emit('muse-account/session-changed')
        }
        return account.id
      })
      return { agent: { inject } }
    }
  }).await()

  await expect(api.selectProject(session, film.id, new AbortController().signal)).rejects.toMatchObject({ code: 'JINGLIU_ACCOUNT_CHANGED' })
  await expect(readSelection(session)).resolves.toEqual({ ...film, owner: before.identity })
  await expect(api.assignmentProject(session)).resolves.toBeNull()
  expect(inject).not.toHaveBeenCalled()
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** A scoped Jingliu peer without access to the owner's billing details. */
    'jingliu-test-guest': { readonly kind: 'jingliu-test-guest' }
  }
}

it('lets a scoped peer see the allowance and rejects its ledger request before sign-in', async () => {
  const { origin, requests } = await fixture(req => req.url === '/fwp/v2/budget/me' ? [200, accountBalance] : authenticated(req))
  const { ctx } = await mount({ studioOrigin: origin })
  const { signal } = new AbortController()
  const invocation: RemoteInvocation = {
    request: { namespace: 'jingliuConnection', method: 'billingDetails', args: {} }, service: 'jingliuConnection',
    peer: { id: 'billing-guest' as PeerId, ctx, principal: { kind: 'jingliu-test-guest' }, interactions: 'none', signal,
      dispose: () => Promise.resolve() },
    signal,
    async *uplink() {},
  }
  await expect(ctx.extend({ invocation }).jingliuConnection.billingDetails(signal)).rejects.toMatchObject({ code: 'JINGLIU_BILLING_OWNER_REQUIRED' })
  expect(requests).toEqual([])
  await expect(ctx.extend({ invocation: { ...invocation, request: { ...invocation.request, method: 'balance' } } }).jingliuConnection.balance(signal))
    .resolves.toMatchObject({ available: '12.50', usedFen: 250 })
  expect(requests.at(-1)?.url).toBe('/fwp/v2/budget/me')
})

it('reads project workflows in the signed-in scope and follows the shot cursor', async () => {
  const film = 'film-1'
  const root = '/fwp/v2'
  const projectArgs = { project_id: film }
  const video = '/fw/media/generated/shots/lantern.mp4'
  const workflows: Record<string, unknown> = {
    get_project: { project_id: film, title: '灯火', aspect: '9:16' },
    list_episodes: { episodes: [{ order: 2, title: '开场', has_shots: true }] },
    list_shots: { shots: [{ id: 'shot-1', order: 4, episode: 2 }, { id: 'shot-2', order: 5, episode: 2 }] },
    get_shot: { id: 'shot-2', video_url: video, adopted_version: 3 },
    list_versions: { versions: [{ version_no: 3, model_id: 'seed', video_url: video }] },
    list_assets: { assets: [{ id: 'lamp', name: '桥灯', kind: 'prop', image_url: '/fw/media/uploads/lantern.png' }] },
    list_audio_clips: { clips: [{ id: 'voice', kind: 'voice', url: '/fw/media/uploads/voice.wav', duration: 2 }] },
  }
  const { origin, requests, bodies } = await fixture((req, body) => {
    if (req.url === root + '/shots/shot-2' && req.method === 'DELETE') return [200, {}]
    if (req.url !== root + '/desktop-agent/tool') return authenticated(req)
    const call: unknown = JSON.parse(body)
    if (!isRecord(call) || typeof call.name !== 'string' || !isRecord(call.args)) return [400, {}]
    if (call.name === 'read_shots') {
      switch (call.args.from_order) {
        case undefined: return [200, { ok: true, shots: [{ id: 'shot-1', prompt: '推开门' }], next_from_order: 5 }]
        case 5: return [200, { ok: true, shots: [{ id: 'shot-2', prompt: '亮起桥灯' }], next_from_order: 6 }]
        case 6: return [200, { ok: true }]
        default: return [400, {}]
      }
    }
    const result = workflows[call.name]
    return isRecord(result) ? [200, { ok: true, ...result }] : [400, {}]
  })
  const { ctx } = await mount({ studioOrigin: origin })
  const api = ctx.jingliuConnection
  const { signal } = new AbortController()
  await expect(api.projectConfig(film, signal)).resolves.toMatchObject({ projectId: film, title: '灯火', aspect: '9:16' })
  await expect(api.episodeList(film, signal)).resolves.toEqual([{ number: 2, title: '开场', hasShots: true }])
  await expect(api.episodeShots(film, 2, signal)).resolves.toMatchObject([
    { id: 'shot-1', episode: 2, index: 1, prompt: '推开门' }, { id: 'shot-2', episode: 2, index: 2, prompt: '亮起桥灯' },
  ])
  for (const episode of [0, 1.5]) await expect(api.episodeShots(film, episode, signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_EPISODE' })
  await expect(api.shotMedia(film, 'shot-2', signal)).resolves.toMatchObject({ shotId: 'shot-2', videoPath: video,
    adoptedVersion: 3, versions: [{ number: 3, model: 'seed', videoPath: video }],
  })
  await expect(api.projectAssets(film, signal)).resolves.toMatchObject({ assets: [{ id: 'lamp', name: '桥灯' }], audio: [{ id: 'voice', durationSec: 2 }] })
  await expect(api.shotMedia(film, '../shot-2', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_SHOT' })
  await expect(api.deleteShot(film, '../shot-2', signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
  await expect(api.deleteShot(film, 'shot-2', signal)).resolves.toBeUndefined()

  const writes = requests.slice(2).map((req, index) => [req.method, req.url, req.headers.authorization, bodies[index + 2]])
  const call = (name: string, args: Record<string, unknown> = {}) => ['POST', root + '/desktop-agent/tool', 'Bearer private-session',
    JSON.stringify({ name, project_id: film, args: { ...projectArgs, ...args } })]
  expect(writes.slice(0, 6)).toEqual([
    call('get_project'), call('list_episodes'), call('list_shots', { episode: 2, limit: 1000 }),
    call('read_shots', { episode: 2, max_shots: 60 }), call('read_shots', { episode: 2, max_shots: 60, from_order: 5 }),
    call('read_shots', { episode: 2, max_shots: 60, from_order: 6 }),
  ])
  expect(writes.slice(6, 8)).toEqual(expect.arrayContaining([call('get_shot', { shot_id: 'shot-2' }), call('list_versions', { shot_id: 'shot-2' })]))
  expect(writes.slice(8, 10)).toEqual(expect.arrayContaining([call('list_assets'), call('list_audio_clips')]))
  expect(writes.slice(10)).toEqual([['DELETE', root + '/shots/shot-2', 'Bearer private-session', '']])
})

it('keeps a selection unconfirmed until the project and live conversation have been verified', async () => {
  await selectionHome()
  const film = { id: 'film-1', title: '灯火' }
  const { origin } = await fixture((req) => {
    switch (req.url) {
      case '/fwp/v2/projects/film-1': return [200, film]
      case '/fwp/v2/projects/missing': return [200, film]
      default: return authenticated(req)
    }
  })
  const { ctx, account } = await mount({ studioOrigin: origin })
  const api = ctx.jingliuConnection
  const session = SessionId('routing-session')
  const lifetime = new AbortController()
  const cancelled = new AbortController()
  await expect(api.selectProject(session, 'missing', lifetime.signal)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
  await expect(api.selectProject(session, film.id, lifetime.signal)).rejects.toMatchObject({ code: 'JINGLIU_SESSION_REQUIRED' })

  const gone = new Error('Conversation was deleted')
  const inject = vi.fn<(message: UserMessage) => void>()
  let available = false
  let shouldCancel = true
  await ctx.plugin(class Controller extends Service {
    constructor(parent: Context) { super(parent, 'sessionController') }
    async resolveAgent() {
      if (!available) return { error: gone }
      if (shouldCancel) cancelled.abort()
      return { agent: { inject } }
    }
  }).await()
  await expect(api.selectProject(session, film.id, lifetime.signal)).rejects.toBe(gone)
  available = true
  await expect(api.selectProject(session, film.id, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await expect(readSelection(session)).resolves.toBeNull()
  expect(inject).not.toHaveBeenCalled()

  shouldCancel = false
  await expect(api.selectProject(session, film.id, lifetime.signal)).resolves.toEqual(film)
  account.id = ''
  const stream = api.watchProject(session, lifetime.signal)[Symbol.asyncIterator]()
  await expect(stream.next()).rejects.toMatchObject({ code: 'JINGLIU_SIGN_IN_REQUIRED' })
})

it('limits preview credentials to loopback and rejects arguments to the login command', async () => {
  const { origin, requests } = await fixture(req => req.url === '/fwp/v2/auth/me' ? [200, { user: { id: 45 } }] : authenticated(req))
  const ordinary = await mount({ studioOrigin: origin })
  await expect(ordinary.command('jingliu-login', 'conversation', 'personal')).resolves.toMatchObject({ kind: 'error' })
  expect(requests).toEqual([])
  await expect(mount({ studioOrigin: 'https://preview.invalid', localPreviewToken: true }, false))
    .rejects.toMatchObject({ code: 'JINGLIU_PREVIEW_ORIGIN_INVALID' })

  vi.stubEnv('MUSE_JINGLIU_SESSION_TOKEN', 'local-test-token')
  const preview = await mount({ studioOrigin: origin, localPreviewToken: true }, false)
  expect(preview.commands.size).toBe(0)
  await (await preview.ctx.jingliuConnection.connection()).request('/desktop-agent/tools')
  expect(requests.map(req => [req.url, req.headers.authorization])).toEqual([
    ['/fwp/v2/auth/me', 'Bearer local-test-token'], ['/fwp/v2/desktop-agent/tools', 'Bearer local-test-token'],
  ])
})

it('leaves a programmatically registered studio disconnected until its deployment is configured', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin((parent: Context) => { new JingliuConnection(parent) }).await()
  await expect(ctx.jingliuConnection.connection()).rejects.toMatchObject({ code: 'JINGLIU_UNCONFIGURED' })
})

it('streams authenticated video headers and chunks and refuses a response without a video type', async () => {
  const clip = Buffer.alloc(768 * 1024 + 3, 42)
  const { origin, requests } = await fixture((req) => {
    switch (req.url) {
      case '/fwp/media/generated/lantern.mp4': return [200, clip, 'video/mp4; charset=binary']
      case '/fwp/media/generated/lantern.bin': return [200, clip.subarray(0, 3), null]
      default: return authenticated(req)
    }
  })
  const { ctx } = await mount({ studioOrigin: origin })
  const api = ctx.jingliuConnection
  const { signal } = new AbortController()
  const collect = async (path: string) => {
    const frames: string[] = []
    for await (const frame of api.video(path, signal)) frames.push(frame)
    return frames
  }
  const [contentType, ...chunks] = await collect('/fw/media/generated/lantern.mp4')
  expect(contentType).toBe('video/mp4')
  expect(chunks.map(chunk => Buffer.from(chunk, 'base64').length)).toEqual([768 * 1024, 3])
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(clip)
  await expect(collect('/fw/media/generated/lantern.bin')).rejects.toMatchObject({ code: 'JINGLIU_INVALID_MEDIA' })
  expect(requests.slice(-2).map(req => req.headers.authorization)).toEqual(['Bearer private-session', 'Bearer private-session'])
})
