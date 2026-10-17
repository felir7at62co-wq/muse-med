// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { MuseAccountSection, type MuseAccountInjected, type MuseAccountSectionProps } from '../src/client/MuseAccountSection.tsx'
import { MuseAccountOnboarding } from '../src/client/MuseAccountOnboarding.tsx'
import type { MuseAccountStatus, MuseAccountStatusRequest } from '@deepseek-ai/dsh-muse-account/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SIGNED_OUT: MuseAccountStatus = { state: 'signed-out' }
const SIGNED_IN = { state: 'signed-in', username: 'writer', verified: true } as const satisfies MuseAccountStatus

function props(overrides: Partial<MuseAccountInjected> = {}): MuseAccountSectionProps {
  const injected: MuseAccountInjected = {
    status: vi.fn(async () => ({ ok: true as const, value: SIGNED_OUT })),
    login: vi.fn(async () => ({ ok: true as const, value: { outcome: 'signed-in' as const, status: SIGNED_IN } })),
    logout: vi.fn(async () => ({ ok: true as const, value: SIGNED_OUT })),
    startBrowserLogin: vi.fn(async () => ({ ok: false as const, code: 'muse-account/gateway-unavailable' })),
    checkBrowserLogin: vi.fn(async () => ({ ok: true as const, value: { state: 'pending' as const } })),
    cancelBrowserLogin: vi.fn(async () => ({ ok: true as const, value: SIGNED_OUT })),
    ...overrides,
  }
  return { t: (key: string) => key, ...injected } as MuseAccountSectionProps
}

