import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import JingliuConnection, { type Config } from '../src/index.ts'
import { requestJson, studioOrigin } from '../src/http.ts'

afterEach(() => vi.unstubAllEnvs())

async function fixture(route: (req: IncomingMessage) => [number, unknown]) {
  const requests: IncomingMessage[] = []
  const server = createServer((req, res) => {
    requests.push(req)
    const [status, value] = route(req)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return { origin: 'http://127.0.0.1:' + String((server.address() as AddressInfo).port), requests }
}

async function mount(config: Config) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const commands = new Map<string, CommandDefinition>()
  const records = new Map<string, CredentialRecord>()
  class Commands extends Service {
    constructor(parent: Context) { super(parent, 'commands') }
    register(command: CommandDefinition) {
      commands.set(command.name, command)
      return () => commands.delete(command.name)
    }
  }
  class Credentials extends Service {
    constructor(parent: Context) { super(parent, 'credentials') }
    async readRecord(key: string) { return records.get(key) }
    async modifyRecord(key: string, update: (value?: CredentialRecord) => Promise<CredentialRecord | undefined>) {
      const record = await update(records.get(key))
      if (record) records.set(key, record)
      return record
    }
  }
  await ctx.plugin(Commands).await()
  await ctx.plugin(Credentials).await()
  const fiber = ctx.plugin(JingliuConnection, config)
  await fiber.await()
  const command = async (name: string, owner: string) => {
    const definition = commands.get(name)
    if (!definition) throw new Error('Missing command')
    return await definition.handler({
      agent: { session: { id: owner } }, rawInput: '', signal: new AbortController().signal,
    } as CommandInvocation)
  }
  return { ctx, commands, command, records, fiber }
}

it('claims a Jingliu login only for the requesting conversation and uses it for the verified account', async () => {
  const { origin, requests } = await fixture((req) => {
    switch (req.url?.split('?')[0]) {
      case '/fwp/v2/auth/feishu/start': return [200, { authorize_url: 'https://open.feishu.cn/oauth/authorize?state=public', ticket: 'ticket', claim_secret: 'private-claim' }]
      case '/fwp/v2/auth/feishu/poll': return [200, { status: 'ok', token: 'test-session', script_platform: { access_token: 'other-service' } }]
      case '/fwp/v2/auth/me': return [200, { user: { id: 45 } }]
      case '/fwp/v2/desktop-agent/tools': return [200, { tools: [] }]
      default: return [200, {}]
    }
  })
  const { ctx, commands, command, records, fiber } = await mount({ studioOrigin: origin })
  await expect(ctx.jingliuConnection.connection()).rejects.toMatchObject({ code: 'JINGLIU_SIGN_IN_REQUIRED' })
  const start = await command('jingliu-login', 'a')
  expect(start.text).toContain('https://open.feishu.cn/')
  expect(start.text).not.toContain('private-claim')
  await expect(command('jingliu-login', 'b')).rejects.toMatchObject({ code: 'JINGLIU_LOGIN_IN_PROGRESS' })
  expect((await command('jingliu-login', 'a')).kind).toBe('success')
  const scope = await ctx.jingliuConnection.connection()
  expect(await scope.request('/desktop-agent/tools')).toEqual({ tools: [] })
  expect(requests[1]?.headers['x-fw-claim']).toBe('private-claim')
  expect(requests[3]?.headers.authorization).toBe('Bearer test-session')
  expect(JSON.stringify([...records.values()])).not.toContain('other-service')
  await command('jingliu-logout', 'a')
  await expect(scope.request('/desktop-agent/tools')).rejects.toMatchObject({ code: 'JINGLIU_SIGN_IN_REQUIRED' })
  expect(requests.length).toBe(5)
  await fiber.dispose()
  expect(commands.size).toBe(0)
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
  await expect(requestJson(origin, '/desktop-agent/tool', 1000)).rejects.toMatchObject({ status: 409, code: 'needs_confirm', message: '替换剧本？' })
  await expect(requestJson(origin, '/../other', 1000)).rejects.toMatchObject({ code: 'JINGLIU_PATH_INVALID' })
  expect(requests.length).toBe(1)
  expect(() => studioOrigin('http://jingliu.test')).toThrow()
  expect(() => studioOrigin('https://user@jingliu.test')).toThrow()
})
