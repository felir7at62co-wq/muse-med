/** Native Muse conversation video plugin, composed independently of archived Bot UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import remote from '@deepseek-ai/dsh-session-video/remote'
import { createVideoStore } from './store.ts'
import { NS, en, zh, ja, es, fr, de, ru, pt } from './locales.ts'
import { VideoHeader } from './VideoHeader.tsx'
import { DeliveredVideoCard, GeneratedVideoCards } from './InlineVideoCard.tsx'
import type { VideoInjected } from './face.ts'
import { readSessionVideoConfig, SETTINGS_ENTRY } from '../config.ts'
import { PresentationRuntime } from './presentation-runtime.ts'
import { PresentationSetting } from './PresentationSetting.tsx'
import { VideoWorkspace } from './VideoWorkspace.tsx'
import { createVideoResources } from './resource-provider.ts'
import { parseVideoWorkspaceAddress, videoWorkspaceAddress } from './target-selection.ts'
import { createVideoReferenceSource, VIDEO_REFERENCE_SOURCE } from './references.ts'
import { videoSelectionRule, videoReviewRule } from './user-text-rules.ts'
import { VideoSelectionText, type VideoSelectionTextInjected } from './VideoSelectionText.tsx'

export { createVideoStore } from './store.ts'

/** Services required before the generated Remote namespace mounts. */
export const inject = ['slots', 'locale', 'remote', 'configForms', 'uiConversation', 'conversation', 'inputTriggers',
  'sidebarRight', 'sidebarRightTabs', 'resources', 'sessions']

const WORKSPACE_ID = '@deepseek-ai/dsh-client-ui-session-video/workspace'
const WORKSPACE_KIND = 'session-video'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A video resource retains its conversation through inventory observation. */
    sessionVideoWorkspace: unknown
  }
}

function VideoWorkspaceTitle({ t, sessionId, useTabInfo, useResource }:
PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'sessionVideo'>): string {
  const navigation = parseVideoWorkspaceAddress(useTabInfo().tab.navigation.address)
  const inventory = useResource<'session-video'>(videoWorkspaceAddress(sessionId)).value
  const source = inventory?.sources.find(source => source.id === navigation?.target?.sourceId)
  return source?.label ?? t('library')
}

