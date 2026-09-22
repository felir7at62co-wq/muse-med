/**
 * Source-safe registration of the Jubian token Settings page and the Remote
 * namespace it calls.
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
import type {} from '@deepseek-ai/dsh-tool-jubian/remote'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { JubianTokenSection } from './JubianTokenSection.tsx'
import type { JubianTokenInjected, JubianTokenOutcome, JubianTokenStatus } from './JubianTokenSection.tsx'
import { en, zh, type JubianLocaleKey } from './locales.ts'

export type {
  JubianTokenInjected,
  JubianTokenOutcome,
  JubianTokenSectionProps,
  JubianTokenStatus,
} from './JubianTokenSection.tsx'
export type { JubianLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Jubian token section copy. */
    'settings.jubian': JubianLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.jubian'

/**
 * Services the browser half waits for.
 *
 * `remote.jubianToken` is deliberately absent: this plugin mounts that
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
function outcomeOf(result: RemoteResult<JubianTokenStatus>): JubianTokenOutcome {
  return result.ok
    ? { ok: true, status: result.value }
    : { ok: false, code: result.error.code, message: result.error.message }
}

/** Contribute the Jubian token page to Settings. */
function registerSection(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tool-jubian: token dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): JubianTokenInjected => ({
    describe: async (): Promise<JubianTokenOutcome> => outcomeOf(await ctx.remote.jubianToken.describe()),
    set: async (value: string): Promise<JubianTokenOutcome> => outcomeOf(await ctx.remote.jubianToken.set(value)),
    unset: async (): Promise<JubianTokenOutcome> => outcomeOf(await ctx.remote.jubianToken.unset()),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'jubian',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, JubianTokenSection))
}

/**
 * Mount one generated token Remote contribution, then register the page over it.
 * @param ctx - Client context carrying the slot registry, locale, and Remote service.
 * @param contribution - the generated `jubianToken` descriptors this page calls.
 * @returns a disposer that removes the page registrations and the namespace.
 */
export async function mountJubianTokenSettings(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const section = ctx.inject(['slots', 'locale', 'remote.jubianToken'], registerSection)
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
