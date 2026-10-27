// @vitest-environment jsdom
/** Browser approval commands retain their lifecycle across retries, cancellation and page disposal. */
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MuseBrowserLoginId } from '@deepseek-ai/dsh-muse-account/types'
import { MuseAccountSection, type MuseAccountInjected, type MuseAccountSectionProps } from '../src/client/MuseAccountSection.tsx'

// Retain the primitive callback as well as its real disabled DOM presentation:
// queued commands can arrive after the owning component has changed state.
const commands = vi.hoisted(() => new Map<string, () => void>())
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-client-ui-primitives')>(),
  Button: ({ children, onClick, disabled, type }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
  }) => {
    if (onClick && typeof children === 'string') commands.set(children, onClick)
    return <button type={type ?? 'button'} disabled={disabled} onClick={onClick}>{children}</button>
  },
}))

const signedOut = { state: 'signed-out' } as const
const signedIn = { state: 'signed-in', username: 'writer', verified: true } as const
const id = 'browser-lifecycle' as MuseBrowserLoginId
const attempt = { id, code: 'TEST1234', authorizeUrl: 'https://muse.test/approval', expiresAt: 60_000, pollIntervalMs: 1000 }

function props(overrides: Partial<MuseAccountInjected> = {}): MuseAccountSectionProps {
  return { t: (key: string) => key,
    status: async () => ({ ok: true, value: signedOut }),
    login: async () => ({ ok: true, value: { outcome: 'signed-in', status: signedIn } }),
    logout: async () => ({ ok: true, value: signedOut }),
    startBrowserLogin: async () => ({ ok: true, value: attempt }),
    checkBrowserLogin: async () => ({ ok: true, value: { state: 'pending' } }),
    cancelBrowserLogin: async () => ({ ok: true, value: signedOut }),
    ...overrides } as MuseAccountSectionProps
}
beforeEach(() => { vi.spyOn(window, 'open').mockReturnValue(null) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); commands.clear() })

it('distinguishes a saved identity from a service-verified login', async () => {
  render(<MuseAccountSection {...props({ status: async () => ({ ok: true, value: { ...signedIn, verified: false } }) })} />)
  expect(await screen.findByText('verificationPending')).toBeDefined()
  expect(screen.queryByText('verified')).toBeNull()
})

