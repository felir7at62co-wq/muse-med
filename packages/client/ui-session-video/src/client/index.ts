/** Native Muse conversation video plugin, composed independently of archived Bot UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import remote from '@deepseek-ai/dsh-session-video/remote'
import { createVideoStore } from './store.ts'
import { NS, en, zh } from './locales.ts'
import { VideoHeader, VideoHistory } from './VideoHistory.tsx'
import { DeliveredVideoCard, GeneratedVideoCards } from './InlineVideoCard.tsx'
import type { VideoInjected } from './face.ts'
import { readSessionVideoConfig, SETTINGS_ENTRY } from '../config.ts'
import { PresentationRuntime } from './presentation-runtime.ts'
import { PresentationSetting } from './PresentationSetting.tsx'

export { createVideoStore } from './store.ts'

/** Services required before the generated Remote namespace mounts. */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/** Mount source queries, Session video navigation, and native delivery cards.
 * @param ctx - Browser plugin scope with native slots and locale.
 * @returns Disposer for all registrations and the generated Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const plugin = ctx.inject(['slots', 'locale', 'remote.sessionVideo'], (scope) => {
    scope.effect(() => scope.locale.register(NS, { zh, en, ja: en, es: en, fr: en, de: en, ru: en, pt: en }), 'session-video: dictionaries')
    const config = readSessionVideoConfig()
    const form = scope.configForms.get<{ enabled: boolean }>(SETTINGS_ENTRY)
    const runtime = new PresentationRuntime(async () => {
      const childScope = scope.inject(['slots', 'remote.sessionVideo'], (child) => {
        const store = createVideoStore()
        const injected: VideoInjected = {
          pixelsPerSecond: config.pixelsPerSecond,
          listVideos: async (id, signal) => {
            const result = await child.remote.sessionVideo.list(id, signal)
            if (!result.ok) throw new Error(result.error.code)
            return result.value
          },
          detectShots: async (id, source, version, signal) => {
            const result = await child.remote.sessionVideo.detect(id, source, version, signal)
            if (!result.ok) throw new Error(result.error.code)
            return result.value
          },
        }
        child.slots.inject('conversation.chat.pinned', () => child.slots.register({
          name: 'conversation.chat.pinned', id: 'muse-session-video-history', locale: NS, store, inject: () => injected,
        }, VideoHistory))
        child.slots.inject('conversation.session.header.utilities', () => child.slots.register({
          name: 'conversation.session.header.utilities', id: 'muse-session-video-menu', locale: NS, store, inject: () => injected,
        }, VideoHeader))
        child.slots.inject('deliverables.video', () => child.slots.register({
          name: 'deliverables.video', select: () => true, locale: NS, store, inject: () => injected,
        }, DeliveredVideoCard))
        child.slots.inject('conversation.chat.turnTail', () => child.slots.register({
          name: 'conversation.chat.turnTail', id: 'muse-generated-video', locale: NS, store, inject: () => injected,
        }, GeneratedVideoCards))
      })
      try { await childScope.await() } catch (error) { await childScope.dispose(); throw error }
      return { dispose: () => childScope.dispose() }
    })
    scope.effect(() => {
      const sync = (): void => {
        void runtime.setEnabled(form.getSnapshot().value?.enabled ?? config.enabled)
          .catch((error: unknown) => { scope.logger.error(error) })
      }
      const unsubscribe = form.subscribe(sync)
      sync()
      return async () => { unsubscribe(); await runtime.dispose() }
    }, 'session-video: optional presentation scope')
    scope.slots.inject('settings.general.item', () => scope.slots.register({
      name: 'settings.general.item', id: SETTINGS_ENTRY, order: 14, locale: NS,
      inject: () => ({
        hooks: { presentationSetting: form },
        setEnabled: async (enabled: boolean) => {
          if (!await form.set('enabled', enabled)) throw new Error('Session video setting was refused')
          await runtime.setEnabled(enabled)
        },
      }),
    }, PresentationSetting))
  })
  try { await plugin.await() } catch (error) { await plugin.dispose(); await disposeRemote(); throw error }
  return async () => { await plugin.dispose(); await disposeRemote() }
}
