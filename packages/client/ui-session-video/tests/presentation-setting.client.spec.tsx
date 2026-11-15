// @vitest-environment jsdom
/** Accepted Host settings drive the switch; pending and refused writes stay visible. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { PresentationSetting } from '../src/client/PresentationSetting.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

// The setting consumes only its injected selector; any accidental standard-seat access must fail loudly.
function unusedStandardSeat(): never { throw new Error('Presentation setting does not consume this standard seat') }
const standard: GlobalStandardProps = {
  ...allowAllAccess,
  useSessions: unusedStandardSeat, useSessionStatus: unusedStandardSeat, useSessionRetainInfo: unusedStandardSeat,
  usePanelInfo: unusedStandardSeat, useResource: unusedStandardSeat, useWorkspaces: unusedStandardSeat,
  useContextMenu: unusedStandardSeat,
}

function setup() {
  const form = stubConfigForm<{ enabled: boolean }>()
  const setEnabled = vi.fn<(enabled: boolean) => Promise<void>>(async () => {})
  const view = render(<PresentationSetting {...standard} usePresentationSetting={bindSnapshotSelector(form.scope)} setEnabled={setEnabled}
    t={makeTranslate(en)} />)
  return { form, setEnabled, view, toggle: view.getByRole('switch', { name: en.settingTitle }) as HTMLButtonElement }
}

it('reflects accepted values and refuses interaction before ready or while the Host is read-only', () => {
  const h = setup()
  expect(h.toggle.disabled).toBe(true)
  expect(h.toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(h.toggle)
  expect(h.setEnabled).not.toHaveBeenCalled()
  act(() => { h.form.publish({ status: 'ready', writable: false, value: { enabled: true } }) })
  expect(h.toggle.getAttribute('aria-checked')).toBe('true')
  expect(h.toggle.disabled).toBe(true)
  act(() => { h.form.publish({ status: 'unavailable', writable: true }) })
  expect(h.toggle.disabled).toBe(true)
  act(() => { h.form.publish({ status: 'ready', writable: true }) })
  expect(h.toggle.disabled).toBe(false)
})

it('blocks duplicate pending writes, retains refusal feedback and clears it on a successful retry', async () => {
  const h = setup(), pending = Promise.withResolvers<undefined>()
  act(() => { h.form.publish({ status: 'ready', writable: true, value: { enabled: false } }) })
  h.setEnabled.mockReturnValueOnce(pending.promise)
  fireEvent.click(h.toggle)
  expect(h.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(h.toggle.disabled).toBe(true)
  expect(h.toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(h.toggle)
  expect(h.setEnabled).toHaveBeenCalledTimes(1)
  await act(async () => { pending.reject(new Error('Host refused the setting')); await Promise.resolve() })
  expect(h.view.getByRole('alert').textContent).toBe(en.settingError)
  expect(h.toggle.disabled).toBe(false)
  await act(async () => { fireEvent.click(h.toggle) })
  expect(h.view.queryByRole('alert')).toBeNull()
  expect(h.setEnabled).toHaveBeenCalledTimes(2)
  act(() => { h.form.publish({ value: { enabled: true } }) })
  expect(h.toggle.getAttribute('aria-checked')).toBe('true')
})
