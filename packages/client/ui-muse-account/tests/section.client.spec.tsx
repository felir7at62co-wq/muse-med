// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { MuseAccountSection, type MuseAccountInjected, type MuseAccountSectionProps } from '../src/client/MuseAccountSection.tsx'
import { MuseAccountOnboarding } from '../src/client/MuseAccountOnboarding.tsx'
import type { MuseAccountStatus, MuseAccountStatusRequest } from '@deepseek-ai/dsh-muse-account/types'

afterEach(() => {
  cleanup()
})

const SIGNED_OUT: MuseAccountStatus = { state: 'signed-out' }
const SIGNED_IN = { state: 'signed-in', username: 'writer', verified: true } as const satisfies MuseAccountStatus

function props(overrides: Partial<MuseAccountInjected> = {}): MuseAccountSectionProps {
  const injected: MuseAccountInjected = {
    status: vi.fn(async () => ({ ok: true as const, value: SIGNED_OUT })),
    login: vi.fn(async () => ({ ok: true as const, value: { outcome: 'signed-in' as const, status: SIGNED_IN } })),
    logout: vi.fn(async () => ({ ok: true as const, value: SIGNED_OUT })),
    ...overrides,
  }
  return { t: (key: string) => key, ...injected } as MuseAccountSectionProps
}

describe('MuseAccountSection', () => {
  it('requires credentials and signs in without registration by default', async () => {
    const login = vi.fn(async () => ({ ok: true as const, value: { outcome: 'signed-in' as const, status: SIGNED_IN } }))
    render(<MuseAccountSection {...props({ login })} />)

    const submit = await screen.findByRole('button', { name: 'signIn' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('username'), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
    expect(screen.getByLabelText<HTMLInputElement>('password').type).toBe('password')
    fireEvent.click(submit)

    expect(login).toHaveBeenCalledWith({ username: 'writer', password: 'private-password', registerIfMissing: false })
    expect(await screen.findByText('signedIn')).toBeDefined()
    expect(screen.queryByDisplayValue('private-password')).toBeNull()
    expect(screen.getByText('accountNamed')).toBeDefined()
  })

  it('reports a newly registered account after the user selects registration', async () => {
    const login = vi.fn(async () => ({ ok: true as const, value: { outcome: 'registered' as const, status: SIGNED_IN } }))
    render(<MuseAccountSection {...props({ login })} />)

    fireEvent.change(await screen.findByLabelText('username'), { target: { value: 'new-writer' } })
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'registerIfMissing' }))
    fireEvent.click(screen.getByRole('button', { name: 'signIn' }))

    expect(login).toHaveBeenCalledWith({ username: 'new-writer', password: 'private-password', registerIfMissing: true })
    expect(await screen.findByText('registered')).toBeDefined()
  })

  it('leaves registration disabled until the user selects it', async () => {
    const login = vi.fn(async () => ({ ok: true as const, value: { outcome: 'signed-in' as const, status: SIGNED_IN } }))
    render(<MuseAccountSection {...props({ login })} />)

    fireEvent.change(await screen.findByLabelText('username'), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
    const registration = screen.getByRole<HTMLInputElement>('checkbox', { name: 'registerIfMissing' })
    expect(registration.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'signIn' }))

    expect(login).toHaveBeenCalledWith({ username: 'writer', password: 'private-password', registerIfMissing: false })
  })

  it('checks an existing session on request and signs out', async () => {
    const status = vi.fn(async ({ verify }: MuseAccountStatusRequest) => ({
      ok: true as const,
      value: verify ? SIGNED_IN : { ...SIGNED_IN, verified: false },
    }))
    const logout = vi.fn(async () => ({ ok: true as const, value: SIGNED_OUT }))
    render(<MuseAccountSection {...props({ status, logout })} />)

    expect(await screen.findByText('verificationPending')).toBeDefined()
    expect(status).toHaveBeenCalledWith({ verify: false })
    fireEvent.click(screen.getByRole('button', { name: 'verify' }))
    expect(await screen.findByText('verified')).toBeDefined()
    expect(status).toHaveBeenCalledWith({ verify: true })
    fireEvent.click(screen.getByRole('button', { name: 'signOut' }))
    expect(logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'signIn' })).toBeDefined()
  })

  it('shows fixed copy for a login refusal without exposing the password', async () => {
    const login = vi.fn(async () => ({ ok: false as const, code: 'muse-account/invalid-credentials' }))
    render(<MuseAccountSection {...props({ login })} />)

    fireEvent.change(await screen.findByLabelText('username'), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'signIn' }))

    expect(await screen.findByText('error.invalidCredentials')).toBeDefined()
    expect(screen.queryByDisplayValue('private-password')).toBeNull()
    expect(screen.queryByText('private-password')).toBeNull()
  })

  it('offers retry after a status refusal', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, code: 'muse-account/gateway-unavailable' })
      .mockResolvedValueOnce({ ok: true as const, value: SIGNED_OUT })
    render(<MuseAccountSection {...props({ status })} />)

    expect(await screen.findByText('error.gatewayUnavailable')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'signIn' })).toBeDefined() })
  })

  it('clears a password and permits a new sign-in after the Host connection drops', async () => {
    const login = vi.fn()
      .mockRejectedValueOnce(new Error('transport closed with private-password'))
      .mockResolvedValueOnce({ ok: true as const, value: { outcome: 'signed-in' as const, status: SIGNED_IN } })
    render(<MuseAccountSection {...props({ login })} />)

    fireEvent.change(await screen.findByLabelText('username'), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'signIn' }))

    expect(await screen.findByText('error.generic')).toBeDefined()
    expect(screen.queryByDisplayValue('private-password')).toBeNull()
    expect(screen.queryByText('transport closed with private-password')).toBeNull()
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'new-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'signIn' }))
    expect(await screen.findByText('signedIn')).toBeDefined()
    expect(login).toHaveBeenCalledTimes(2)
  })

  it('offers retry when the initial Host status request is rejected', async () => {
    const status = vi.fn()
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValueOnce({ ok: true as const, value: SIGNED_OUT })
    render(<MuseAccountSection {...props({ status })} />)

    expect(await screen.findByText('error.generic')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(await screen.findByRole('button', { name: 'signIn' })).toBeDefined()
  })
})

