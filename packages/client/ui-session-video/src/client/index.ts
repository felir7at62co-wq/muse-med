/** Native Muse conversation video plugin, composed independently of archived Bot UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import remote from '@deepseek-ai/dsh-session-video/remote'
import { createVideoStore } from './store.ts'
import { NS, en, zh } from './locales.ts'
import { VideoShelf } from './VideoShelf.tsx'
import { DeliveredVideoCard, GeneratedVideoCards } from './InlineVideoCard.tsx'
import type { VideoInjected } from './face.ts'
import { readSessionVideoConfig } from '../config.ts'

export { createVideoStore } from './store.ts'

/** Services required before the generated Remote namespace mounts. */
export const inject = ['slots', 'locale', 'remote']

/** Mount source queries, the spider shelf, and native delivery cards.
 * @param ctx - Browser plugin scope with native slots and locale.
 * @returns Disposer for all registrations and the generated Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const plugin = ctx.inject(['slots', 'locale', 'remote.sessionVideo'], (scope) => {
    scope.effect(() => scope.locale.register(NS, { zh, en, ja: en, es: en, fr: en, de: en, ru: en, pt: en }), 'session-video: dictionaries')
    const config = readSessionVideoConfig()
    const store = createVideoStore()
    const injected: VideoInjected = {
      pixelsPerSecond: config.pixelsPerSecond,
      listVideos: async (id, signal) => {
        const result = await scope.remote.sessionVideo.list(id, signal)
        if (!result.ok) throw new Error(result.error.code)
        return result.value
      },
      detectShots: async (id, source, version, signal) => {
        const result = await scope.remote.sessionVideo.detect(id, source, version, signal)
        if (!result.ok) throw new Error(result.error.code)
        return result.value
      },
    }
    scope.slots.inject('conversation.chat.pinned', () => scope.slots.register({
      name: 'conversation.chat.pinned', id: 'muse-session-video', locale: NS, store, inject: () => injected,
    }, VideoShelf))
    scope.slots.inject('deliverables.video', () => scope.slots.register({
      name: 'deliverables.video', select: () => true, locale: NS, store, inject: () => injected,
    }, DeliveredVideoCard))
    scope.slots.inject('conversation.chat.turnTail', () => scope.slots.register({
      name: 'conversation.chat.turnTail', id: 'muse-generated-video', locale: NS, store, inject: () => injected,
    }, GeneratedVideoCards))
  })
  try { await plugin } catch (error) { await plugin.dispose(); await disposeRemote(); throw error }
  return async () => { await plugin.dispose(); await disposeRemote() }
}
