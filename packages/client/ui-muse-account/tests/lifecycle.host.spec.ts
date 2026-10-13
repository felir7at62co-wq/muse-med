/** Account slot requests traverse the real Host service, controller and origin-bound session storage. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, fireEvent, within } from '@testing-library/react'
import { afterAll, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { MuseAccountController } from '../../../host/muse-account/src/account.ts'
import { createMuseAccountGateway } from '../../../host/muse-account/src/gateway.ts'
import { MuseAccountService } from '../../../host/muse-account/src/service.ts'
import { readMuseSession, writeMuseSession } from '../../../host/muse-account/src/session.ts'
import type { MuseAccountLoginRequest, MuseAccountLoginResult, MuseAccountStatus, MuseAccountStatusRequest } from '../../../host/muse-account/src/types.ts'

// Preserve Node's fetch/URL implementations for the Host while React uses the owned DOM.
const dom = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom')
  const instance = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver'] as const
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: instance.window[key] })
  return { dispose: () => {
    instance.window.close()
    for (const [key, original] of originals) {
      if (original === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, original)
    }
  } }
})
afterAll(dom.dispose)

interface PageFixture {
  mountAccountPage: (host: {
    status(request: MuseAccountStatusRequest): Promise<RemoteResult<MuseAccountStatus>>
    login(request: MuseAccountLoginRequest): Promise<RemoteResult<MuseAccountLoginResult>>
    logout(): Promise<RemoteResult<MuseAccountStatus>>
  }) => Promise<{ container: HTMLElement; registrations: () => number; dispose: () => Promise<void> }>
}
const { mountAccountPage } = await vi.importActual<PageFixture>('./account-host-page.client.tsx')

async function outcome<T>(operation: () => Promise<T>): Promise<RemoteResult<T>> {
  try { return { ok: true, value: await operation() } }
  catch (error) {
    if (!(error instanceof RemoteError)) throw error
    return { ok: false, error }
  }
}

function pageView(container: HTMLElement) {
  return {
    paragraphs: [...container.querySelectorAll('p')].map(node => node.textContent),
    buttons: [...container.querySelectorAll('button')].map(button => ({ name: button.textContent, disabled: button.disabled })),
    inputs: [...container.querySelectorAll('input')].map(input => ({ name: input.labels?.[0]?.textContent?.trim(), type: input.type })),
  }
}

async function bench() {
  const home = await mkdtemp(join(tmpdir(), 'muse-account-ui-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const sessionFile = join(home, 'session.json'), baseUrl = 'https://muse.example'
  let response: () => Promise<Response> = async () => Response.json({ username: 'writer', workspaceLabel: 'First studio' })
  const requests: string[] = [], operations: string[] = []
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    requests.push(path)
    if (path === '/api/muse.account') {
      expect(new Headers(init?.headers).get('cookie')).toMatch(/^__Host-muse=/u)
      return await response()
    }
    if (path === '/logout') return new Response(null, { status: 303 })
    throw new Error(`Unexpected fixture request: ${path}`)
  })
  await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=fixture', username: 'writer' })
  async function start() {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(MuseAccountService, {
      controller: new MuseAccountController({ baseUrl, sessionFile, gateway }),
      models: { refresh: async () => { operations.push('models') } },
      remote: { refresh: async () => { operations.push('remote') }, pause: async () => { operations.push('pause') } },
    }).await()
    const service = ctx.get('museAccount') as MuseAccountService
    return { ctx, page: async () => {
      const page = await mountAccountPage({
        status: request => outcome(() => service.status(request)),
        login: request => outcome(() => service.login(request)),
        logout: () => outcome(() => service.logout()),
      })
      onTestFinished(page.dispose)
      return page
    } }
  }
  return { sessionFile, baseUrl, requests, operations, start, respond: (next: () => Promise<Response>) => { response = next } }
}

it('verifies each actual settings opening and Host restart, then removes the saved session on logout', async () => {
  const b = await bench(), firstHost = await b.start(), first = await firstHost.page()
  const firstUi = within(first.container)
  await firstUi.findByText('账号已验证。')
  expect(firstUi.getByText('工作空间：First studio')).toBeDefined()
  const verifiedView = pageView(first.container)
  expect(first.registrations()).toBe(1)
  const stored = await readFile(b.sessionFile, 'utf8')
  expect(stored).not.toContain('verified')
  await first.dispose()
  expect(first.registrations()).toBe(0)
  b.respond(async () => Response.json({ username: 'writer', workspaceLabel: 'Changed studio' }))
  const reopened = await firstHost.page()
  await within(reopened.container).findByText('工作空间：Changed studio')
  const reopenedView = pageView(reopened.container)
  await reopened.dispose()
  await firstHost.ctx.fiber.dispose()
  const restarted = await b.start(), third = await restarted.page(), thirdUi = within(third.container)
  await thirdUi.findByText('账号已验证。')
  expect(await readFile(b.sessionFile, 'utf8')).toBe(stored)
  expect(b.requests).toEqual(['/api/muse.account', '/api/muse.account', '/api/muse.account'])
  expect(b.operations).toEqual(['models', 'remote', 'models', 'remote', 'models', 'remote'])
  fireEvent.click(thirdUi.getByRole('button', { name: '退出登录' }))
  await thirdUi.findByRole('button', { name: '登录' })
  expect(await readMuseSession(b.sessionFile, b.baseUrl)).toBeNull()
  expect(b.operations.slice(-2)).toEqual(['pause', 'models'])
  expect(thirdUi.queryByText('__Host-muse=fixture')).toBeNull()
  await expect(`${JSON.stringify({ verified: verifiedView, reopened: reopenedView, signedOut: pageView(third.container) }, null, 2)}\n`)
    .toMatchFileSnapshot(join(import.meta.dirname, 'expected/account-verification.zh.json'))
})

it('retains the real session after a gateway outage but removes a confirmed invalid one', async () => {
  const b = await bench(), host = await b.start(), first = await host.page()
  await within(first.container).findByText('账号已验证。')
  await first.dispose()
  const stored = await readFile(b.sessionFile, 'utf8')
  b.respond(async () => { throw new Error('private cookie upstream failure') })
  const reopened = await host.page(), ui = within(reopened.container)
  await ui.findByRole('button', { name: '重试' })
  expect(ui.getByRole('status').textContent).toBe('暂时无法连接 MUSE 服务，请稍后重试。')
  expect(await readFile(b.sessionFile, 'utf8')).toBe(stored)
  expect(ui.queryByText('private cookie upstream failure')).toBeNull()
  b.respond(async () => new Response(null, { status: 401 }))
  fireEvent.click(ui.getByRole('button', { name: '重试' }))
  await ui.findByRole('button', { name: '登录' })
  expect(await readMuseSession(b.sessionFile, b.baseUrl)).toBeNull()
})

it('shows a replacement login as unverified when the previous identity request finishes after replacement', async () => {
  const b = await bench()
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  b.respond(async () => { enter(); await gate; return Response.json({ username: 'writer' }) })
  const host = await b.start(), page = await host.page(), ui = within(page.container)
  expect(ui.getByText('正在读取账号状态…').getAttribute('aria-busy')).toBe('true')
  await entered
  await writeMuseSession(b.sessionFile, { baseUrl: b.baseUrl, cookie: '__Host-muse=replacement', username: 'replacement' })
  await act(async () => { release() })
  await ui.findByText('当前账号：replacement')
  expect(ui.getByText('已保存登录状态，尚未向服务验证。')).toBeDefined()
  expect(ui.queryByText('账号已验证。')).toBeNull()
  b.respond(async () => Response.json({ username: 'replacement' }))
  fireEvent.click(ui.getByRole('button', { name: '验证登录状态' }))
  await ui.findByText('账号已验证。')
})