it('uses Muse sign-in to advance the desktop first-run flow', async () => {
  const complete = vi.fn()
  const account = props()
  render(<MuseAccountOnboarding {...account} stepId="muse-account" complete={complete} openSection={vi.fn()} />)
  expect(await screen.findByRole('dialog', { name: 'onboardingTitle' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('username'), { target: { value: 'writer' } })
  fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'signIn' }))
  await waitFor(() => { expect(complete).toHaveBeenCalledOnce() })
  expect(screen.queryByDisplayValue('private-password')).toBeNull()
})

it.each([false, true])('restores the page inert state after onboarding (previous=%s)', async (previous) => {
  const root = document.createElement('main')
  root.id = 'root'
  root.inert = previous
  document.body.append(root)
  onTestFinished(() => { root.remove() })
  const complete = vi.fn()
  const page = render(<MuseAccountOnboarding {...props()} stepId="muse-account" complete={complete} openSection={vi.fn()} />)
  expect(root.inert).toBe(true)
  fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
  expect(complete).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'onboardingLater' }))
  expect(complete).toHaveBeenCalledOnce()
  page.unmount()
  expect(root.inert).toBe(previous)
  root.remove()
})

it('advances an existing authenticated account and displays its workspace', async () => {
  const onSignedIn = vi.fn()
  const status = vi.fn(async () => ({ ok: true as const, value: { ...SIGNED_IN, workspaceLabel: 'studio' } }))
  render(<MuseAccountSection {...props({ status })} onSignedIn={onSignedIn} />)
  expect(await screen.findByText('workspaceNamed')).toBeDefined()
  expect(onSignedIn).toHaveBeenCalledOnce()
})

