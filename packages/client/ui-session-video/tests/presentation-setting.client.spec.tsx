// @vitest-environment jsdom
/** Accepted settings own the switch, including pending writes and retained failures. */
import { act, fireEvent, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { PresentationSetting } from '../src/client/PresentationSetting.tsx'
import { NS, en, zh } from '../src/client/locales.ts'

async function fixture() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register(NS, { en, zh }))
  locale.setLocale('en')
  const form = stubConfigForm<{ enabled: boolean }>()
  const setEnabled = vi.fn<(enabled: boolean) => Promise<void>>().mockResolvedValue()
  await runtime.declare({ 'settings.general.item': { kind: 'list', scope: 'root' } })
  await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.register({ name: 'settings.general.item', id: 'video', locale: NS,
      inject: () => ({ hooks: { presentationSetting: form.scope }, setEnabled }) }, PresentationSetting)
  } })
  const { view } = runtime.renderSlot('settings.general.item', {})
  return { form, setEnabled, view, toggle: () => view.getByRole('switch', { name: en.settingTitle }) }
}

it('disables unavailable and readonly settings and reflects only the accepted value', async () => {
  const { form, toggle } = await fixture()
  expect(toggle().hasAttribute('disabled')).toBe(true)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  act(() => { form.publish({ status: 'ready', writable: false, value: { enabled: true } }) })
  expect(toggle().hasAttribute('disabled')).toBe(true)
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  act(() => { form.publish({ writable: true }) })
  expect(toggle().hasAttribute('disabled')).toBe(false)
})

it('keeps a write pending until completion and preserves the Host value until acceptance', async () => {
  const { form, toggle, setEnabled } = await fixture()
  act(() => { form.publish({ status: 'ready', writable: true, value: { enabled: false } }) })
  let finish: () => void = () => {}
  setEnabled.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  fireEvent.click(toggle())
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(toggle().hasAttribute('disabled')).toBe(true)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  await act(async () => { finish() })
  expect(toggle().hasAttribute('disabled')).toBe(false)
  act(() => { form.publish({ value: { enabled: true } }) })
  expect(toggle().getAttribute('aria-checked')).toBe('true')
})

it('retains a failed write notice and clears it when the user retries', async () => {
  const { form, toggle, view, setEnabled } = await fixture()
  act(() => { form.publish({ status: 'ready', writable: true, value: { enabled: true } }) })
  setEnabled.mockRejectedValueOnce(new Error('Host refused the setting'))
  fireEvent.click(toggle())
  await waitFor(() => { expect(view.getByRole('alert').textContent).toBe(en.settingError) })
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle())
  await waitFor(() => { expect(toggle().hasAttribute('disabled')).toBe(false) })
  expect(view.queryByRole('alert')).toBeNull()
  expect(setEnabled).toHaveBeenNthCalledWith(2, false)
})
