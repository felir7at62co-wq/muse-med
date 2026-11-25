import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import WorkshopConnection from '../src/index.ts'
import { WorkbenchSessions, type WorkbenchDeployment } from '../src/sessions.ts'
import { SCRIPT_WORKSHOP } from '../src/workshop.ts'
import { host, workbench, type Reply } from './fixture.ts'

const challenge = 'C'.repeat(43)
const grant = 'G'.repeat(43)

function signIn(req: IncomingMessage): Reply | undefined {
  switch (req.url) {
    case '/v1/auth/muse/challenge': return [200, { requestId: 'request', challenge }]
    case '/v1/auth/muse/exchange': return [200, { access_token: 'native-token', user: { id: 7 } }]
    case '/v1/auth/logout': return [200, { ok: true }]
    default: return undefined
  }
}

function sessions(ctx: Context, deployment: Partial<WorkbenchDeployment>, onChange?: () => void): WorkbenchSessions {
  return new WorkbenchSessions(ctx, SCRIPT_WORKSHOP, { origin: undefined, timeoutMs: 1000, ...deployment }, onChange)
}

it('signs in once for concurrent callers, sends the native token and revokes it on disconnect', async () => {
  const { origin, requests } = await workbench(req => signIn(req) ?? [200, { path: req.url }])
  const { ctx, account } = await host()
  const access = sessions(ctx, { origin })
  const [first, second] = await Promise.all([access.connection(), access.connection()])
  expect(first).toBe(second)
  expect(first.origin).toBe(origin)
  expect(first.identity).toBe(createHash('sha256').update(origin + '/7').digest('hex'))
  expect(account.grant).toHaveBeenCalledOnce()
  expect(account.grant).toHaveBeenCalledWith('script-workshop', challenge)
  expect(JSON.parse(requests[1]!.body)).toEqual({ requestId: 'request', code: grant })
  expect(await first.request('/factory/jobs')).toEqual({ path: '/v1/factory/jobs' })
  expect(await (await first.fetch(new URL(origin + '/v1/raw'), {})).json()).toEqual({ path: '/v1/raw' })
  await (await first.fetch(new URL(origin + '/v1/raw'), { signal: new AbortController().signal, headers: { accept: 'application/json' } })).json()
  expect(requests.map(req => [req.url, req.method, req.authorization])).toEqual([
    ['/v1/auth/muse/challenge', 'POST', undefined], ['/v1/auth/muse/exchange', 'POST', undefined],
    ['/v1/factory/jobs', 'GET', 'Bearer native-token'], ['/v1/raw', 'GET', 'Bearer native-token'], ['/v1/raw', 'GET', 'Bearer native-token'],
  ])
  await access.disconnect(new AbortController().signal)
  expect(requests.at(-1)).toMatchObject({ url: '/v1/auth/logout', method: 'POST', authorization: 'Bearer native-token' })
  await expect(first.request('/factory/jobs')).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED', message: SCRIPT_WORKSHOP.changed })
  await access.disconnect(new AbortController().signal)
  expect(requests).toHaveLength(6)
  expect(await access.connection()).not.toBe(first)
  expect(account.grant).toHaveBeenCalledTimes(2)
})

it('keeps the session on an ordinary failure, drops it when the token is rejected, and keeps a failed logout', async () => {
  let logout: Reply = [500, { detail: 'busy' }]
  const { origin } = await workbench(req => req.url === '/v1/auth/logout' ? logout : signIn(req) ?? (req.url === '/v1/expired' ? [401, {}] : [500, {}]))
  const { ctx, account } = await host()
  const access = sessions(ctx, { origin })
  const scope = await access.connection()
  await expect(scope.request('/broken')).rejects.toMatchObject({ status: 500 })
  expect(await access.connection()).toBe(scope)
  await expect(access.disconnect(new AbortController().signal)).rejects.toMatchObject({ status: 500, message: 'busy' })
  const renewed = await access.connection()
  expect(account.grant).toHaveBeenCalledTimes(2)
  logout = [401, {}]
  await access.disconnect(new AbortController().signal)
  const third = await access.connection()
  await expect(third.request('/expired')).rejects.toMatchObject({ status: 401 })
  expect(await access.connection()).not.toBe(third)
  expect(renewed).not.toBe(third)
})

