/** The QR flow: one ticket, a Host-rendered image, and bounded failure codes. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FeishuLoginError, FeishuLoginFlow, officialRegisterApp, type FeishuRegistration, type RegisterAppRequest, type RegisterAppResult,
} from '../src/login.ts'

const official = vi.hoisted(() => vi.fn())
vi.mock('@larksuite/channel', () => ({ registerApp: official }))
afterEach(() => { vi.useRealTimers(); official.mockReset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('FeishuLoginFlow', () => {
  it('answers with a Host-rendered QR ticket and stores the scanned pair', async () => {
    const registrations: FeishuRegistration[] = []
    const flow = new FeishuLoginFlow({
      register: async (request) => {
        request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/abc', expireIn: 300 })
        return { client_id: 'cli_x', client_secret: 'sec_x', user_info: { open_id: 'ou_x' } }
      },
      onRegistered: async (registration) => {
        registrations.push(registration)
      },
    })

    const ticket = await flow.begin('cli_configured')

    expect(ticket.url).toBe('https://open.feishu.cn/scan/abc')
    expect(ticket.expiresInSeconds).toBe(300)
    expect(ticket.qrDataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const svg = Buffer.from(ticket.qrDataUrl.slice(ticket.qrDataUrl.indexOf(',') + 1), 'base64').toString('utf8')
    expect(svg).toContain('<svg')
    await vi.waitFor(() => {
      expect(registrations).toEqual([{ appId: 'cli_x', appSecret: 'sec_x', registeredBy: 'ou_x' }])
    })
  })

  it('fails its own begin with a bounded code when the call fails first', async () => {
    const flow = new FeishuLoginFlow({
      register: async () => {
        throw Object.assign(new Error('app_secret=sec_leak'), { code: 'invalid_request' })
      },
      onRegistered: async () => {},
    })

    await expect(flow.begin()).rejects.toMatchObject({ code: 'invalid_request' })
    expect(flow.failure).toBe('invalid_request')
  })

  it('reduces an unbounded platform message to one code', async () => {
    const flow = new FeishuLoginFlow({
      register: async () => {
        throw new Error('app_secret=sec_leak')
      },
      onRegistered: async () => {},
    })

    await expect(flow.begin()).rejects.toThrow(FeishuLoginError)
    expect(flow.failure).toBe('registration-failed')
  })

  it('withdraws the pending scan on cancel and on a new begin', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const flow = new FeishuLoginFlow({
      register: async (request) => {
        signals.push(request.signal)
        request.onQRCodeReady({ url: `https://open.feishu.cn/scan/${String(signals.length)}`, expireIn: 60 })
        return await new Promise(() => {})
      },
      onRegistered: async () => {},
    })

    await flow.begin()
    const second = await flow.begin()
    expect(signals[0]?.aborted).toBe(true)
    expect(second.url).toContain('/2')
    expect(flow.ticket?.url).toContain('/2')

    flow.cancel()
    expect(signals[1]?.aborted).toBe(true)
    expect(flow.ticket).toBeUndefined()
  })

  it('gives up when the platform never reports a URL', async () => {
    vi.useFakeTimers()
    const flow = new FeishuLoginFlow({
      register: async () => await new Promise(() => {}),
      onRegistered: async () => {},
      qrTimeoutMs: 5,
    })

    const failed = expect(flow.begin()).rejects.toMatchObject({ code: 'no-qr' })
    await vi.advanceTimersByTimeAsync(5)
    await failed
    expect(flow.ticket).toBeUndefined()
  })
})

it('forwards the registration request to the official SDK port', async () => {
  const result = { client_id: 'cli_test', client_secret: 'private-test-secret' }
  official.mockResolvedValueOnce(result)
  const request: RegisterAppRequest = { source: 'muse-med', onQRCodeReady: vi.fn() }
  expect(await officialRegisterApp(request)).toBe(result)
  expect(official).toHaveBeenCalledExactlyOnceWith(request)
})

it('omits an empty app id and stores registration without a scanner identifier', async () => {
  const sink = vi.fn(async () => {}), requests: RegisterAppRequest[] = []
  const flow = new FeishuLoginFlow({
    register: async (request) => {
      requests.push(request)
      request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/no-scanner', expireIn: 60 })
      return { client_id: 'cli_test', client_secret: 'private-test-secret' }
    },
    onRegistered: sink,
  })
  await flow.begin('')
  expect(requests[0]).not.toHaveProperty('appId')
  expect(sink).toHaveBeenCalledExactlyOnceWith({ appId: 'cli_test', appSecret: 'private-test-secret' })
})

it('records a bounded failure after a ticket was shown without rejecting the completed begin', async () => {
  const registration = deferred<RegisterAppResult>(), failed = vi.fn()
  const flow = new FeishuLoginFlow({
    register: async (request) => {
      request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/failure', expireIn: 60 })
      return await registration.promise
    },
    onRegistered: vi.fn(), onFailed: failed,
  })
  expect((await flow.begin()).url).toContain('/failure')
  registration.reject(Object.assign(new Error('private platform data'), { code: 'invalid_request' }))
  await vi.waitFor(() => { expect(failed).toHaveBeenCalledExactlyOnceWith('invalid_request') })
  expect(flow.ticket).toBeUndefined()
  expect(flow.failure).toBe('invalid_request')
})

it('reports a current credential sink failure and clears it when another scan starts', async () => {
  const sink = deferred<undefined>(), failed = vi.fn()
  let calls = 0
  const flow = new FeishuLoginFlow({
    register: async (request) => {
      calls += 1
      request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/credential', expireIn: 60 })
      if (calls > 1) return await new Promise<RegisterAppResult>(() => {})
      return { client_id: 'cli_test', client_secret: 'private-test-secret' }
    },
    onRegistered: () => sink.promise, onFailed: failed,
  })
  await flow.begin()
  sink.reject(Object.assign(new Error('private stored secret'), { code: 'write_failed' }))
  await vi.waitFor(() => { expect(flow.failure).toBe('write_failed') })
  expect(failed).toHaveBeenCalledExactlyOnceWith('write_failed')
  await flow.begin()
  expect(flow.failure).toBeUndefined()
  flow.cancel()
})

it.each(['registration resolves', 'registration rejects', 'sink rejects', 'sink resolves'] as const)(
  'keeps a replacement ticket when its withdrawn %s late', async (mode) => {
    const registration = deferred<RegisterAppResult>(), sink = deferred<undefined>(), failed = vi.fn()
    let calls = 0
    const store = vi.fn(() => sink.promise)
    const flow = new FeishuLoginFlow({
      register: async (request) => {
        calls += 1
        request.onQRCodeReady({ url: `https://open.feishu.cn/scan/${String(calls)}`, expireIn: 60 })
        if (calls > 1) return await new Promise<RegisterAppResult>(() => {})
        return await registration.promise
      },
      onRegistered: store, onFailed: failed,
    })
    await flow.begin()
    if (mode === 'sink rejects' || mode === 'sink resolves') {
      registration.resolve({ client_id: 'cli_old', client_secret: 'private-old-secret' })
      await vi.waitFor(() => { expect(store).toHaveBeenCalledOnce() })
    }
    const second = await flow.begin()
    if (mode === 'registration resolves') registration.resolve({ client_id: 'cli_old', client_secret: 'private-old-secret' })
    else if (mode === 'registration rejects') registration.reject(Object.assign(new Error('private old detail'), { code: 'old_failed' }))
    else if (mode === 'sink rejects') sink.reject(Object.assign(new Error('private old write detail'), { code: 'old_write_failed' }))
    else sink.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(flow.ticket).toEqual(second)
    expect(flow.failure).toBeUndefined()
    expect(failed).not.toHaveBeenCalled()
    flow.cancel()
  },
)

it('times out a withdrawn request without withdrawing its newer ticket', async () => {
  vi.useFakeTimers()
  let calls = 0
  const flow = new FeishuLoginFlow({
    register: async (request) => {
      calls += 1
      if (calls > 1) request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/current', expireIn: 60 })
      return await new Promise<RegisterAppResult>(() => {})
    },
    onRegistered: vi.fn(), qrTimeoutMs: 100,
  })
  const old = expect(flow.begin()).rejects.toMatchObject({ code: 'no-qr' })
  const current = await flow.begin()
  await vi.advanceTimersByTimeAsync(100)
  await old
  expect(flow.ticket).toEqual(current)
  flow.cancel()
})
