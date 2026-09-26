/**
 * Registration of the Feishu Settings page and the Remote namespace it calls.
 *
 * Split from the browser entry because the entry imports the generated
 * `./remote` artifact, which exists only after a Host build: this module holds
 * the lifecycle and the injected face, and the entry only binds them to that
 * artifact.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-feishu-settings/remote'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { FeishuSection } from './FeishuSection.tsx'
import type { FeishuOutcome, FeishuSetupInjected } from './FeishuSection.tsx'
import { en, zh, type FeishuLocaleKey } from './locales.ts'

export type { FeishuOutcome, FeishuSectionProps, FeishuSetupInjected } from './FeishuSection.tsx'
export type { FeishuLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Feishu setup section copy. */
    'settings.feishu': FeishuLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.feishu'

/**
 * Services the browser half waits for.
 *
 * `remote.feishuSetup` is deliberately absent: this plugin mounts that
 * namespace itself, so declaring it here would park the fiber on a service its
 * own `apply` must provide first. The namespace is awaited on the registration
 * child fiber instead.
 */
export const inject = ['slots', 'locale', 'remote']

/**
 * Map one Remote answer onto the outcome the component reads.
 * @param result - the generated Client namespace's result.
 * @returns the same facts, or the failure's code and message.
 */
function outcomeOf<T>(result: RemoteResult<T>): FeishuOutcome<T> {
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, code: result.error.code, message: result.error.message }
}

/** Contribute the Feishu page to Settings. */
function registerSection(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'feishu-settings: dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): FeishuSetupInjected => ({
    status: async () => outcomeOf(await ctx.remote.feishuSetup.status()),
    setEnabled: async enabled => outcomeOf(await ctx.remote.feishuSetup.setEnabled({ enabled })),
    setCredentials: async request => outcomeOf(await ctx.remote.feishuSetup.setCredentials(request)),
    beginLogin: async () => outcomeOf(await ctx.remote.feishuSetup.beginLogin()),
    cancelLogin: async () => outcomeOf(await ctx.remote.feishuSetup.cancelLogin()),
    forget: async () => outcomeOf(await ctx.remote.feishuSetup.forget()),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'feishu',
    order: 18,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, FeishuSection))
}

/**
 * Mount one generated setup Remote contribution, then register the page over it.
 * @param ctx - Client context carrying the slot registry, locale, and Remote service.
 * @param contribution - the generated `feishuSetup` descriptors this page calls.
 * @returns a disposer that removes the page registrations and the namespace.
 */
export async function mountFeishuSettings(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const section = ctx.inject(['slots', 'locale', 'remote.feishuSetup'], registerSection)
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