it('stops a session when the Muse login changes and names each account failure', async () => {
  const started = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const { origin, requests } = await workbench(async (req) => {
    if (req.url === '/v1/slow') { started.resolve(undefined); await finish.promise }
    return signIn(req) ?? [200, {}]
  })
  const { ctx, account } = await host()
  const access = sessions(ctx, { origin })
  const scope = await access.connection()
  const pending = scope.request('/slow', { method: 'POST' })
  await started.promise
  account.id = 'muse-login-b'
  finish.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED' })
  await expect(scope.request('/jobs')).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED' })
  await access.disconnect(new AbortController().signal)
  expect(requests.map(req => req.url)).not.toContain('/v1/auth/logout')
  account.id = ''
  await expect(access.connection()).rejects.toMatchObject({ code: 'WORKSHOP_SIGN_IN_REQUIRED', message: '请在 Muse 的账号设置中重新登录。' })
  account.failure = new Error('private account failure')
  await expect(access.connection()).rejects.toMatchObject({ code: 'WORKSHOP_MUSE_AUTH_UNAVAILABLE', message: '无法验证 Muse 登录状态，请检查账号服务后重试。' })
  const missing = await host(false)
  await expect(sessions(missing.ctx, { origin }).connection()).rejects.toMatchObject({ code: 'WORKSHOP_SIGN_IN_REQUIRED', message: '请先在 Muse 的账号设置中登录。' })
})

it('discards a sign-in and an open session when Muse announces a login change', async () => {
  let announce: (() => void) | undefined
  const { origin } = await workbench((req) => {
    if (req.url === '/v1/auth/muse/exchange') announce?.()
    return signIn(req) ?? [200, {}]
  })
  const { ctx } = await host()
  const changed = vi.fn()
  const access = sessions(ctx, { origin }, changed)
  announce = () => { ctx.emit('muse-account/session-changed') }
  await expect(access.connection()).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED' })
  expect(changed).toHaveBeenCalledOnce()
  announce = undefined
  const scope = await access.connection()
  ctx.emit('muse-account/session-changed')
  await expect(scope.request('/jobs')).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED' })
})

it.each<[string, (req: IncomingMessage) => Reply | undefined, Record<string, unknown>]>([
  ['a malformed challenge', req => req.url === '/v1/auth/muse/challenge' ? [200, { requestId: 'r', challenge: 'short' }] : undefined,
    { code: 'WORKSHOP_INVALID_CHALLENGE', message: '剧本工坊未返回有效的 Muse 登录请求。' }],
  ['a refused account', req => req.url === '/v1/auth/muse/exchange' ? [403, { detail: { code: 'G'.repeat(43), message: 'G'.repeat(43) } }] : undefined,
    { status: 403, code: 'WORKSHOP_MUSE_EXCHANGE_FAILED', message: '剧本工坊未授权当前 Muse 账号，请管理员核对账号绑定和角色。' }],
  ['a failed exchange', req => req.url === '/v1/auth/muse/exchange' ? [502, {}] : undefined,
    { status: 502, code: 'WORKSHOP_MUSE_EXCHANGE_FAILED', message: '剧本工坊未能完成 Muse 登录（HTTP 502）。' }],
  ['a missing credential', req => req.url === '/v1/auth/muse/exchange' ? [200, { token: 'wrong-field', user: { id: 7 } }] : undefined,
    { code: 'WORKSHOP_INVALID_ACCOUNT', message: '剧本工坊未返回有效的工具连接。' }],
  ['a missing user', req => req.url === '/v1/auth/muse/exchange' ? [200, { access_token: 'native', user: { id: '7' } }] : undefined,
    { code: 'WORKSHOP_INVALID_ACCOUNT', message: '剧本工坊未返回有效的登录用户。' }],
])('rejects %s without keeping a session', async (_name, override, failure) => {
  const { origin } = await workbench(req => override(req) ?? signIn(req) ?? [200, {}])
  const { ctx } = await host()
  const access = sessions(ctx, { origin })
  await expect(access.connection()).rejects.toMatchObject(failure)
  await expect(access.connection()).rejects.toMatchObject(failure)
})

