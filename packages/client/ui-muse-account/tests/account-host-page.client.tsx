/** Client-compiled account page using Host-owned operations through the production registration. */
import { Context } from '@deepseek-ai/cordis'
import { act } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import * as UiRenderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { MuseAccountLoginRequest, MuseAccountLoginResult, MuseAccountStatus, MuseAccountStatusRequest } from '@deepseek-ai/dsh-muse-account/types'
import { mountMuseAccountSettings } from '../src/client/mount.ts'

interface AccountTransport {
  status(request: MuseAccountStatusRequest): Promise<RemoteResult<MuseAccountStatus>>
  login(request: MuseAccountLoginRequest): Promise<RemoteResult<MuseAccountLoginResult>>
  logout(): Promise<RemoteResult<MuseAccountStatus>>
  startBrowserLogin(): Promise<RemoteResult<import('@deepseek-ai/dsh-muse-account/types').MuseBrowserLoginAttempt>>
  checkBrowserLogin(id: import('@deepseek-ai/dsh-muse-account/types').MuseBrowserLoginId): Promise<RemoteResult<import('@deepseek-ai/dsh-muse-account/types').MuseBrowserLoginResult>>
  cancelBrowserLogin(id: import('@deepseek-ai/dsh-muse-account/types').MuseBrowserLoginId): Promise<RemoteResult<MuseAccountStatus>>
}

function AccountRoot({ renderSlot }: PropsRenderSlots<'settings.section'>) {
  return <>{renderSlot('settings.section', { close: () => undefined })}</>
}

/**
 * Mount the actual account slot with a separately compiled Host transport.
 * @param host - Production Host operations returning their actual Remote results.
 * @returns Owned container, registry observations, and asynchronous Client disposal.
 */
export async function mountAccountPage(host: AccountTransport) {
  const ctx = new Context()
  const container = document.createElement('div')
  document.body.append(container)
  let unmount: (() => void) | undefined
  let unregister: (() => Promise<void>) | undefined
  try {
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    ctx.provide('remote', { museAccount: host, $mount: async () => async () => {} })
    ctx.provide('remote.museAccount', host)
    await ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply }).await()
    ctx.slots.installLocale(locale)
    const absent: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    const current = { getSnapshot: () => absent, subscribe: () => () => {} }
    ctx.slots.installScope('session', { current, bindingSource: () => current })
    ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, AccountRoot)
    unregister = await mountMuseAccountSettings(ctx, { package: '@deepseek-ai/dsh-muse-account', descriptors: [] })
    await act(async () => { unmount = ctx.uiRenderer.mount(container) })
  } catch (error) {
    act(() => { unmount?.() })
    await unregister?.()
    await ctx.fiber.dispose()
    container.remove()
    throw error
  }
  let disposal: Promise<void> | undefined
  const registry = ctx.slots
  return {
    container,
    registrations: () => registry.entries('settings.section').length,
    dispose: () => disposal ??= (async () => {
      act(() => { unmount?.() })
      await unregister?.()
      await ctx.fiber.dispose()
      container.remove()
    })(),
  }
}
