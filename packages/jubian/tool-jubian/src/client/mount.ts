/**
 * Source-safe registration of the Jubian Settings page and its generated Remote namespaces.
 *
 * Split from the browser entry because the entry imports the generated
 * `./remote` artifact, which exists only after a Host build: this module holds
 * the lifecycle and the injected face, and the entry only binds them to that
 * artifact.
 */

import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { VideoDirectory } from './video-directory.ts'
import { VideoModelSelect, type VideoModelSelectProps } from './VideoModelSelect.tsx'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-tool-jubian/remote'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { RecoveryDirectory, type RecoveryClient } from './recovery-directory.ts'
import { RecoveryToast, type RecoveryInjected, type RecoveryToastInjected } from './VideoRecoverySection.tsx'
import { JubianTokenSection } from './JubianTokenSection.tsx'
import type { JubianTokenInjected, JubianTokenOutcome, JubianTokenStatus } from './JubianTokenSection.tsx'
import { en, zh, ja, es, fr, de, ru, pt, type JubianLocaleKey } from './locales.ts'

export type {
  JubianTokenInjected,
  JubianTokenOutcome,
  JubianTokenSectionProps,
  JubianTokenStatus,
} from './JubianTokenSection.tsx'
export type { JubianLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Jubian credential and project-video recovery copy. */
    'settings.jubian': JubianLocaleKey
  }
}

/** Reuse the session video selector in the Bot details panel. */
export interface JubianVideoUi {
  /** Render the selected Session's video controls when its scope is available. */
  render(sessionId: SessionId): ReactNode
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client-side video selector for the specified Session. */
    jubianVideoUi: JubianVideoUi
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

/** Contribute credentials, recovery controls and shell feedback through Settings-owned facts. */
function registerSection(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'tool-jubian: token dictionaries')

  const t = ctx.locale.bind(NS)
  const recovery = new RecoveryDirectory()
  ctx.effect(() => () => { recovery.dispose() })
  const recoveryFace: RecoveryInjected = {
    hooks: { recoveryState: recovery.state },
    setRecoveryProjectDir: (path) => { recovery.setProjectDir(path) },
    chooseRecoveryProject: () => recovery.chooseProject(),
    configureRecovery: enabled => recovery.configure(enabled),
    refreshRecovery: () => recovery.refresh(),
    openRecoveryAction: (action, report) => { recovery.open(action, report) },
    closeRecoveryDialog: () => { recovery.closeDialog() },
    confirmRecoveryDialog: (id, text) => recovery.confirm(id, text),
    deliverRecovery: report => recovery.deliver(report),
  }
  ctx.inject(['remote.jubianVideoRecovery', 'connection'], (scope) => {
    const connection = scope.get('connection') as ConnectionHandle
    const client: RecoveryClient = {
      status: () => scope.remote.jubianVideoRecovery.status(),
      configure: input => scope.remote.jubianVideoRecovery.configure(input),
      review: input => scope.remote.jubianVideoRecovery.review(input),
      adopt: input => scope.remote.jubianVideoRecovery.adopt(input),
      deliverApprovedMp4: input => scope.remote.jubianVideoRecovery.deliverApprovedMp4(input),
    }
    let generation: object | undefined
    let release: (() => void) | undefined
    const update = (): void => {
      const current = connection.generation.getSnapshot()
      if (current === generation) return
      release?.()
      generation = current
      release = current === undefined ? undefined : recovery.connect(client)
    }
    scope.effect(() => connection.generation.subscribe(update))
    scope.effect(() => () => { release?.() })
    update()
  })
  const desktopPicker = (globalThis as typeof globalThis & {
    __DSH_DIRECTORY_PICKER__?: { pick: () => Promise<string | null> }
  }).__DSH_DIRECTORY_PICKER__
  ctx.inject(['remoteAccess'], (scope) => {
    if (desktopPicker === undefined) return
    return scope.remoteAccess.whenAccess('directoryPicker/pick', () =>
      recovery.offerPicker(() => desktopPicker.pick()))
  })
  const toastFace = (): RecoveryToastInjected => ({
    hooks: { recoveryNotice: recovery.notice },
    dismissRecoveryNotice: (sequence) => { recovery.dismissNotice(sequence) },
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'jubian-recovery-toast', locale: NS, inject: toastFace,
  }, RecoveryToast))
  const injected = (): JubianTokenInjected => ({
    ...recoveryFace,
    describe: async (): Promise<JubianTokenOutcome> => outcomeOf(await ctx.remote.jubianToken.describe()),
    set: async (value: string): Promise<JubianTokenOutcome> => outcomeOf(await ctx.remote.jubianToken.set(value)),
    unset: async (): Promise<JubianTokenOutcome> => outcomeOf(await ctx.remote.jubianToken.unset()),
  })

  ctx.inject(['sessions', 'remote.jubianVideoSelection'], (scope) => {
    const directories = new WeakMap<object, { directory: VideoDirectory; scope: object }>()
    const controller = new AbortController()
    scope.effect(() => () => { controller.abort() })
    scope.effect(async () => {
      const available = await scope.remote.jubianVideoSelection.available()
      if (controller.signal.aborted || !available.ok || !available.value) return () => undefined
      const directoryFor = (sessionId: SessionId): VideoDirectory => {
        const binding = scope.sessions.binding(sessionId)
        const sessionScope = scope.sessions.scope(sessionId)
        if (!binding || !sessionScope) throw new Error('Video selector requires a session scope')
        const cached = directories.get(binding)
        if (cached?.scope === sessionScope) return cached.directory
        const directory = new VideoDirectory(scope.remote.jubianVideoSelection, sessionId,
          binding.session.projections.faceOf('jubianVideoSelection'))
        const entry = { directory, scope: sessionScope }
        directories.set(binding, entry)
        const release = scope.effect(() => () => directory.dispose())
        sessionScope.effect(() => {
          void directory.load()
          return () => { if (directories.get(binding) === entry) directories.delete(binding); return release() }
        })
        return directory
      }
      const detail = ({ sessionId, selected }: { sessionId: SessionId; selected: VideoDirectory }): ReactNode => {
        const useVideoState: VideoModelSelectProps['useVideoState'] = selector => useSyncExternalStore(
          listener => selected.store.subscribe(listener), () => selector(selected.store.getSnapshot()))
        return createElement(VideoModelSelect, { sessionId, useVideoState, t, variant: 'details',
          load: () => selected.load(), select: (key: string) => selected.select(key) } as VideoModelSelectProps)
      }
      const releaseDetail = scope.provide('jubianVideoUi', {
        render: (sessionId: SessionId) => {
          if (!scope.sessions.binding(sessionId) || !scope.sessions.scope(sessionId)) return null
          return createElement(detail, { sessionId, selected: directoryFor(sessionId) })
        },
      })
      const registration = scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right', id: 'jubian-video-model', order: 80, locale: NS,
        inject: (sessionId) => {
          const selected = directoryFor(sessionId)
          return { hooks: { videoState: selected.store }, load: () => selected.load(), select: (key: string) => selected.select(key) }
        },
      }, VideoModelSelect))
      return () => { registration(); releaseDetail() }
    })
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
 * Mount the generated Jubian Remote contribution and register its Settings page.
 * @param ctx - Client context carrying the slot registry, locale, and Remote service.
 * @param contribution - Generated Jubian descriptors used by the Settings page.
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
