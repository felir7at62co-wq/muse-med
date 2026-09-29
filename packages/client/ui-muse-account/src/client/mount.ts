/** Register the account Settings page over the generated Remote namespace. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-muse-account/remote'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { MuseAccountSection, type MuseAccountInjected, type MuseAccountOutcome } from './MuseAccountSection.tsx'
import { MuseAccountLauncher } from './MuseAccountLauncher.tsx'
import { MuseAccountOnboarding } from './MuseAccountOnboarding.tsx'
import { en, zh, type MuseAccountLocaleKey } from './locales.ts'
import { FeedbackConfig, FEEDBACK_CONFIG_GLOBAL } from '../feedback-config.ts'

export type { MuseAccountInjected, MuseAccountOutcome, MuseAccountSectionProps } from './MuseAccountSection.tsx'
export type { MuseAccountLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MUSE account Settings copy. */
    'settings.museAccount': MuseAccountLocaleKey
  }
}

/** Dictionary namespace owned by this page. */
export const NS = 'settings.museAccount'

/** Browser services required before this page mounts its own Remote namespace. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Keep Remote failure messages out of the page because they can contain upstream data.
 * @param result - Host Remote result.
 * @returns a value or its bounded error code.
 */
function outcomeOf<T>(result: RemoteResult<T>): MuseAccountOutcome<T> {
  return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.error.code }
}

/** Register the page after its Remote namespace exists. */
function registerSection(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'muse-account: dictionaries')
  const t = ctx.locale.bind(NS)
  const account: MuseAccountInjected = {
    status: async request => outcomeOf(await ctx.remote.museAccount.status(request)),
    login: async request => outcomeOf(await ctx.remote.museAccount.login(request)),
    logout: async () => outcomeOf(await ctx.remote.museAccount.logout()),
  }
  const injected = (): MuseAccountInjected => account
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'muse-account',
    order: 12,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, MuseAccountSection))
  if ((globalThis as typeof globalThis & { dshDesktop?: { productName?: string } }).dshDesktop?.productName === 'muse-med') {
    const page = globalThis as Partial<Record<typeof FEEDBACK_CONFIG_GLOBAL, Partial<FeedbackConfig>>>
    const { feedbackUrl } = FeedbackConfig(page[FEEDBACK_CONFIG_GLOBAL])
    ctx.slots.inject('settings.launcher', () => ctx.slots.register({
      name: 'settings.launcher', locale: NS,
      inject: () => ({ feedbackUrl }),
    }, MuseAccountLauncher))
    ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
      name: 'settings.onboarding', id: 'muse-account', order: -50, locale: NS, inject: injected,
    }, MuseAccountOnboarding))
  }
}

/**
 * Mount the generated account Remote contribution and the Settings page.
 * @param ctx - Client context with the slot registry, locale, and Remote service.
 * @param contribution - generated account Remote descriptors.
 * @returns a disposer that removes both registrations.
 */
export async function mountMuseAccountSettings(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const section = ctx.inject(['slots', 'locale', 'remote.museAccount'], registerSection)
  try {
    await section
  } catch (error) {
    await section.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await section.dispose()
    await disposeRemote()
  }
}
