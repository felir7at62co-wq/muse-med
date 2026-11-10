// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { SystemDnsRow, SystemDnsToast } from '../src/client/SystemDnsRow.tsx'
import { SystemDnsSource, type SystemDnsPreference } from '../src/client/system-dns-source.ts'
import { en } from '../src/client/locales.ts'

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const unusedHook = (() => { throw new Error('unused') }) as never
const kit = {
  useSessions: unusedHook, useSessionStatus: unusedHook, usePanelInfo: unusedHook, useSessionRetainInfo: unusedHook,
  useResource, useWorkspaces: unusedHook, ...allowAllAccess, useContextMenu: contextMenuHook(),
}
const t: Parameters<typeof SystemDnsRow>[0]['t'] = key => (en as Record<string, string>)[key] ?? key

afterEach(() => { cleanup() })

function mount(source: SystemDnsSource) {
  const face = {
    ...kit, t, useSystemDns: bindSnapshotSelector(source.store), setEnabled: (value: boolean) => source.set(value),
    reload: () => source.load(), dismiss: () => { source.dismiss() },
  }
  render(<SystemDnsRow {...face} />)
  render(<SystemDnsToast {...face} />)
  return screen.getByRole('switch', { name: en['systemDns.title'] })
}

it('keeps the startup resolver active until restart and clears the notice when reverted', async () => {
  const status = vi.fn().mockResolvedValue({ saved: false, active: false })
  const first = Promise.withResolvers<SystemDnsPreference>()
  const set = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ saved: false, active: false })
  const source = new SystemDnsSource({ status, set })
  const toggle = mount(source)
  await waitFor(() => { expect(toggle.hasAttribute('disabled')).toBe(false) })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  expect(set).toHaveBeenCalledExactlyOnceWith(true)
  expect(toggle.hasAttribute('disabled')).toBe(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  first.resolve({ saved: true, active: false })
  await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
  expect(screen.getByText(en['systemDns.restart'])).toBeTruthy()
  fireEvent.click(toggle)
  await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
  expect(screen.queryByText(en['systemDns.restart'])).toBeNull()
  expect(set).toHaveBeenLastCalledWith(false)
  source.dispose()
})

it('reports a failed save without changing the accepted value', async () => {
  const source = new SystemDnsSource({
    status: async () => ({ saved: false, active: false }),
    set: async () => ({ saved: false, active: false, saveFailed: true }),
  })
  const toggle = mount(source)
  await waitFor(() => { expect(toggle.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(toggle)
  expect(await screen.findByText(en['systemDns.saveError'])).toBeTruthy()
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByText(en['systemDns.restart'])).toBeNull()
  source.dispose()
})

it.each(['reported', 'rejected'] as const)('does not show a stale switch for an %s write outcome and reloads it', async (outcome) => {
  const status = vi.fn().mockResolvedValueOnce({ saved: false, active: false })
    .mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce({ saved: true, active: false })
  const set = vi.fn(async () => {
    if (outcome === 'rejected') throw new Error('reply unavailable')
    return { unknown: true as const }
  })
  const source = new SystemDnsSource({ status, set })
  const toggle = mount(source)
  await waitFor(() => { expect(toggle.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(toggle)
  await waitFor(() => { expect(screen.queryByRole('switch', { name: en['systemDns.title'] })).toBeNull() })
  expect(screen.getAllByText(en['systemDns.unknown']).length).toBeGreaterThan(0)
  expect(screen.queryByText(en['systemDns.restart'])).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['systemDns.retry'] }))
  await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(screen.getByRole('button', { name: en['systemDns.retry'] }).hasAttribute('disabled')).toBe(false) })
  expect(screen.queryByRole('switch', { name: en['systemDns.title'] })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['systemDns.retry'] }))
  const restored = await screen.findByRole('switch', { name: en['systemDns.title'] })
  expect(restored.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText(en['systemDns.restart'])).toBeTruthy()
  expect(screen.queryByText(en['systemDns.unknown'])).toBeNull()
  source.dispose()
})

it('retains the disabled control on read failure and allows retry', async () => {
  const status = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce({ saved: true, active: true })
  const source = new SystemDnsSource({ status, set: vi.fn() })
  const toggle = mount(source)
  expect((await screen.findByRole('alert')).textContent).toContain(en['systemDns.loadError'])
  expect(toggle.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en['systemDns.retry'] }))
  await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
  expect(screen.queryByRole('alert')).toBeNull()
  source.dispose()
})

it('ignores a pending read after the plugin is disposed', async () => {
  const pending = Promise.withResolvers<SystemDnsPreference>()
  const source = new SystemDnsSource({ status: () => pending.promise, set: vi.fn() })
  source.dispose()
  pending.resolve({ saved: true, active: true })
  await Promise.resolve()
  expect(source.store.getSnapshot().preference).toBeUndefined()
})

it('ignores a pending write outcome after the plugin is disposed', async () => {
  const pending = Promise.withResolvers<{ unknown: true }>()
  const source = new SystemDnsSource({ status: async () => ({ saved: false, active: false }), set: () => pending.promise })
  await waitFor(() => { expect(source.store.getSnapshot().preference?.saved).toBe(false) })
  const operation = source.set(true)
  source.dispose()
  pending.resolve({ unknown: true })
  await operation
  expect(source.store.getSnapshot().unknown).toBe(false)
  expect(source.store.getSnapshot().preference?.saved).toBe(false)
})
