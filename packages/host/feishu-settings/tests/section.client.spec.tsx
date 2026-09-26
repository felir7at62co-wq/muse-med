// @vitest-environment jsdom
/** The Feishu Settings page: what each control renders, and the call it makes. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeishuSection, type FeishuSectionProps, type FeishuSetupInjected } from '../src/client/FeishuSection.tsx'
import type { FeishuLoginTicket, FeishuSetupStatus } from '../src/types.ts'

// This suite runs without the repository's global test setup, so each render is
// unmounted explicitly; otherwise every later query sees every earlier tree.
afterEach(() => {
  cleanup()
})

const TICKET: FeishuLoginTicket = {
  url: 'https://open.feishu.cn/scan/xyz',
  qrDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
  expiresInSeconds: 300,
}

const OFF: FeishuSetupStatus = {
  enabled: false,
  row: 'disabled',
  appId: '',
  credential: 'none',
  writable: true,
  login: null,
}

/**
 * Build the props the slot renderer would assemble.
 * @param status - what the Host answers on the first read.
 * @param overrides - injected calls a test wants to observe.
 * @returns the composed props, with a key-echoing `t`.
 */
function props(status: FeishuSetupStatus = OFF, overrides: Partial<FeishuSetupInjected> = {}): FeishuSectionProps {
  const injected: FeishuSetupInjected = {
    status: vi.fn(async () => ({ ok: true as const, value: status })),
    setEnabled: vi.fn(async () => ({ ok: true as const, value: status })),
    setCredentials: vi.fn(async () => ({ ok: true as const, value: status })),
    beginLogin: vi.fn(async () => ({ ok: true as const, value: TICKET })),
    cancelLogin: vi.fn(async () => ({ ok: true as const, value: status })),
    forget: vi.fn(async () => ({ ok: true as const, value: status })),
    ...overrides,
  }
  return { t: (key: string) => key, ...injected } as unknown as FeishuSectionProps
}

describe('FeishuSection', () => {
  it('reports the effective row state and the stored credential', async () => {
    render(<FeishuSection {...props({ ...OFF, appId: 'cli_x', credential: 'registered' })} />)

    expect(await screen.findByText('statusLabel: status.disabled')).toBeDefined()
    expect(screen.getByText('credentialLabel: credential.registered')).toBeDefined()
    expect(screen.getByText('appIdLabel: cli_x')).toBeDefined()
  })

  it('writes the switch and says the change waits for a restart', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const, value: { ...OFF, enabled: true, row: 'restart-pending' as const } }))
    render(<FeishuSection {...props(OFF, { setEnabled })} />)

    const toggle = await screen.findByRole('checkbox')
    fireEvent.click(toggle)

    expect(setEnabled).toHaveBeenCalledWith(true)
    expect(await screen.findByText('switchNeedsRestart')).toBeDefined()
    expect(screen.getByText('statusLabel: status.restartPending')).toBeDefined()
  })

  it('shows the Host-rendered ticket with its countdown, and cancels it', async () => {
    let current: FeishuSetupStatus = OFF
    const beginLogin = vi.fn(async () => {
      current = { ...OFF, login: TICKET }
      return { ok: true as const, value: TICKET }
    })
    const injected = props(OFF, {
      status: vi.fn(async () => ({ ok: true as const, value: current })),
      beginLogin,
      cancelLogin: vi.fn(async () => {
        current = OFF
        return { ok: true as const, value: OFF }
      }),
    })
    render(<FeishuSection {...injected} />)

    fireEvent.click(await screen.findByText('qrStart'))

    const image = await screen.findByRole('img')
    expect(image.getAttribute('src')).toBe(TICKET.qrDataUrl)
    expect(screen.getByText('qrExpires')).toBeDefined()

    fireEvent.click(screen.getByText('qrCancel'))
    await waitFor(() => {
      expect(screen.getByText('qrStart')).toBeDefined()
    })
  })

  it('saves a hand-entered pair and clears it again', async () => {
    const setCredentials = vi.fn(async () => ({ ok: true as const, value: { ...OFF, appId: 'cli_manual', credential: 'manual' as const } }))
    const forget = vi.fn(async () => ({ ok: true as const, value: OFF }))
    render(<FeishuSection {...props(OFF, { setCredentials, forget })} />)

    fireEvent.change(await screen.findByPlaceholderText('appIdPlaceholder'), { target: { value: 'cli_manual' } })
    fireEvent.change(screen.getByPlaceholderText('secretPlaceholder'), { target: { value: 'sec_manual' } })
    fireEvent.click(screen.getByText('save'))

    expect(setCredentials).toHaveBeenCalledWith({ appId: 'cli_manual', appSecret: 'sec_manual' })
    expect(await screen.findByText('saved')).toBeDefined()

    fireEvent.click(screen.getByText('forget'))
    expect(forget).toHaveBeenCalled()
    expect(await screen.findByText('forgotten')).toBeDefined()
  })

  it('shows a bounded failure code instead of any platform text', async () => {
    const beginLogin = vi.fn(async () => ({ ok: false as const, code: 'no-qr', message: 'app_secret=sec_leak' }))
    render(<FeishuSection {...props(OFF, { beginLogin })} />)

    fireEvent.click(await screen.findByText('qrStart'))

    expect(await screen.findByText('error.no-qr')).toBeDefined()
    expect(screen.queryByText(/sec_leak/u)).toBeNull()
  })
})
