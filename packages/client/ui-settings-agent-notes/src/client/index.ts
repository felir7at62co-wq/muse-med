/** Agent Notes Settings page, browser half. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the generated `agentNotes` Remote namespace merge and the
// wire types the injected face hands the component.
import type {} from '@deepseek-ai/dsh-api-agent-notes/remote'
import { AgentNotesSection } from './AgentNotesSection.tsx'
import type {
  AgentNoteDraft,
  AgentNotesCatalogOutcome,
  AgentNotesSectionInjected,
  AgentNoteOutcome,
  AgentNoteSaveOutcome,
} from './AgentNotesSection.tsx'
import { en, zh, type AgentNotesLocaleKey } from './locales.ts'

export type {
  AgentNoteDraft,
  AgentNotesCatalogOutcome,
  AgentNotesSectionInjected,
  AgentNotesSectionProps,
  AgentNoteOutcome,
  AgentNoteSaveOutcome,
} from './AgentNotesSection.tsx'
export type { AgentNotesLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Notes section copy. */
    'settings.agentNotes': AgentNotesLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.agentNotes'

/** Services required by the Settings registration and the notes Remote calls. */
export const inject = ['slots', 'locale', 'remote', 'remote.agentNotes']

/**
 * Turn a note read into the draft the section holds.
 * @param value - one `read` result.
 * @returns the editable payload, with the status present only when the note declares one.
 */
function draftOf(value: {
  readonly id: string
  readonly title: string
  readonly status?: string
  readonly text: string
  readonly version: string
  readonly bytes: number
}): AgentNoteDraft {
  return {
    id: value.id,
    title: value.title,
    ...value.status === undefined ? {} : { status: value.status },
    text: value.text,
    version: value.version,
    bytes: value.bytes,
  }
}

/** Contribute the Agent Notes page to Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-agent-notes: dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): AgentNotesSectionInjected => ({
    list: async (): Promise<AgentNotesCatalogOutcome> => {
      const result = await ctx.remote.agentNotes.list()
      return result.ok
        ? { ok: true, catalog: result.value }
        : { ok: false, code: result.error.code, message: result.error.message }
    },
    read: async (id: string): Promise<AgentNoteOutcome> => {
      const result = await ctx.remote.agentNotes.read(id)
      return result.ok
        ? { ok: true, note: draftOf(result.value) }
        : { ok: false, code: result.error.code, message: result.error.message }
    },
    save: async (id: string, text: string, expectedVersion: string): Promise<AgentNoteSaveOutcome> => {
      const result = await ctx.remote.agentNotes.save(id, text, expectedVersion)
      return result.ok
        ? { ok: true, version: result.value.version, bytes: result.value.bytes }
        : { ok: false, code: result.error.code, message: result.error.message }
    },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-notes',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, AgentNotesSection))
}
