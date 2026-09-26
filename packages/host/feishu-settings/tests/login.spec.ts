/** The QR flow: one ticket, a Host-rendered image, and bounded failure codes. */

import { describe, expect, it, vi } from 'vitest'
import { FeishuLoginError, FeishuLoginFlow, type FeishuRegistration } from '../src/login.ts'

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

    await expect(flow.begin()).rejects.toThrowError(FeishuLoginError)
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
    const flow = new FeishuLoginFlow({
      register: async () => await new Promise(() => {}),
      onRegistered: async () => {},
      qrTimeoutMs: 5,
    })

    await expect(flow.begin()).rejects.toMatchObject({ code: 'no-qr' })
    expect(flow.ticket).toBeUndefined()
  })
})