it('rejects a grant issued to another login and a login that changes while the grant is issued', async () => {
  const { origin, requests } = await workbench(req => signIn(req) ?? [200, {}])
  const { ctx, account } = await host()
  const access = sessions(ctx, { origin })
  account.grant.mockResolvedValueOnce({ code: grant, expiresIn: 60, accountId: 'someone-else' })
  await expect(access.connection()).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED' })
  account.grant.mockImplementationOnce(async () => {
    const issued = { code: grant, expiresIn: 60, accountId: account.id }
    account.id = 'muse-login-b'
    return issued
  })
  await expect(access.connection()).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED' })
  expect(requests.filter(req => req.url === '/v1/auth/muse/exchange')).toHaveLength(0)
  expect(await access.connection()).toHaveProperty('identity')
})

it('passes a transport failure through unchanged', async () => {
  const { ctx } = await host()
  const access = sessions(ctx, { origin: 'http://127.0.0.1:9' })
  await expect(access.connection()).rejects.toBeInstanceOf(TypeError)
})

it('passes a manual redirect and a mounted transport failure through without naming the Muse login', async () => {
  const { origin } = await workbench(req => req.url === '/jubengongfang/v1/auth/me' ? [200, { id: 9 }] : [200, {}])
  const { ctx, account } = await host()
  const access = sessions(ctx, { origin: origin + '/jubengongfang' })
  const scope = await access.connection()
  await scope.fetch(new URL(origin + '/jubengongfang/v1/raw'), { redirect: 'manual' })
  await scope.fetch(new URL(origin + '/jubengongfang/v1/raw'), { redirect: 'follow' })
  expect(account.mounted.mock.calls.slice(1).map(([, , , init]) => init.redirect)).toEqual(['manual', 'error'])
  const unreachable = new TypeError('fetch failed')
  account.mounted.mockRejectedValueOnce(unreachable)
  await expect(scope.fetch(new URL(origin + '/jubengongfang/v1/raw'), {})).rejects.toBe(unreachable)
  account.mounted.mockRejectedValueOnce(Object.assign(new Error('MUSE account gateway: gateway-rejected'), { name: 'MuseGatewayError', code: 'gateway-rejected' }))
  await expect(scope.fetch(new URL(origin + '/jubengongfang/v1/raw'), {})).rejects.toMatchObject({ code: 'WORKSHOP_MUSE_AUTH_UNAVAILABLE' })
})