describe('MuseAccountSection', () => {
  it.each(['saved', 'failed'] as const)('shows the actual account after cancellation races a commit: %s', async (outcome) => {
    const id = 'attempt' as import('@deepseek-ai/dsh-muse-account/types').MuseBrowserLoginId
    vi.spyOn(window, 'open').mockReturnValue(null)
    const cancelBrowserLogin = vi.fn<MuseAccountInjected['cancelBrowserLogin']>().mockResolvedValue(outcome === 'saved'
      ? { ok: true, value: SIGNED_IN } : { ok: false, code: 'muse-account/gatewayUnavailable' })
    render(<MuseAccountSection {...props({ cancelBrowserLogin,
      startBrowserLogin: async () => ({ ok: true, value: { id, code: 'A1B2C3D4', authorizeUrl: 'https://muse.test/', expiresAt: Date.now() + 60_000, pollIntervalMs: 2000 } }),
      checkBrowserLogin: async () => ({ ok: true, value: { state: 'pending' } }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
    fireEvent.click(await screen.findByRole('button', { name: 'browserCancel' }))
    expect(await screen.findByText(outcome === 'saved' ? 'signedIn' : 'error.generic')).toBeDefined()
    expect(screen.queryByText('browserCancelled')).toBeNull()
  })

  it('recovers an interrupted result check without starting or opening another login', async () => {
    const id = 'attempt' as import('@deepseek-ai/dsh-muse-account/types').MuseBrowserLoginId
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const startBrowserLogin = vi.fn<MuseAccountInjected['startBrowserLogin']>().mockResolvedValue({ ok: true,
      value: { id, code: 'A1B2C3D4', authorizeUrl: 'https://muse.test/', expiresAt: Date.now() + 60_000, pollIntervalMs: 2000 } })
    const checkBrowserLogin = vi.fn<MuseAccountInjected['checkBrowserLogin']>()
      .mockResolvedValueOnce({ ok: false, code: 'muse-account/gateway-unavailable' })
      .mockResolvedValueOnce({ ok: true, value: { state: 'signed-in', status: SIGNED_IN } })
    render(<MuseAccountSection {...props({ startBrowserLogin, checkBrowserLogin })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
    fireEvent.click(await screen.findByRole('button', { name: 'browserCheck' }))
    expect(await screen.findByText('signedIn')).toBeDefined()
    expect(startBrowserLogin).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledOnce()
  })

  it('opens browser approval and automatically shows the saved account after polling', async () => {
    const id = 'attempt' as import('@deepseek-ai/dsh-muse-account/types').MuseBrowserLoginId
    const startBrowserLogin = vi.fn(async () => ({ ok: true as const, value: {
      id, code: 'A1B2C3D4', authorizeUrl: 'https://muse.test/desktop-login?attempt=attempt', expiresAt: Date.now() + 600_000, pollIntervalMs: 2000,
    } }))
    const checkBrowserLogin = vi.fn<MuseAccountInjected['checkBrowserLogin']>()
      .mockResolvedValueOnce({ ok: true, value: { state: 'pending' } })
      .mockResolvedValueOnce({ ok: true, value: { state: 'signed-in', status: SIGNED_IN } })
    const open = vi.spyOn(window, 'open').mockReturnValue(null), onSignedIn = vi.fn()
    const page = render(<MuseAccountSection {...props({ startBrowserLogin, checkBrowserLogin })} onSignedIn={onSignedIn} />)
    const button = await screen.findByRole('button', { name: 'browserSignIn' })
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(button) })
    expect(open).toHaveBeenCalledExactlyOnceWith('https://muse.test/desktop-login?attempt=attempt', '_blank', 'noopener,noreferrer')
    expect(checkBrowserLogin).toHaveBeenCalledExactlyOnceWith(id)
    expect(screen.getByText('browserWaiting')).toBeDefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByText('signedIn')).toBeDefined()
    expect(onSignedIn).toHaveBeenCalledOnce()
    page.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an approval when the page closes and ignores its late result', async () => {
    const id = 'attempt' as import('@deepseek-ai/dsh-muse-account/types').MuseBrowserLoginId
    const cancelBrowserLogin = vi.fn(async () => ({ ok: true as const, value: SIGNED_OUT }))
    let finish!: (value: Awaited<ReturnType<MuseAccountInjected['checkBrowserLogin']>>) => void
    const onSignedIn = vi.fn()
    vi.spyOn(window, 'open').mockReturnValue(null)
    const page = render(<MuseAccountSection {...props({
      startBrowserLogin: async () => ({ ok: true, value: { id, code: 'A1B2C3D4', authorizeUrl: 'https://muse.test/', expiresAt: Date.now() + 60_000, pollIntervalMs: 2000 } }),
      checkBrowserLogin: () => new Promise((resolve) => { finish = resolve }), cancelBrowserLogin,
    })} onSignedIn={onSignedIn} />)
    fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
    await screen.findByText('browserWaiting')
    page.unmount()
    expect(cancelBrowserLogin).toHaveBeenCalledWith(id)
    await act(async () => { finish({ ok: true, value: { state: 'signed-in', status: SIGNED_IN } }) })
    expect(onSignedIn).not.toHaveBeenCalled()
  })

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

  it('keeps the signed-in UI when Host model refresh fails after authentication', async () => {
    const refreshModels = vi.fn(async () => { throw new Error('private model catalog detail') })
    const login = vi.fn(async () => {
      await refreshModels().catch(() => undefined)
      return { ok: true as const, value: { outcome: 'signed-in' as const, status: SIGNED_IN } }
    })
    render(<MuseAccountSection {...props({ login })} />)

    const submit = await screen.findByRole('button', { name: 'signIn' })
    fireEvent.change(screen.getByLabelText('username'), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
    fireEvent.click(submit)

    expect(await screen.findByText('signedIn')).toBeDefined()
    expect(screen.getByText('accountNamed')).toBeDefined()
    expect(screen.queryByText('error.gatewayUnavailable')).toBeNull()
    expect(screen.queryByText('private model catalog detail')).toBeNull()
    expect(refreshModels).toHaveBeenCalledTimes(1)
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

  it('revalidates an existing session after verification and reopening, then signs out', async () => {
    const status = vi.fn(async ({ verify }: MuseAccountStatusRequest) => ({
      ok: true as const,
      value: verify ? SIGNED_IN : { ...SIGNED_IN, verified: false },
    }))
    const logout = vi.fn(async () => ({ ok: true as const, value: SIGNED_OUT }))
    const account = props({ status, logout })
    const page = render(<MuseAccountSection {...account} />)

    expect(await screen.findByText('verified')).toBeDefined()
    expect(status).toHaveBeenNthCalledWith(1, { verify: true })
    fireEvent.click(screen.getByRole('button', { name: 'verify' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    expect(status).toHaveBeenNthCalledWith(2, { verify: true })
    page.unmount()
    render(<MuseAccountSection {...account} />)
    expect(await screen.findByText('verified')).toBeDefined()
    expect(screen.queryByText('verificationPending')).toBeNull()
    expect(status).toHaveBeenNthCalledWith(3, { verify: true })
    fireEvent.click(screen.getByRole('button', { name: 'signOut' }))
    expect(logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'signIn' })).toBeDefined()
  })

  it('shows sign-in when the gateway rejects the session after reopening', async () => {
    const status = vi.fn<MuseAccountInjected['status']>()
      .mockResolvedValueOnce({ ok: true, value: SIGNED_IN })
      .mockResolvedValueOnce({ ok: true, value: SIGNED_OUT })
    const account = props({ status })
    const page = render(<MuseAccountSection {...account} />)
    expect(await screen.findByText('verified')).toBeDefined()
    page.unmount()
    render(<MuseAccountSection {...account} />)

    expect(await screen.findByRole('button', { name: 'signIn' })).toBeDefined()
    expect(status).toHaveBeenNthCalledWith(2, { verify: true })
    expect(screen.queryByText('verified')).toBeNull()
    expect(screen.queryByText('accountNamed')).toBeNull()
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

  it('retries online verification when reopening after a successful check encounters a gateway outage', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: SIGNED_IN })
      .mockResolvedValueOnce({ ok: false as const, code: 'muse-account/gateway-unavailable' })
      .mockResolvedValueOnce({ ok: true as const, value: SIGNED_IN })
    const account = props({ status })
    const page = render(<MuseAccountSection {...account} />)
    expect(await screen.findByText('verified')).toBeDefined()
    page.unmount()
    render(<MuseAccountSection {...account} />)

    expect(await screen.findByText('error.gatewayUnavailable')).toBeDefined()
    expect(screen.queryByText('verified')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(await screen.findByText('verified')).toBeDefined()
    expect(status).toHaveBeenNthCalledWith(2, { verify: true })
    expect(status).toHaveBeenNthCalledWith(3, { verify: true })
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

it('advances onboarding when retry confirms an already saved login', async () => {
  const complete = vi.fn()
  const status = vi.fn<MuseAccountInjected['status']>()
    .mockResolvedValueOnce({ ok: false, code: 'muse-account/gateway-unavailable' })
    .mockResolvedValueOnce({ ok: true, value: SIGNED_IN })
  render(<MuseAccountOnboarding {...props({ status })} stepId="muse-account" complete={complete} openSection={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'retry' }))
  await screen.findByText('verified')
  expect(complete).toHaveBeenCalledOnce()
})

it('does not advance a dismissed onboarding page when its pending login succeeds', async () => {
  const complete = vi.fn()
  let finish!: (value: Awaited<ReturnType<MuseAccountInjected['login']>>) => void
  const login: MuseAccountInjected['login'] = () => new Promise((resolve) => { finish = resolve })
  const page = render(<MuseAccountOnboarding {...props({ login })} stepId="muse-account" complete={complete} openSection={vi.fn()} />)
  fireEvent.change(await screen.findByLabelText('username'), { target: { value: 'writer' } })
  fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'signIn' }))
  fireEvent.click(screen.getByRole('button', { name: 'onboardingLater' }))
  page.unmount()
  await act(async () => { finish({ ok: true, value: { outcome: 'signed-in', status: SIGNED_IN } }) })
  expect(complete).toHaveBeenCalledOnce()
})

it.each(['verify', 'login', 'logout'] as const)('ignores %s completion after page close', async (operation) => {
  for (const reject of [false, true]) {
    let finishStatus!: (value: Awaited<ReturnType<MuseAccountInjected['status']>>) => void
    let finishLogin!: (value: Awaited<ReturnType<MuseAccountInjected['login']>>) => void
    let fail!: (reason: Error) => void
    const statusPending = new Promise<Awaited<ReturnType<MuseAccountInjected['status']>>>((resolve, no) => {
      finishStatus = resolve
      if (operation !== 'login') fail = no
    })
    const loginPending = new Promise<Awaited<ReturnType<MuseAccountInjected['login']>>>((resolve, no) => {
      finishLogin = resolve
      if (operation === 'login') fail = no
    })
    const onSignedIn = vi.fn()
    const status = vi.fn<MuseAccountInjected['status']>().mockResolvedValueOnce({ ok: true, value: operation === 'login' ? SIGNED_OUT : SIGNED_IN })
    status.mockImplementation(() => statusPending)
    const page = render(<MuseAccountSection
      {...props({ status, login: () => loginPending, logout: () => statusPending })} onSignedIn={onSignedIn}
    />)
    if (operation === 'login') {
      fireEvent.change(await screen.findByLabelText('username'), { target: { value: 'writer' } })
      fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private-password' } })
    }
    fireEvent.click(await screen.findByRole('button', { name: operation === 'login' ? 'signIn' : operation === 'logout' ? 'signOut' : 'verify' }))
    onSignedIn.mockClear()
    page.unmount()
    await act(async () => {
      if (reject) fail(new Error('private delayed failure'))
      else if (operation === 'login') finishLogin({ ok: true, value: { outcome: 'signed-in', status: SIGNED_IN } })
      else finishStatus({ ok: true, value: SIGNED_OUT })
    })
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(screen.queryByText('private delayed failure')).toBeNull()
  }
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
