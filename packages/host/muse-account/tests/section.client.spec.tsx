// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MuseAccountSection, type MuseAccountInjected, type MuseAccountSectionProps } from '../src/client/MuseAccountSection.tsx'
import { MuseAccountOnboarding } from '../src/client/MuseAccountOnboarding.tsx'
import type { MuseAccountStatus, MuseAccountStatusRequest } from '../src/types.ts'

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
