import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import { onTestFinished, vi } from 'vitest'
import WorkshopConnection from '../src/index.ts'

/** Status and JSON body of one loopback reply; a string body is sent verbatim. */
export type Reply = [number, unknown]

/** One request received by the loopback workbench. */
export interface Received {
  readonly url: string
  readonly method: string
  readonly authorization: string | undefined
  readonly origin: string | undefined
  readonly body: string
}

/**
 * Serve a loopback workbench whose replies come from `route`.
 * @param route - Reply for each request.
 * @returns The origin and the requests it received.
 */
export async function workbench(route: (req: IncomingMessage, body: string) => Reply | Promise<Reply>) {
  const requests: Received[] = []
  const reply = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({ url: req.url ?? '', method: req.method ?? '', authorization: req.headers.authorization, origin: req.headers.origin, body })
    const [status, value] = await route(req, body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof value === 'string' ? value : JSON.stringify(value))
  }
  const server = createServer((req, res) => { void reply(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  return { origin: 'http://127.0.0.1:' + String((server.address() as AddressInfo).port), requests }
}

/** A one-time Muse workbench grant. */
export interface Grant { code: string; expiresIn: number; accountId: string }

/** A Muse account whose login, grant and mounted transport the test controls. */
export interface FakeAccount {
  id: string
  failure?: unknown
  readonly grant: ReturnType<typeof vi.fn<(audience: string, challenge: string) => Promise<Grant>>>
  readonly mounted: ReturnType<typeof vi.fn<(audience: string, owner: string, url: URL, init: RequestInit) => Promise<Response>>>
}

/**
 * Provide `museAccount` in a fresh Context.
 * @param loadAccount - Whether the account service exists at all.
 * @returns The Context and the controllable account.
 */
export async function host(loadAccount = true) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const account: FakeAccount = {
    id: 'muse-login-a',
    grant: vi.fn(async (_audience: string, _challenge: string) => ({ code: 'G'.repeat(43), expiresIn: 60, accountId: account.id })),
    mounted: vi.fn(async (_audience: string, _owner: string, url: URL, init: RequestInit) => await fetch(url, init)),
  }
  class Account extends Service {
    constructor(parent: Context) { super(parent, 'museAccount') }
    async workbenchIdentity() {
      if (account.failure !== undefined) throw account.failure
      if (!account.id) throw Object.assign(new Error('signed out'), { code: 'invalid-credentials' })
      return account.id
    }
    workbenchGrant = account.grant
    requestMountedWorkbench = account.mounted
  }
  if (loadAccount) await ctx.plugin(Account).await()
  return { ctx, account }
}

/**
 * Mount the connection against the standard synthetic sign-in and a test's routes.
 * @param route - Respond to application requests after sign-in.
 * @returns The mounted service and the ordered HTTP requests.
 */
export async function workshopHost(route: Parameters<typeof workbench>[0]) {
  const { origin, requests } = await workbench((req, body) => {
    if (req.url === '/v1/auth/muse/challenge') return [200, { requestId: 'fixture', challenge: 'c'.repeat(43) }]
    if (req.url === '/v1/auth/muse/exchange') return [200, { access_token: 'fixture-token', user: { id: 41 } }]
    return route(req, body)
  })
  const { ctx } = await host()
  await ctx.plugin(WorkshopConnection, { workshopOrigin: origin }).await()
  return { ctx, api: ctx.workshopConnection, requests }
}
