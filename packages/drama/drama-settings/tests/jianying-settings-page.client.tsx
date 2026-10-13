/** Client-compiled settings page fixture; the Host supplies actual Remote operations. */
import { Context } from '@deepseek-ai/cordis'
import { act } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import * as UiRenderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import * as SettingsClient from '@deepseek-ai/dsh-client-ui-settings/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import * as DramaClient from '../src/client/index.ts'

/** Settings operations delivered by the separately compiled Host fixture. */
interface HostSettings {
  describe(): Promise<RemoteResult<SettingsDescribeValue>>
  mutate(ns: string, ops: readonly SettingsPathOpView[], revision: number | undefined): Promise<RemoteResult<SettingsNamespaceView>>
}

/** Render only the settings section while retaining the production slot and hook binding. */
function SettingsRoot({ renderSlot }: PropsRenderSlots<'settings.section'>) {
  return <>{renderSlot('settings.section', { close: () => undefined })}</>
}

/**
 * Mount the real settings page with instance-local Host transport callbacks.
 * @param host - Actual Host settings calls wrapped as Remote results.
 * @returns Owned DOM container and an asynchronous Client disposer.
 */
export async function mountSettingsPage(host: HostSettings) {
  const ctx = new Context()
  const container = document.createElement('div')
  document.body.append(container)
  let unmount: (() => void) | undefined
  try {
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('en')
    ctx.provide('locale', locale)
    new TestRemote(ctx, { settings: host })
    await ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply }).await()
    ctx.slots.installLocale(locale)
    const absentBinding: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    const current = { getSnapshot: () => absentBinding, subscribe: () => () => {} }
    ctx.slots.installScope('session', { current, bindingSource: () => current })
    ctx.slots.register({
      name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } },
    }, SettingsRoot)
    await ctx.plugin({ inject: [...SettingsClient.inject], apply: SettingsClient.apply }).await()
    await ctx.plugin({ inject: [...DramaClient.inject], apply: DramaClient.apply }).await()
    await act(async () => { unmount = ctx.uiRenderer.mount(container) })
  } catch (error) {
    act(() => { unmount?.() })
    await ctx.fiber.dispose()
    container.remove()
    throw error
  }
  let disposal: Promise<void> | undefined
  return {
    container,
    dispose: () => disposal ??= (async () => {
      act(() => { unmount?.() })
      await ctx.fiber.dispose()
      container.remove()
    })(),
  }
}
