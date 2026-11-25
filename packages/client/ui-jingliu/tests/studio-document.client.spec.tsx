// @vitest-environment jsdom
/** Workbench documents receive login codes only while their Studio tab is active. */
import { act, cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { Studio } from '../src/client/Studio.tsx'
import { en } from '../src/client/locales.ts'
import type { WorkbenchLoginResult } from '../src/client/workbench-login.ts'

const origin = 'https://studio.test'
const studioUrl = origin + '/v1/auth/muse/embed'
const challenge = 'h'.repeat(43)

afterEach(cleanup)

function requestLogin(source: Window, requestId: string): void {
  window.dispatchEvent(new MessageEvent('message', {
    source, origin, data: { type: 'muse-workbench-login', requestId, challenge },
  }))
}

it('remounts the workbench when login changes and discards codes after a replacement or unmount', async () => {
  const login = createSnapshotStore(0)
  const subscribe = (listener: () => void) => login.subscribe(listener)
  const getSnapshot = () => login.getSnapshot()
  const replaced = Promise.withResolvers<WorkbenchLoginResult>()
  const unmounted = Promise.withResolvers<WorkbenchLoginResult>()
  type Props = Parameters<typeof Studio>[0]
  const issueLogin = vi.fn<Props['issueLogin']>()
    .mockReturnValueOnce(replaced.promise)
    .mockResolvedValueOnce({ code: 'current-code' })
    .mockReturnValueOnce(unmounted.promise)
  const props: Pick<Props, 'studioUrl' | 'titleKey' | 'issueLogin' | 'useLoginGeneration' | 't'> = {
    studioUrl, titleKey: 'workshopTitle', issueLogin, t: makeTranslate(en),
    useLoginGeneration: select => select(useSyncExternalStore(subscribe, getSnapshot)),
  }
  const view = render(<Studio {...props as Props} />)
  const getFrame = (): HTMLIFrameElement => {
    const frame = view.getByTitle(en.workshopTitle)
    if (!(frame instanceof HTMLIFrameElement)) throw new Error('Expected workbench iframe')
    return frame
  }

  const first = getFrame()
  const firstWindow = first.contentWindow!
  const sendFirst = vi.spyOn(firstWindow, 'postMessage').mockImplementation(() => {})
  expect(view.getByRole('region', { name: en.workshopTitle }).contains(first)).toBe(true)
  expect(first.src).toBe(studioUrl)
  expect(first.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(first.getAttribute('sandbox')).toContain('allow-scripts')
  requestLogin(firstWindow, 'before-switch')
  expect(issueLogin).toHaveBeenCalledExactlyOnceWith(challenge)

  act(() => { login.set(1) })
  const second = getFrame()
  expect(first.isConnected).toBe(false)
  expect(second.src).toBe(studioUrl)
  const secondWindow = second.contentWindow!
  const sendSecond = vi.spyOn(secondWindow, 'postMessage').mockImplementation(() => {})
  replaced.resolve({ code: 'stale-code' })
  await replaced.promise
  expect(sendFirst).not.toHaveBeenCalled()
  expect(sendSecond).not.toHaveBeenCalled()

  requestLogin(secondWindow, 'after-switch')
  await vi.waitFor(() => {
    expect(sendSecond).toHaveBeenCalledExactlyOnceWith({
      type: 'muse-workbench-login-result', requestId: 'after-switch', code: 'current-code',
    }, origin)
  })
  requestLogin(secondWindow, 'before-unmount')
  expect(issueLogin).toHaveBeenCalledTimes(3)
  view.unmount()
  unmounted.resolve({ code: 'unmounted-code' })
  await unmounted.promise
  expect(sendSecond).toHaveBeenCalledOnce()
})
