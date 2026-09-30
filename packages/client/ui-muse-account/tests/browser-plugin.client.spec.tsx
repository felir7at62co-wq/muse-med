// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { MuseAccountSection } from '../src/client/MuseAccountSection.tsx'
import type { MuseAccountInjected } from '../src/client/MuseAccountSection.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import { inject, mountMuseAccountSettings, NS } from '../src/client/mount.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-muse-account', descriptors: [] }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const disposeMount = vi.fn(() => Promise.resolve())
  const mount = vi.fn(() => Promise.resolve(disposeMount))
  const status = vi.fn(async () => ({ ok: true as const, value: { state: 'signed-out' as const } }))
  const login = vi.fn(async () => ({ ok: false as const, error: { code: 'muse-account/invalid-credentials', message: 'private' } }))
  const logout = vi.fn(async () => ({ ok: true as const, value: { state: 'signed-out' as const } }))
  const feedback = vi.fn(async (_request: unknown) => ({ ok: true as const, value: { id: 'a'.repeat(32), revision: 1 } }))
  ctx.provide('remote', {
    $mount: mount,
    get museAccount() {
      return ctx.get('remote.museAccount') as { status: typeof status; login: typeof login; logout: typeof logout; feedback: typeof feedback }
    },
  })
  ctx.provide('remote.museAccount', { status, login, logout, feedback })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'settings.launcher': { kind: 'single', scope: 'root' },
    'settings.onboarding': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  return { ctx, slots, locale, mount, disposeMount, status, login, logout, feedback }
}

describe('MUSE account browser plugin', () => {
  it('delivers both feedback targets through Muse and releases the sender with the product scope', async () => {
    vi.stubGlobal('dshDesktop', { productName: 'muse-med' })
    vi.stubGlobal('__MUSE_FEEDBACK_CONFIG__', { feedbackUrl: 'https://muse.example/feedback' })
    const b = await bench(), dispose = await mountMuseAccountSettings(b.ctx, REMOTE)
    const delivery = b.ctx.feedbackDelivery, sessionId = 'one-session' as SessionId
    expect(await delivery.submit(sessionId, { kind: 'session' }, { category: 'resource-cost', text: 'too much' }, false))
      .toEqual({ ok: true, receiptId: 'a'.repeat(32) })
    await delivery.submit(sessionId, { kind: 'message', messageId: 'one-message' as MessageId, rating: 'negative' }, { category: 'task-result' }, true)
    expect(b.feedback.mock.calls.map(([request]) => request)).toEqual([
      { sessionId, target: { kind: 'session' }, category: 'resource-cost', text: 'too much', includeDiagnostics: false },
      { sessionId, target: { kind: 'message', messageId: 'one-message', rating: 'negative' }, category: 'task-result', includeDiagnostics: true },
    ])
    await dispose(); expect(b.ctx.get('feedbackDelivery')).toBeUndefined(); await b.ctx.fiber.dispose()
  })
  it('owns the Muse desktop launcher and first-run account step', async () => {
    vi.stubGlobal('dshDesktop', { productName: 'muse-med' })
    vi.stubGlobal('__MUSE_FEEDBACK_CONFIG__', { feedbackUrl: 'https://muse.example/feedback' })
    const b = await bench()
    await mountMuseAccountSettings(b.ctx, REMOTE)
    expect(b.slots.entries('settings.launcher')).toHaveLength(1)
    expect(b.slots.entries('settings.launcher')[0]?.inject?.()).toEqual({ feedbackUrl: 'https://muse.example/feedback' })
    expect(b.slots.entries('settings.onboarding')[0]?.options).toMatchObject({ id: 'muse-account', order: -50 })
    await b.ctx.fiber.dispose()
  })

  it('registers the account page in Settings and releases it on disposal', async () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
    const b = await bench()
    const dispose = await mountMuseAccountSettings(b.ctx, REMOTE)

    expect(b.mount).toHaveBeenCalledWith(REMOTE)
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(MuseAccountSection)
    expect(entry.options).toMatchObject({ id: 'muse-account' })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('MUSE 账号')

    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('MUSE account')

    await dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.disposeMount).toHaveBeenCalledOnce()
    await b.ctx.fiber.dispose()
  })

  it('passes only bounded codes to the page on Remote failures', async () => {
    const b = await bench()
    await mountMuseAccountSettings(b.ctx, REMOTE)
    const injected = b.slots.entries('settings.section')[0]!.inject?.() as MuseAccountInjected | undefined
    if (injected === undefined) throw new Error('MUSE Settings section has no injected actions')

    await injected.status({ verify: false })
    const refusal = await injected.login({ username: 'writer', password: 'private-password', registerIfMissing: false })
    await injected.logout()

    expect(b.status).toHaveBeenCalledWith({ verify: false })
    expect(b.login).toHaveBeenCalledWith({ username: 'writer', password: 'private-password', registerIfMissing: false })
    expect(refusal).toEqual({
      ok: false,
      code: 'muse-account/invalid-credentials',
    })
    expect(b.logout).toHaveBeenCalledOnce()
    await b.ctx.fiber.dispose()
  })
})
