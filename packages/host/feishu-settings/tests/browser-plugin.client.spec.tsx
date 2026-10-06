// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { inject, mountFeishuSettings, NS, type FeishuSetupInjected } from '../src/client/mount.ts'
import { FeishuSection } from '../src/client/FeishuSection.tsx'
import type { FeishuSetupStatus } from '../src/types.ts'

vi.mock('@deepseek-ai/dsh-feishu-settings/remote', () => ({
  default: { package: '@deepseek-ai/dsh-feishu-settings', descriptors: [] },
}))
usePinnedBrowserLanguages('zh-CN')
const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-feishu-settings', descriptors: [] }
const OFF: FeishuSetupStatus = { enabled: false, row: 'disabled', appId: '', credential: 'none', writable: true, login: null }

it('requires its owning mock instead of treating the virtual Remote as a generated export', async () => {
  await expect(vi.importActual('@deepseek-ai/dsh-feishu-settings/remote')).rejects.toThrow('Generated Remote contribution requires an explicit owning-test mock')
})

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const disposeMount = vi.fn(async () => {})
  const mount = vi.fn(async () => disposeMount)
  const status = vi.fn(async (): Promise<RemoteResult<FeishuSetupStatus>> => ({ ok: true, value: OFF }))
  const calls = {
    status,
    setEnabled: vi.fn(async (_request: { enabled: boolean }) => ({ ok: true as const, value: OFF })),
    setCredentials: vi.fn(async (_request: { appId: string; appSecret: string }) => ({ ok: true as const, value: OFF })),
    beginLogin: vi.fn(async () => ({ ok: true as const, value: {
      url: 'https://open.feishu.cn/scan/test', qrDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', expiresInSeconds: 60,
    } })),
    cancelLogin: vi.fn(async () => ({ ok: true as const, value: OFF })),
    forget: vi.fn(async () => ({ ok: true as const, value: OFF })),
  }
  ctx.provide('remote', { $mount: mount, get feishuSetup() { return ctx.get('remote.feishuSetup') as typeof calls } })
  ctx.provide('remote.feishuSetup', calls)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  return { ctx, slots, locale, mount, disposeMount, calls }
}

it('mounts the browser entry, follows locale changes, and disposes its page and Remote namespace', async () => {
  expect(inject).toEqual(['slots', 'locale', 'remote'])
  const b = await bench(), dispose = await apply(b.ctx)
  expect(b.mount).toHaveBeenCalledExactlyOnceWith(REMOTE)
  const entry = b.slots.entries('settings.section')[0]!
  expect(entry.component).toBe(FeishuSection)
  expect(entry.options).toMatchObject({ id: 'feishu', order: 18 })
  expect(entry.locale).toBe(NS)
  expect(resolveSlotLabel(entry.options.label)).toBe('飞书')
  b.locale.setLocale('en')
  expect(resolveSlotLabel(entry.options.label)).toBe('Feishu')
  const actions = entry.inject?.() as Record<string, unknown> & FeishuSetupInjected
  expect(await actions.status()).toEqual({ ok: true, value: OFF })
  await actions.setEnabled(true)
  await actions.setCredentials({ appId: 'cli_test', appSecret: 'private-test-secret' })
  expect(await actions.beginLogin()).toMatchObject({ ok: true, value: { expiresInSeconds: 60 } })
  await actions.cancelLogin()
  await actions.forget()
  expect(b.calls.setEnabled).toHaveBeenCalledExactlyOnceWith({ enabled: true })
  expect(b.calls.setCredentials).toHaveBeenCalledExactlyOnceWith({ appId: 'cli_test', appSecret: 'private-test-secret' })
  expect(b.calls.cancelLogin).toHaveBeenCalledOnce()
  expect(b.calls.forget).toHaveBeenCalledOnce()
  b.calls.status.mockResolvedValueOnce({ ok: false, error: new RemoteError('feishu/secret-required', 'missing secret', {}) })
  expect(await actions.status()).toMatchObject({ ok: false, error: { code: 'feishu/secret-required' } })
  await dispose()
  expect(b.slots.entries('settings.section')).toEqual([])
  expect(b.disposeMount).toHaveBeenCalledOnce()
})

it('releases its mounted Remote namespace when dictionary registration fails', async () => {
  const b = await bench(), failure = new Error('locale namespace could not mount')
  vi.spyOn(b.locale, 'register').mockImplementationOnce(() => { throw failure })
  await expect(mountFeishuSettings(b.ctx, REMOTE)).rejects.toBe(failure)
  expect(b.disposeMount).toHaveBeenCalledOnce()
  expect(b.slots.entries('settings.section')).toEqual([])
})