it.each(['expired', 'cancelled'] as const)('returns to sign-in when browser approval is %s', async (state) => {
  render(<MuseAccountSection {...props({ checkBrowserLogin: async () => ({ ok: true, value: { state } }) })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  expect(await screen.findByText(state === 'expired' ? 'browserExpired' : 'browserCancelled')).toBeDefined()
  expect(screen.getByRole('button', { name: 'browserSignIn' })).toBeDefined()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('reopens the same approval page without creating a new attempt', async () => {
  const start = vi.fn<MuseAccountInjected['startBrowserLogin']>(async () => ({ ok: true, value: attempt }))
  render(<MuseAccountSection {...props({ startBrowserLogin: start })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  fireEvent.click(await screen.findByRole('button', { name: 'browserReopen' }))
  expect(window.open).toHaveBeenCalledTimes(2)
  expect(window.open).toHaveBeenLastCalledWith(attempt.authorizeUrl, '_blank', 'noopener,noreferrer')
  expect(start).toHaveBeenCalledOnce()
})

it.each(['muse-account/rate-limited', 'future-refusal', 'transport'])(
  'shows bounded copy when starting approval returns %s', async (mode) => {
    const start = vi.fn<MuseAccountInjected['startBrowserLogin']>()
    if (mode === 'transport') start.mockRejectedValueOnce(new Error('private transport diagnostic'))
    else start.mockResolvedValueOnce({ ok: false, code: mode })
    render(<MuseAccountSection {...props({ startBrowserLogin: start })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
    expect(await screen.findByText(mode === 'muse-account/rate-limited' ? 'error.rateLimited' : 'error.generic')).toBeDefined()
    expect(screen.getByRole('button', { name: 'browserSignIn' }).hasAttribute('disabled')).toBe(false)
    expect(window.open).not.toHaveBeenCalled()
    expect(screen.queryByText('private transport diagnostic')).toBeNull()
  },
)

it('ignores queued starts while busy and while an approval is active', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['startBrowserLogin']>>>()
  const start = vi.fn(() => pending.promise)
  const page = render(<MuseAccountSection {...props({ startBrowserLogin: start })} />)
  const trigger = await screen.findByRole('button', { name: 'browserSignIn' })
  const originalCommand = commands.get('browserSignIn')!
  fireEvent.click(trigger)
  expect(trigger.hasAttribute('disabled')).toBe(true)
  act(() => { commands.get('browserSignIn')!() })
  expect(start).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve({ ok: true, value: attempt }) })
  expect(screen.getByText('browserWaiting')).toBeDefined()
  act(() => { originalCommand() })
  expect(start).toHaveBeenCalledOnce()
  page.unmount()
})

it.each(['success', 'refused', 'rejected'] as const)('cleans up a late %s browser start after page disposal', async (mode) => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['startBrowserLogin']>>>()
  const cancel = vi.fn<MuseAccountInjected['cancelBrowserLogin']>(async () => ({ ok: true, value: signedOut }))
  const page = render(<MuseAccountSection {...props({ startBrowserLogin: () => pending.promise, cancelBrowserLogin: cancel })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  page.unmount()
  await act(async () => {
    if (mode === 'rejected') pending.reject(new Error('private late start'))
    else pending.resolve(mode === 'success' ? { ok: true, value: attempt } : { ok: false, code: 'late-refusal' })
  })
  expect(cancel).toHaveBeenCalledTimes(mode === 'success' ? 1 : 0)
  expect(window.open).not.toHaveBeenCalled()
  expect(page.container.innerHTML).toBe('')
})

it('contains cancellation transport rejection during unmount', async () => {
  const cancel = vi.fn<MuseAccountInjected['cancelBrowserLogin']>().mockRejectedValue(new Error('private cleanup failure'))
  const page = render(<MuseAccountSection {...props({ cancelBrowserLogin: cancel })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  await screen.findByText('browserWaiting')
  await act(async () => { page.unmount() })
  expect(cancel).toHaveBeenCalledWith(id)
  expect(page.container.innerHTML).toBe('')
})

it('polls after a pending response and contains a later polling transport error', async () => {
  const check = vi.fn<MuseAccountInjected['checkBrowserLogin']>()
    .mockResolvedValueOnce({ ok: true, value: { state: 'pending' } })
    .mockRejectedValueOnce(new Error('private poll diagnostic'))
  render(<MuseAccountSection {...props({ checkBrowserLogin: check })} />)
  const trigger = await screen.findByRole('button', { name: 'browserSignIn' })
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(trigger) })
  await act(async () => { await vi.advanceTimersByTimeAsync(attempt.pollIntervalMs) })
  expect(check).toHaveBeenCalledTimes(2)
  expect(screen.getByText('error.generic')).toBeDefined()
  expect(screen.queryByText('private poll diagnostic')).toBeNull()
})

it('ignores a poll rejection after the page has closed', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['checkBrowserLogin']>>>()
  const page = render(<MuseAccountSection {...props({ checkBrowserLogin: () => pending.promise })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  await screen.findByText('browserWaiting')
  page.unmount()
  await act(async () => { pending.reject(new Error('private late poll')) })
  expect(page.container.innerHTML).toBe('')
})

it('uses generic copy for an unrecognized approval refusal and allows checking again', async () => {
  const check = vi.fn<MuseAccountInjected['checkBrowserLogin']>()
    .mockResolvedValueOnce({ ok: false, code: 'future-browser-code' })
    .mockResolvedValueOnce({ ok: true, value: { state: 'cancelled' } })
  render(<MuseAccountSection {...props({ checkBrowserLogin: check })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  fireEvent.click(await screen.findByRole('button', { name: 'browserCheck' }))
  expect(await screen.findByText('browserCancelled')).toBeDefined()
  expect(check).toHaveBeenCalledTimes(2)
})

it('ignores a queued duplicate cancel and a poll completing after that cancel command', async () => {
  const poll = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['checkBrowserLogin']>>>()
  const cancelResult = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['cancelBrowserLogin']>>>()
  const cancel = vi.fn(() => cancelResult.promise), onSignedIn = vi.fn()
  render(<MuseAccountSection {...props({ checkBrowserLogin: () => poll.promise, cancelBrowserLogin: cancel })} onSignedIn={onSignedIn} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  await screen.findByText('browserWaiting')
  const command = commands.get('browserCancel')!
  await act(async () => {
    command(); command()
    poll.resolve({ ok: true, value: { state: 'signed-in', status: signedIn } })
    await Promise.resolve()
  })
  expect(cancel).toHaveBeenCalledOnce()
  expect(onSignedIn).not.toHaveBeenCalled()
  await act(async () => { cancelResult.resolve({ ok: true, value: signedOut }) })
  expect(screen.getByText('browserCancelled')).toBeDefined()
})

it.each(['success', 'rejected'] as const)('ignores a late %s cancellation after disposal', async (mode) => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['cancelBrowserLogin']>>>()
  const onSignedIn = vi.fn()
  const page = render(<MuseAccountSection {...props({ cancelBrowserLogin: () => pending.promise })} onSignedIn={onSignedIn} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  fireEvent.click(await screen.findByRole('button', { name: 'browserCancel' }))
  page.unmount()
  await act(async () => {
    if (mode === 'success') pending.resolve({ ok: true, value: signedIn })
    else pending.reject(new Error('private late cancellation'))
  })
  expect(onSignedIn).not.toHaveBeenCalled()
  expect(page.container.innerHTML).toBe('')
})

it('returns to Feishu sign-in when explicit cancellation fails', async () => {
  render(<MuseAccountSection {...props({ cancelBrowserLogin: async () => { throw new Error('private cancellation detail') } })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserSignIn' }))
  fireEvent.click(await screen.findByRole('button', { name: 'browserCancel' }))
  expect(await screen.findByText('error.generic')).toBeDefined()
  expect(screen.getByRole('button', { name: 'browserSignIn' }).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByText('private cancellation detail')).toBeNull()
})
