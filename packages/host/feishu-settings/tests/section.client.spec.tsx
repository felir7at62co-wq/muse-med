// @vitest-environment jsdom
/** The Feishu Settings page: what each control renders, and the call it makes. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteError, type RemoteErrorCode, type RemoteErrorDetailsMap } from '@deepseek-ai/dsh-typert-protocol'
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
 * One refusal as the Remote face reports it.
 *
 * The code stays generic so the returned instance is the union member the page
 * receives on the error branch instead of the whole-code `RemoteError` default,
 * which is assignable to no member of the protocol's `RemoteFailure` union.
 * @param code - the declared failure code the Host would answer with.
 * @param details - the payload that code declares.
 * @returns the failure instance the page sees.
 */
function refusal<Code extends RemoteErrorCode>(code: Code, details: RemoteErrorDetailsMap[Code]): RemoteError<Code> {
  return new RemoteError(code, 'host-side detail', details)
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

    expect(await screen.findByText('status.disabled')).toBeDefined()
    expect(screen.getByText('credentialLabel: credential.registered')).toBeDefined()
    expect(screen.getByText('appIdLabel: cli_x')).toBeDefined()
  })

  it('writes the switch and says the change waits for a restart', async () => {
    const setEnabled = vi.fn(async () => ({ ok: true as const, value: { ...OFF, enabled: true, row: 'restart-pending' as const } }))
    render(<FeishuSection {...props(OFF, { setEnabled })} />)

    // The toggle is the shared Switch primitive, not a native checkbox.
    const toggle = await screen.findByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(setEnabled).toHaveBeenCalledWith(true)
    expect(await screen.findByText('switchNeedsRestart')).toBeDefined()
    expect(screen.getByText('status.restartPending')).toBeDefined()
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

  it('requires a secret while none is stored, and offers to keep one once it is', async () => {
    const none = props(OFF)
    const first = render(<FeishuSection {...none} />)

    // Nothing stored: the save action stays unavailable until a secret is typed.
    const save = await screen.findByText('save')
    expect(save.closest('button')?.disabled).toBe(true)
    expect(screen.getByText('secretRequiredHint')).toBeDefined()
    fireEvent.change(screen.getByPlaceholderText('appIdPlaceholder'), { target: { value: 'cli_x' } })
    expect(save.closest('button')?.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('secretPlaceholder'), { target: { value: 'sec_x' } })
    expect(save.closest('button')?.disabled).toBe(false)

    first.unmount()

    // A stored secret makes the field optional again, and says so.
    render(<FeishuSection {...props({ ...OFF, appId: 'cli_x', credential: 'manual' })} />)
    expect(await screen.findByPlaceholderText('secretKeepStored')).toBeDefined()
    expect(screen.queryByText('secretRequiredHint')).toBeNull()
  })

  it('saves a hand-entered pair, clears the secret it stored, and forgets both', async () => {
    const setCredentials = vi.fn(async () => ({ ok: true as const, value: { ...OFF, appId: 'cli_manual', credential: 'manual' as const } }))
    const forget = vi.fn(async () => ({ ok: true as const, value: OFF }))
    render(<FeishuSection {...props(OFF, { setCredentials, forget })} />)

    fireEvent.change(await screen.findByPlaceholderText('appIdPlaceholder'), { target: { value: 'cli_manual' } })
    fireEvent.change(screen.getByPlaceholderText('secretPlaceholder'), { target: { value: 'sec_manual' } })
    fireEvent.click(screen.getByText('save'))

    expect(setCredentials).toHaveBeenCalledWith({ appId: 'cli_manual', appSecret: 'sec_manual' })
    expect(await screen.findByText('saved')).toBeDefined()
    // A landed write is the only thing that clears the field.
    expect(screen.getByPlaceholderText<HTMLInputElement>('secretKeepStored').value).toBe('')

    fireEvent.click(screen.getByText('forget'))
    expect(forget).toHaveBeenCalled()
    expect(await screen.findByText('forgotten')).toBeDefined()
  })

  it('names the reason a refused first read carries instead of waiting forever', async () => {
    const status = vi.fn(async () => ({
      ok: false as const,
      error: refusal('feishu/credentials-unwritable', { reason: 'provider-read-only' }),
    }))
    render(<FeishuSection {...props(OFF, { status })} />)

    expect(await screen.findByText('error.providerReadOnly')).toBeDefined()
  })

  it('keeps the typed secret when the write is refused, and names the reason', async () => {
    const setCredentials = vi.fn(async () => ({
      ok: false as const,
      error: refusal('feishu/credentials-unwritable', { reason: 'section-unregistered' }),
    }))
    render(<FeishuSection {...props(OFF, { setCredentials })} />)

    const secret = await screen.findByPlaceholderText<HTMLInputElement>('secretPlaceholder')
    fireEvent.change(screen.getByPlaceholderText('appIdPlaceholder'), { target: { value: 'cli_manual' } })
    fireEvent.change(secret, { target: { value: 'sec_manual' } })
    fireEvent.click(screen.getByText('save'))

    // The whole point of a retry: the one value the page cannot reconstruct is
    // still there, and the failure is the reason the Host named.
    expect(await screen.findByText('error.sectionUnregistered')).toBeDefined()
    expect(secret.value).toBe('sec_manual')
    expect(screen.queryByText('error.generic')).toBeNull()
  })

  it('names the missing secret and the platform refusal instead of a bare code', async () => {
    const setCredentials = vi.fn(async () => ({ ok: false as const, error: refusal('feishu/secret-required', {}) }))
    const first = render(<FeishuSection {...props(OFF, { setCredentials })} />)
    fireEvent.change(await screen.findByPlaceholderText('appIdPlaceholder'), { target: { value: 'cli_x' } })
    fireEvent.change(screen.getByPlaceholderText('secretPlaceholder'), { target: { value: 'sec_x' } })
    fireEvent.click(screen.getByText('save'))
    expect(await screen.findByText('error.secretRequired')).toBeDefined()
    first.unmount()

    const beginLogin = vi.fn(async () => ({ ok: false as const, error: refusal('feishu/login-failed', { code: 'no-qr' }) }))
    render(<FeishuSection {...props(OFF, { beginLogin })} />)
    fireEvent.click(await screen.findByText('qrStart'))
    expect(await screen.findByText('error.no-qr')).toBeDefined()
    expect(screen.queryByText(/gateway\/internal/u)).toBeNull()
  })

  it('shows a bounded failure code instead of any platform text', async () => {
    const beginLogin = vi.fn(async () => ({
      ok: false as const,
      error: refusal('feishu/login-failed', { code: 'invalid_request' }),
    }))
    render(<FeishuSection {...props(OFF, { beginLogin })} />)

    fireEvent.click(await screen.findByText('qrStart'))

    expect(await screen.findByText('error.invalid_request')).toBeDefined()
    expect(screen.queryByText(/sec_leak/u)).toBeNull()
  })

  it('falls back to the code it cannot name, and keeps a refused clear from looking done', async () => {
    const unknownPlatform = vi.fn(async () => ({
      ok: false as const,
      error: refusal('feishu/login-failed', { code: 'tenant_misconfigured' }),
    }))
    const first = render(<FeishuSection {...props(OFF, { beginLogin: unknownPlatform })} />)
    fireEvent.click(await screen.findByText('qrStart'))
    expect(await screen.findByText('error.loginFailed')).toBeDefined()
    first.unmount()

    const carrier = vi.fn(async () => ({ ok: false as const, error: refusal('gateway/internal', {}) }))
    const forget = vi.fn(async () => ({ ok: false as const, error: refusal('feishu/credentials-unwritable', { reason: 'write-rejected' }) }))
    render(<FeishuSection {...props({ ...OFF, credential: 'manual' }, { beginLogin: carrier, forget })} />)
    fireEvent.change(await screen.findByPlaceholderText('appIdPlaceholder'), { target: { value: 'cli_manual' } })
    fireEvent.click(screen.getByText('forget'))

    expect(await screen.findByText('error.writeRejected')).toBeDefined()
    expect(screen.queryByText('forgotten')).toBeNull()
    // A refused clear leaves the fields alone, like a refused save does.
    expect(screen.getByPlaceholderText<HTMLInputElement>('appIdPlaceholder').value).toBe('cli_manual')

    fireEvent.click(screen.getByText('qrStart'))
    expect(await screen.findByText('error.generic')).toBeDefined()
  })

  it('offers no write and says so while the provider refuses them', async () => {
    render(<FeishuSection {...props({ ...OFF, writable: false })} />)

    expect(await screen.findByText('readOnly')).toBeDefined()
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('save').closest('button')?.disabled).toBe(true)
    expect(screen.getByText('forget').closest('button')?.disabled).toBe(true)
  })
})