it('authorizes a gateway-mounted deployment with the Muse login instead of a native token', async () => {
  let profile: Reply = [200, { id: 9, username: 'writer' }]
  const { origin, requests } = await workbench(req => req.url === '/jubengongfang/v1/auth/me' ? profile : [200, { path: req.url }])
  const { ctx, account } = await host()
  const access = sessions(ctx, { origin: origin + '/jubengongfang' })
  const scope = await access.connection()
  expect(scope.identity).toBe(createHash('sha256').update(origin + '/jubengongfang/9').digest('hex'))
  expect(await scope.request('/factory/video-transcribe/status')).toEqual({ path: '/jubengongfang/v1/factory/video-transcribe/status' })
  expect(await (await scope.fetch(new URL(origin + '/jubengongfang/v1/raw'), {})).json()).toEqual({ path: '/jubengongfang/v1/raw' })
  expect(account.grant).not.toHaveBeenCalled()
  expect(account.mounted.mock.calls.map(([audience, owner, url]) => [audience, owner, url.pathname])).toEqual([
    ['script-workshop', 'muse-login-a', '/jubengongfang/v1/auth/me'],
    ['script-workshop', 'muse-login-a', '/jubengongfang/v1/factory/video-transcribe/status'],
    ['script-workshop', 'muse-login-a', '/jubengongfang/v1/raw'],
  ])
  expect(requests.map(req => req.authorization)).toEqual([undefined, undefined, undefined])
  await access.disconnect(new AbortController().signal)
  expect(requests).toHaveLength(3)
  await expect(scope.request('/factory/jobs')).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED' })
  profile = [403, '<html>403 Forbidden</html>']
  await expect(access.connection()).rejects.toMatchObject({ status: 403, code: 'WORKSHOP_MUSE_EXCHANGE_FAILED', message: '剧本工坊未授权当前 Muse 账号，请管理员核对账号绑定和角色。' })
  profile = [200, { username: 'no id' }]
  await expect(access.connection()).rejects.toMatchObject({ code: 'WORKSHOP_INVALID_ACCOUNT' })
  profile = [200, ['not', 'a', 'profile']]
  await expect(access.connection()).rejects.toMatchObject({ code: 'WORKSHOP_INVALID_ACCOUNT' })
})

it('uses a preview credential on loopback and ignores Muse login announcements', async () => {
  let token: string | undefined = 'preview-a'
  const user: Reply = [200, { id: 3 }]
  const { origin, requests } = await workbench(req => req.url === '/v1/auth/me' ? user : [200, {}])
  const { ctx, account } = await host()
  const access = sessions(ctx, { origin, previewToken: () => token })
  const scope = await access.connection()
  ctx.emit('muse-account/session-changed')
  expect(await scope.request('/jobs')).toEqual({})
  expect(requests.map(req => req.authorization)).toEqual(['Bearer preview-a', 'Bearer preview-a'])
  expect(account.grant).not.toHaveBeenCalled()
  token = 'preview-b'
  await expect(scope.request('/jobs')).rejects.toMatchObject({ code: 'WORKSHOP_ACCOUNT_CHANGED' })
  token = undefined
  await expect(access.connection()).rejects.toMatchObject({ code: 'WORKSHOP_SIGN_IN_REQUIRED', message: '剧本工坊本地预览尚未配置测试会话。' })
  const listed = await workbench(() => [200, ['not', 'a', 'profile']])
  token = 'preview-c'
  await expect(sessions(ctx, { origin: listed.origin, previewToken: () => token }).connection()).rejects.toMatchObject({ code: 'WORKSHOP_INVALID_ACCOUNT' })
})

it('reports an unconfigured deployment and refuses new sessions after its service is disposed', async () => {
  const { ctx } = await host()
  const unconfigured = ctx.plugin(WorkshopConnection, {})
  await unconfigured.await()
  await expect(ctx.workshopConnection.connection()).rejects.toMatchObject({ code: 'WORKSHOP_UNCONFIGURED', message: '请在 Muse 安装配置中选择剧本工坊站点。' })
  await unconfigured.dispose()
  const { origin } = await workbench(req => signIn(req) ?? [200, {}])
  const fiber = ctx.plugin(WorkshopConnection, { workshopOrigin: origin + '/' })
  await fiber.await()
  expect(await (await ctx.workshopConnection.connection()).request('/jobs')).toEqual({})
  await fiber.dispose()
  let probe: WorkbenchSessions | undefined
  const owner = ctx.plugin({ name: 'owner', apply: (scope: Context) => { probe = sessions(scope, { origin }) } })
  await owner.await()
  expect(probe?.signal.aborted).toBe(false)
  await owner.dispose()
  expect(probe?.signal.aborted).toBe(true)
  await expect(probe!.connection()).rejects.toHaveProperty('name', 'AbortError')
})
