// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { MuseAccountSection, type MuseAccountInjected, type MuseAccountSectionProps } from '../src/client/MuseAccountSection.tsx'
import { MuseAccountOnboarding } from '../src/client/MuseAccountOnboarding.tsx'
import type { MuseAccountStatus, MuseAccountStatusRequest, MuseBrowserLoginAttempt, MuseBrowserLoginId } from '@deepseek-ai/dsh-muse-account/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SIGNED_OUT: MuseAccountStatus = { state: 'signed-out' }
const SIGNED_IN = { state: 'signed-in', username: 'writer', verified: true } as const satisfies MuseAccountStatus
const ATTEMPT: MuseBrowserLoginAttempt = {
  id: 'feishu-login' as MuseBrowserLoginId, code: 'TEST1234', authorizeUrl: 'https://muse.test/desktop-login',
  expiresAt: 600_000, pollIntervalMs: 2000,
}

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

  it('offers only Feishu browser sign-in without a credential or registration form', async () => {
    const login = vi.fn<MuseAccountInjected['login']>()
    const startBrowserLogin = vi.fn<MuseAccountInjected['startBrowserLogin']>()
      .mockResolvedValue({ ok: false, code: 'muse-account/gateway-unavailable' })
    const page = render(<MuseAccountSection {...props({ login, startBrowserLogin })} />)

    const button = await screen.findByRole('button', { name: 'browserSignIn' })
    expect(screen.getByRole('heading', { name: 'title', level: 3 })).toBeDefined()
    expect(screen.getAllByRole('button')).toEqual([button])
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(page.container.querySelector('input, form')).toBeNull()
    expect(screen.queryByLabelText('username')).toBeNull()
    expect(screen.queryByLabelText('password')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(button)
    await screen.findByText('error.gatewayUnavailable')
    expect(startBrowserLogin).toHaveBeenCalledOnce()
    expect(login).not.toHaveBeenCalled()
  })

  it('keeps the signed-in UI when Host model refresh fails after browser authentication', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const refreshModels = vi.fn(async () => { throw new Error('private model catalog detail') })
    const checkBrowserLogin = vi.fn<MuseAccountInjected['checkBrowserLogin']>(async () => {
      await refreshModels().catch(() => undefined)
      return { ok: true, value: { state: 'signed-in', status: SIGNED_IN } }
    })
    render(<MuseAccountSection {...props({
      startBrowserLogin: async () => ({ ok: true, value: ATTEMPT }), checkBrowserLogin,
    })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
    expect(await screen.findByText('signedIn')).toBeDefined()
    expect(screen.getByText('accountNamed')).toBeDefined()
    expect(screen.queryByText('error.gatewayUnavailable')).toBeNull()
    expect(screen.queryByText('private model catalog detail')).toBeNull()
    expect(refreshModels).toHaveBeenCalledTimes(1)
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
    expect(await screen.findByRole('button', { name: 'browserSignIn' })).toBeDefined()
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

    expect(await screen.findByRole('button', { name: 'browserSignIn' })).toBeDefined()
    expect(status).toHaveBeenNthCalledWith(2, { verify: true })
    expect(screen.queryByText('verified')).toBeNull()
    expect(screen.queryByText('accountNamed')).toBeNull()
  })

  it('shows fixed copy when browser authorization is refused', async () => {
    const startBrowserLogin = vi.fn<MuseAccountInjected['startBrowserLogin']>()
      .mockResolvedValue({ ok: false, code: 'muse-account/gateway-rejected' })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<MuseAccountSection {...props({ startBrowserLogin })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))

    expect(await screen.findByText('error.gatewayRejected')).toBeDefined()
    expect(open).not.toHaveBeenCalled()
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

  it('permits a new browser sign-in after the Host connection drops', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const startBrowserLogin = vi.fn<MuseAccountInjected['startBrowserLogin']>()
      .mockRejectedValueOnce(new Error('transport closed with private detail'))
      .mockResolvedValueOnce({ ok: true, value: ATTEMPT })
    render(<MuseAccountSection {...props({ startBrowserLogin,
      checkBrowserLogin: async () => ({ ok: true, value: { state: 'signed-in', status: SIGNED_IN } }),
    })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
    expect(await screen.findByText('error.generic')).toBeDefined()
    expect(screen.queryByText('transport closed with private detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'browserSignIn' }))
    expect(await screen.findByText('signedIn')).toBeDefined()
    expect(startBrowserLogin).toHaveBeenCalledTimes(2)
  })

  it('offers retry when the initial Host status request is rejected', async () => {
    const status = vi.fn()
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValueOnce({ ok: true as const, value: SIGNED_OUT })
    render(<MuseAccountSection {...props({ status })} />)

    expect(await screen.findByText('error.generic')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(await screen.findByRole('button', { name: 'browserSignIn' })).toBeDefined()
  })
})

it('uses the shared Feishu sign-in to advance the desktop first-run flow', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  const complete = vi.fn(), login = vi.fn<MuseAccountInjected['login']>()
  const account = props({ login,
    startBrowserLogin: async () => ({ ok: true, value: ATTEMPT }),
    checkBrowserLogin: async () => ({ ok: true, value: { state: 'signed-in', status: SIGNED_IN } }),
  })
  const page = render(<MuseAccountOnboarding {...account} stepId="muse-account" complete={complete} openSection={vi.fn()} />)
  expect(await screen.findByRole('dialog', { name: 'onboardingTitle' })).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  await waitFor(() => { expect(complete).toHaveBeenCalledOnce() })
  expect(login).not.toHaveBeenCalled()
  expect(page.container.querySelector('input, form')).toBeNull()
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

it('does not advance a dismissed onboarding page when its pending browser login succeeds', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  const complete = vi.fn()
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['checkBrowserLogin']>>>()
  const cancelBrowserLogin = vi.fn<MuseAccountInjected['cancelBrowserLogin']>()
    .mockResolvedValue({ ok: true, value: SIGNED_OUT })
  const page = render(<MuseAccountOnboarding {...props({
    startBrowserLogin: async () => ({ ok: true, value: ATTEMPT }),
    checkBrowserLogin: () => pending.promise, cancelBrowserLogin,
  })} stepId="muse-account" complete={complete} openSection={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  await screen.findByText('browserWaiting')
  fireEvent.click(screen.getByRole('button', { name: 'onboardingLater' }))
  page.unmount()
  await act(async () => { pending.resolve({ ok: true, value: { state: 'signed-in', status: SIGNED_IN } }) })
  expect(complete).toHaveBeenCalledOnce()
  expect(cancelBrowserLogin).toHaveBeenCalledWith(ATTEMPT.id)
})

it.each([
  ['verify', false], ['verify', true], ['logout', false], ['logout', true],
] as const)('ignores %s completion after page close (rejected=%s)', async (operation, reject) => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['status']>>>()
  const onSignedIn = vi.fn()
  const status = vi.fn<MuseAccountInjected['status']>().mockResolvedValueOnce({ ok: true, value: SIGNED_IN })
    .mockImplementation(() => pending.promise)
  const page = render(<MuseAccountSection
    {...props({ status, logout: () => pending.promise })} onSignedIn={onSignedIn}
  />)
  fireEvent.click(await screen.findByRole('button', { name: operation === 'logout' ? 'signOut' : 'verify' }))
  onSignedIn.mockClear()
  page.unmount()
  await act(async () => {
    if (reject) pending.reject(new Error('private delayed failure'))
    else pending.resolve({ ok: true, value: SIGNED_OUT })
  })
  expect(onSignedIn).not.toHaveBeenCalled()
  expect(screen.queryByText('private delayed failure')).toBeNull()
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
  expect(screen.getByRole('heading', { name: 'title', level: 3 })).toBeDefined()
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

it('renders unknown initial and browser refusal codes as fixed generic copy', async () => {
  const status = vi.fn<MuseAccountInjected['status']>()
    .mockResolvedValueOnce({ ok: false, code: 'future-initial-code' })
    .mockResolvedValueOnce({ ok: true, value: SIGNED_OUT })
  const startBrowserLogin = vi.fn<MuseAccountInjected['startBrowserLogin']>()
    .mockResolvedValue({ ok: false, code: 'future-browser-code' })
  render(<MuseAccountSection {...props({ status, startBrowserLogin })} />)
  expect(await screen.findByText('error.generic')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  expect(await screen.findByText('error.generic')).toBeDefined()
  expect(startBrowserLogin).toHaveBeenCalledOnce()
})

it('opens only the supplied management URL for a verified administrator', async () => {
  const adminUrl = 'https://muse.test/admin/issues?view=open'
  const account: MuseAccountStatus = { ...SIGNED_IN, admin: true, adminUrl }
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  render(<MuseAccountSection {...props({ status: async () => ({ ok: true, value: account }) })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'adminManagement' }))
  expect(screen.getByRole('heading', { name: 'title', level: 3 })).toBeDefined()
  expect(open).toHaveBeenCalledExactlyOnceWith(adminUrl, '_blank', 'noopener,noreferrer')
})

it.each([
  ['ordinary account', { ...SIGNED_IN, admin: false, adminUrl: 'https://muse.test/admin' }],
  ['missing administrator claim', { ...SIGNED_IN, adminUrl: 'https://muse.test/admin' }],
  ['unverified account', { ...SIGNED_IN, verified: false, admin: true, adminUrl: 'https://muse.test/admin' }],
  ['missing management URL', { ...SIGNED_IN, admin: true }],
  ['signed out', SIGNED_OUT],
] satisfies ReadonlyArray<readonly [string, MuseAccountStatus]>)(
  'hides management for %s', async (_name, account) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<MuseAccountSection {...props({ status: async () => ({ ok: true, value: account }) })} />)
    await screen.findByText(account.state === 'signed-in' ? 'accountNamed' : 'description')
    await waitFor(() => { expect(screen.queryByText('loading')).toBeNull() })
    expect(screen.queryByRole('button', { name: 'adminManagement' })).toBeNull()
    expect(open).not.toHaveBeenCalled()
  },
)

it('removes management access when a fresh verification no longer identifies an administrator', async () => {
  const status = vi.fn<MuseAccountInjected['status']>()
    .mockResolvedValueOnce({ ok: true, value: { ...SIGNED_IN, admin: true, adminUrl: 'https://muse.test/admin' } })
    .mockResolvedValueOnce({ ok: true, value: { ...SIGNED_IN, admin: false } })
  render(<MuseAccountSection {...props({ status })} />)
  await screen.findByRole('button', { name: 'adminManagement' })
  fireEvent.click(screen.getByRole('button', { name: 'verify' }))
  await waitFor(() => { expect(screen.queryByRole('button', { name: 'adminManagement' })).toBeNull() })
})

it.each(['refused', 'rejected'] as const)('hides prior administrator access while verification is pending and after it is %s', async (outcome) => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['status']>>>()
  const status = vi.fn<MuseAccountInjected['status']>()
    .mockResolvedValueOnce({ ok: true, value: { ...SIGNED_IN, admin: true, adminUrl: 'https://muse.test/admin' } })
    .mockImplementationOnce(() => pending.promise)
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  render(<MuseAccountSection {...props({ status })} />)
  await screen.findByRole('button', { name: 'adminManagement' })
  fireEvent.click(screen.getByRole('button', { name: 'verify' }))
  expect(screen.queryByRole('button', { name: 'adminManagement' })).toBeNull()
  expect(screen.getByText('accountNamed')).toBeDefined()
  await act(async () => {
    if (outcome === 'rejected') pending.reject(new Error('private verification transport detail'))
    else pending.resolve({ ok: false, code: 'muse-account/gateway-unavailable' })
  })
  expect(screen.getByText(outcome === 'rejected' ? 'error.generic' : 'error.gatewayUnavailable')).toBeDefined()
  expect(screen.queryByText('private verification transport detail')).toBeNull()
  expect(screen.queryByRole('button', { name: 'adminManagement' })).toBeNull()
  expect(screen.getByText('verificationPending')).toBeDefined()
  expect(screen.getByText('accountNamed')).toBeDefined()
  expect(open).not.toHaveBeenCalled()
})