it.each(['resolve', 'reject'] as const)('ignores an initial account request that %s after unmount', async (mode) => {
  let resolve!: (value: { ok: true; value: MuseAccountStatus }) => void
  let reject!: (reason: Error) => void
  const pending = new Promise<{ ok: true; value: MuseAccountStatus }>((yes, no) => { resolve = yes; reject = no })
  const onSignedIn = vi.fn()
  const page = render(<MuseAccountSection {...props({ status: () => pending })} onSignedIn={onSignedIn} />)
  expect(screen.getByText('loading')).toBeDefined()
  page.unmount()
  await act(async () => {
    if (mode === 'resolve') resolve({ ok: true, value: SIGNED_IN })
    else reject(new Error('private late transport detail'))
    await pending.catch(() => undefined)
  })
  expect(onSignedIn).not.toHaveBeenCalled()
  expect(screen.queryByText('private late transport detail')).toBeNull()
})

it.each(['muse-account/rate-limited', 'future-refusal', 'transport'])(
  'recovers verification after %s without losing the account', async (code) => {
    const status = vi.fn<MuseAccountInjected['status']>()
      .mockResolvedValueOnce({ ok: true, value: SIGNED_IN })
    if (code === 'transport') status.mockRejectedValueOnce(new Error('private wire detail'))
    else status.mockResolvedValueOnce({ ok: false, code })
    status.mockResolvedValueOnce({ ok: true, value: SIGNED_IN })
    render(<MuseAccountSection {...props({ status })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'verify' }))
    expect(await screen.findByText(code === 'muse-account/rate-limited' ? 'error.rateLimited' : 'error.generic')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'verify' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(3) })
    expect(screen.getByText('accountNamed')).toBeDefined()
    expect(screen.queryByText('private wire detail')).toBeNull()
  },
)

it.each(['muse-account/storage-failed', 'future-refusal', 'transport'])(
  'keeps the identity when logout returns %s and allows a retry', async (code) => {
    const logout = vi.fn<MuseAccountInjected['logout']>()
    if (code === 'transport') logout.mockRejectedValueOnce(new Error('private session cookie'))
    else logout.mockResolvedValueOnce({ ok: false, code })
    logout.mockResolvedValueOnce({ ok: true, value: SIGNED_OUT })
    render(<MuseAccountSection {...props({ status: async () => ({ ok: true, value: SIGNED_IN }), logout })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'signOut' }))
    expect(await screen.findByText(code === 'muse-account/storage-failed' ? 'error.storageFailed' : 'error.generic')).toBeDefined()
    expect(screen.getByText('accountNamed')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'signOut' }))
    expect(await screen.findByText('signedOut')).toBeDefined()
    expect(screen.queryByText('private session cookie')).toBeNull()
  },
)

it('renders unknown initial and login refusal codes as fixed generic copy', async () => {
  const status = vi.fn<MuseAccountInjected['status']>()
    .mockResolvedValueOnce({ ok: false, code: 'future-initial-code' })
    .mockResolvedValueOnce({ ok: true, value: SIGNED_OUT })
  render(<MuseAccountSection {...props({ status, login: async () => ({ ok: false, code: 'future-login-code' }) })} />)
  expect(await screen.findByText('error.generic')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  fireEvent.change(await screen.findByLabelText('username'), { target: { value: ' writer ' } })
  fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'signIn' }))
  expect(await screen.findByText('error.generic')).toBeDefined()
  expect(screen.queryByDisplayValue('private-password')).toBeNull()
})

it('rejects empty and repeated form submissions while one sign-in is pending', async () => {
  let resolve!: (value: { ok: false; code: string }) => void
  const login = vi.fn<MuseAccountInjected['login']>(() => new Promise((yes) => { resolve = yes }))
  render(<MuseAccountSection {...props({ login })} />)
  const username = await screen.findByLabelText('username'), form = username.closest('form')!
  fireEvent.submit(form)
  fireEvent.change(username, { target: { value: 'writer' } })
  fireEvent.submit(form)
  expect(login).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(login).toHaveBeenCalledExactlyOnceWith({ username: 'writer', password: 'private-password', registerIfMissing: false })
  await act(async () => { resolve({ ok: false, code: 'muse-account/invalid-credentials' }) })
  expect(screen.getByText('error.invalidCredentials')).toBeDefined()
})