/** Mount source queries, native video navigation, and delivery cards.
 * @param ctx - Browser plugin scope with native slots and locale.
 * @returns Disposer for all registrations and the generated Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const plugin = ctx.inject(['slots', 'locale', 'remote.sessionVideo', 'inputTriggers', 'sidebarRight'], (scope) => {
    scope.effect(() => scope.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'session-video: dictionaries')
    const config = readSessionVideoConfig()
    const form = scope.configForms.get<{ enabled: boolean }>(SETTINGS_ENTRY)
    const t = scope.locale.bind(NS)
    scope.effect(() => scope.inputTriggers.registerSource(createVideoReferenceSource(
      (sessionId, signal) => scope.remote.sessionVideo.list(sessionId, signal),
      (address) => {
        if (!(form.getSnapshot().value?.enabled ?? config.enabled)) return false
        scope.sidebarRight.openResource(address, { kind: WORKSPACE_KIND, destination: 'sidebar' })
        return true
      },
      { invalid: () => t('referenceInvalid'), stale: () => t('referenceStale') },
    )), 'session-video: selected source references')
    const runtime = new PresentationRuntime(async () => {
      const childScope = scope.inject(['slots', 'remote.sessionVideo', 'uiConversation', 'conversation',
        'sidebarRight', 'sidebarRightTabs', 'resources', 'sessions'], (child) => {
        const sessions = child.sessions
        const store = createVideoStore()
        const operations = {
          pixelsPerSecond: config.pixelsPerSecond,
          detectShots: async (id, source, version, signal) => {
            const result = await child.remote.sessionVideo.detect(id, source, version, signal)
            if (!result.ok) throw result.error
            return result.value
          },
        } satisfies Pick<VideoInjected, 'pixelsPerSecond' | 'detectShots'>
        const resources = createVideoResources((sessionId, signal) => {
          const reference = sessions.retain(sessionId, { source: 'sessionVideoWorkspace', signal })
          return {
            ready: reference.ready.then((binding) => {
              const state = binding.session.getSnapshot()
              if (state.openState !== 'open') throw state.openError ?? new Error('Session video conversation is not open')
              return binding.eventSource
            }),
            release: () => { reference.release() },
          }
        }, (sessionId, signal) => child.remote.sessionVideo.list(sessionId, signal))
        child.effect(() => {
          const release = child.resources.register(resources.provider)
          return async () => { release(); await resources.settle() }
        }, 'session-video: inventory resources')
        const t = child.locale.bind(NS)
        child.uiConversation.userText.register(videoSelectionRule)
        child.uiConversation.userText.register(videoReviewRule)
        child.slots.inject('conversation.user.text.node', () => child.slots.register({
          name: 'conversation.user.text.node', key: 'muse-video-review',
        }, () => null))
        child.slots.inject('conversation.user.text.node', () => child.slots.register({
          name: 'conversation.user.text.node', key: 'muse-video-selection', locale: NS,
          inject: (sessionId: SessionId): VideoSelectionTextInjected => ({
            openVideoSelection: (address) => {
              if (parseVideoWorkspaceAddress(address)?.sessionId !== sessionId) return
              child.sidebarRight.openResource(address, { kind: WORKSPACE_KIND, destination: 'sidebar' })
            },
          }),
        }, VideoSelectionText))
        child.effect(() => child.sidebarRightTabs.register({
          id: WORKSPACE_ID, kind: WORKSPACE_KIND, priority: 'builtin', keepMounted: true,
          patterns: ['dsh-resource://session-video/**'],
          canOpen: address => address === 'sidebar://session-video' || parseVideoWorkspaceAddress(address) !== null,
          title: () => t('library'),
          guide: [{ id: 'videos', order: 25, title: () => t('library'), icon: IconPlayOutlineRegular }],
        }), 'session-video: workspace tab')
        const faces = new Map<SessionId, VideoInjected>()
        child.effect(() => () => { faces.clear() }, 'session-video: workspace callbacks')
        const injected = (sessionId: SessionId): VideoInjected => {
          const previous = faces.get(sessionId)
          if (previous !== undefined) return previous
          const value: VideoInjected = {
            ...operations,
            openWorkspace: (destination = 'sidebar') => {
              child.sidebarRight.openResource(videoWorkspaceAddress(sessionId), { kind: WORKSPACE_KIND, destination })
            },
            refreshVideos: () => { resources.refresh(sessionId) },
            addTargetReference: (target, label, span) => {
              const binding = sessions.binding(sessionId)
              if (binding === undefined) return false
              const shell = child.conversation.input.for(binding.ctx)
              const ref = videoWorkspaceAddress(sessionId, target)
              const state = shell.state.getSnapshot()
              if (state.occurrences.some(value => value.source === VIDEO_REFERENCE_SOURCE && value.ref === ref)) return true
              return shell.insertReference({ source: VIDEO_REFERENCE_SOURCE, ref, label, clipboardText: `@${label}` },
                { start: span.end, end: span.end, draftRev: span.draftRev })
            },
            removeTargetReference: (occurrence) => {
              if (occurrence.source !== VIDEO_REFERENCE_SOURCE) return false
              const binding = sessions.binding(sessionId)
              return binding !== undefined && child.conversation.input.for(binding.ctx).removeReference(occurrence)
            },
          }
          faces.set(sessionId, value)
          return value
        }
        child.slots.inject('conversation.session.header.utilities', () => child.slots.register({
          name: 'conversation.session.header.utilities', id: 'muse-session-video-menu', locale: NS, store, inject: injected,
        }, VideoHeader))
        child.slots.inject('sidebar.right.pane.tab', () => child.slots.register({
          name: 'sidebar.right.pane.tab', key: WORKSPACE_ID, locale: NS, store, inject: injected,
        }, VideoWorkspace))
        child.slots.inject('sidebar.right.pane.tab.title', () => child.slots.register({
          name: 'sidebar.right.pane.tab.title', key: WORKSPACE_ID, locale: NS,
        }, VideoWorkspaceTitle))
        child.slots.inject('deliverables.video', () => child.slots.register({
          name: 'deliverables.video', select: () => true, locale: NS, store, inject: injected,
        }, DeliveredVideoCard))
        child.slots.inject('conversation.chat.turnTail', () => child.slots.register({
          name: 'conversation.chat.turnTail', id: 'muse-generated-video', locale: NS, store, inject: injected,
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
