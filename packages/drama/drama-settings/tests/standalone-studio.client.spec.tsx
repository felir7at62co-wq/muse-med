// @vitest-environment jsdom
/** The registered desktop studio waits for its own frame and replaces an unresponsive frame on retry. */
import { act, fireEvent } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const origin = 'http://127.0.0.1:5684'
const panelId = 'muse-standalone-studio'
const ready = { type: 'muse-localminidrama:ready', version: 1 }
const loadingDeadlineMs = 8_000

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function setup(url = 'dsh-app://app/', productName = 'muse-med') {
  vi.stubGlobal('location', new URL(url))
  vi.stubGlobal('dshDesktop', { productName, standaloneStudioOrigin: origin })
  const runtime = await SlotTestRuntime.create()
  onTestFinished(async () => { await runtime.dispose() })
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.remote.provideNamespaces({ settings: {
    describe: async () => ({ ok: true, value: { writable: false, hasDocument: false, namespaces: [] } }),
  } })
  await runtime.mount({ inject: [...settingsInject], apply: settingsApply })
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  await runtime.mount({ inject: [...inject], apply })
  return runtime
}

function child(candidate: HTMLElement): { frame: HTMLIFrameElement; source: Window } {
  if (!(candidate instanceof HTMLIFrameElement) || !candidate.contentWindow) throw new Error('Missing standalone studio iframe')
  return { frame: candidate, source: candidate.contentWindow }
}

function receive(source: Window, data: unknown, eventOrigin = origin) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { origin: eventOrigin, source, data })) })
}

it.each([
  ['dsh-app://another/', 'muse-med'],
  ['dsh-app://app/', 'deepseek-harness'],
])('leaves the configured studio unregistered at %s for %s', async (url, productName) => {
  const runtime = await setup(url, productName)
  expect(runtime.slots.entries('main').some(entry => entry.options.key === panelId)).toBe(false)
  expect(runtime.slots.entries('sidebar.panellist').some(entry => entry.options.id === panelId)).toBe(false)
})

it('pings the configured origin and accepts readiness only from that frame with the current protocol', async () => {
  const runtime = await setup()
  const sidebar = runtime.renderSlot('sidebar.panellist', { size: 16, active: false })
  expect(runtime.slots.entries('sidebar.panellist').some(entry => entry.options.id === panelId)).toBe(true)
  expect(sidebar.container.querySelector('svg')).not.toBeNull()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const panel = runtime.renderSlot('main', {}, { entryKey: panelId })
  const { frame, source } = child(panel.view.getByTitle(en.studioPanel))
  expect(new URL(frame.src).origin).toBe(origin)
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  const send = vi.spyOn(source, 'postMessage').mockImplementation(() => {})
  fireEvent.load(frame)
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'muse-localminidrama:ping', version: 1 }, origin)

  receive(source, ready, 'http://127.0.0.1:5685')
  receive(window, ready)
  for (const bad of [null, 'ready', {}, { type: ready.type }, { ...ready, type: 'other' }, { ...ready, version: 2 }]) receive(source, bad)
  act(() => { vi.advanceTimersByTime(loadingDeadlineMs - 1) })
  expect(panel.view.getByRole('status').textContent).toBe(en.studioLoading)
  expect(frame.hasAttribute('data-ready')).toBe(false)

  receive(source, ready)
  act(() => { vi.advanceTimersByTime(loadingDeadlineMs) })
  expect(panel.view.queryByRole('status')).toBeNull()
  expect(frame.getAttribute('data-ready')).toBe('true')
})

it('retries an unavailable studio in a new frame and ignores readiness from the replaced frame', async () => {
  const runtime = await setup()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const panel = runtime.renderSlot('main', {}, { entryKey: panelId })
  const original = child(panel.view.getByTitle(en.studioPanel))
  const delayed = new MessageEvent('message', { origin, source: original.source, data: ready })
  act(() => { vi.advanceTimersByTime(loadingDeadlineMs) })
  expect(panel.view.getByRole('status').textContent).toBe(en.studioUnavailable)
  fireEvent.click(panel.view.getByRole('button', { name: en.studioRetry }))
  const replacement = child(panel.view.getByTitle(en.studioPanel))
  expect(original.frame.isConnected).toBe(false)
  expect(replacement.source === original.source).toBe(false)
  expect(panel.view.getByRole('status').textContent).toBe(en.studioLoading)

  act(() => { window.dispatchEvent(delayed) })
  expect(panel.view.getByRole('status').textContent).toBe(en.studioLoading)
  expect(replacement.frame.hasAttribute('data-ready')).toBe(false)
  receive(replacement.source, ready)
  expect(panel.view.queryByRole('status')).toBeNull()
  expect(replacement.frame.getAttribute('data-ready')).toBe('true')
})
