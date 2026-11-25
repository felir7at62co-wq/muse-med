// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from 'vitest'
import { bindWorkbenchLogin, type WorkbenchLoginResult } from '../src/client/workbench-login.ts'

const origin = 'https://studio.test'
const login = { type: 'muse-workbench-login', requestId: 'req-1', challenge: 'h'.repeat(43) }

function fixture() {
  const frame = document.body.appendChild(document.createElement('iframe'))
  onTestFinished(() => { frame.remove() })
  const target = frame.contentWindow!
  const send = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined)
  const issue = vi.fn<(challenge: string) => Promise<WorkbenchLoginResult>>()
  const dispose = bindWorkbenchLogin(frame, origin, issue)
  onTestFinished(dispose)
  const receive = (data: unknown = login, from = target, sender = origin) =>
    window.dispatchEvent(new MessageEvent('message', { source: from, origin: sender, data }))
  return { frame, send, issue, dispose, receive }
}

it('accepts only the active document and configured origin; returns a code only to that origin', async () => {
  const { issue, send, receive } = fixture()
  issue.mockResolvedValue({ code: 'issued-code' })
  receive(login, window)
  receive(login, undefined, 'https://other.test')
  receive({ ...login, challenge: 'short' })
  receive({ ...login, requestId: {} })
  expect(issue).not.toHaveBeenCalled()
  receive({ ...login, audience: 'script-workshop' })
  expect(issue).toHaveBeenCalledExactlyOnceWith(login.challenge)
  await Promise.resolve()
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'muse-workbench-login-result', requestId: 'req-1', code: 'issued-code' }, origin)
})

it.each(['navigation', 'unmount'] as const)('drops a pending code after %s', async (event) => {
  const { frame, issue, send, receive, dispose } = fixture()
  const pending = Promise.withResolvers<WorkbenchLoginResult>()
  issue.mockReturnValue(pending.promise)
  receive()
  if (event === 'navigation') frame.dispatchEvent(new Event('load'))
  else dispose()
  pending.resolve({ code: 'stale-code' })
  await Promise.resolve()
  expect(send).not.toHaveBeenCalled()
  if (event === 'unmount') {
    receive()
    expect(issue).toHaveBeenCalledTimes(1)
  }
})

it('reports a safe reason when sign-in is required or a request cannot complete', async () => {
  const { issue, send, receive } = fixture()
  issue.mockResolvedValueOnce({ error: 'sign-in-required' }).mockRejectedValueOnce(new Error('private response'))
  receive()
  await Promise.resolve()
  expect(send).toHaveBeenLastCalledWith({ type: 'muse-workbench-login-result', requestId: 'req-1', error: 'sign-in-required' }, origin)
  receive()
  await Promise.resolve()
  expect(send).toHaveBeenLastCalledWith({ type: 'muse-workbench-login-result', requestId: 'req-1', error: 'unavailable' }, origin)
})

it('returns unavailable for a second login while the original request is still pending', async () => {
  const { issue, send, receive } = fixture()
  const pending = Promise.withResolvers<WorkbenchLoginResult>()
  issue.mockReturnValue(pending.promise)
  receive()
  receive({ ...login, requestId: 'req-2' })
  expect(issue).toHaveBeenCalledExactlyOnceWith(login.challenge)
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'muse-workbench-login-result', requestId: 'req-2', error: 'unavailable' }, origin)

  pending.resolve({ code: 'issued-code' })
  await pending.promise
  expect(send).toHaveBeenLastCalledWith({ type: 'muse-workbench-login-result', requestId: 'req-1', code: 'issued-code' }, origin)
})

it('drops a resolved login code if the frame is replaced before delivery', async () => {
  const { frame, issue, send, receive } = fixture()
  const target = frame.contentWindow
  const pending = Promise.withResolvers<WorkbenchLoginResult>()
  issue.mockReturnValue(pending.promise)
  receive()
  expect(issue).toHaveBeenCalledExactlyOnceWith(login.challenge)

  pending.resolve({ code: 'stale-code' })
  frame.src = 'about:blank'
  expect(frame.contentWindow === target).toBe(false)
  await pending.promise
  expect(send).not.toHaveBeenCalled()
})
