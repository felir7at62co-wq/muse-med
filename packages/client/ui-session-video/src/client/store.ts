/** Transient video selection shared by one conversation's shelf and inline cards. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionVideoAnalysis, SessionVideoInventory, SessionVideoSource } from '@deepseek-ai/dsh-session-video'

/** JSON-compatible state; media elements and DOM measurements remain component-local. */
export interface VideoState {
  sources: readonly SessionVideoSource[]
  analyses: Readonly<Record<string, SessionVideoAnalysis>>
  open: boolean
  selected: string | null
  collected: Readonly<Record<string, boolean>>
  issue: string | null
}

type VideoActions = {
  inventory: (draft: VideoState, value: SessionVideoInventory) => void
  analysis: (draft: VideoState, value: SessionVideoAnalysis) => void
  retryFailed: (draft: VideoState) => void
  toggle: (draft: VideoState) => void
  select: (draft: VideoState, id: string) => void
  openSource: (draft: VideoState, id: string) => void
  collect: (draft: VideoState, id: string, value: boolean) => void
}

/** Create Session-scoped selection and successful source observations.
 * @returns The declared store handle shared by this plugin's registrations.
 */
export function createVideoStore(): EngineStoreHandle<VideoState, VideoActions> {
  return defineStore({
    init: (): VideoState => ({ sources: [], analyses: {}, open: false, selected: null, collected: {}, issue: null }),
    actions: {
      inventory: (draft, value: SessionVideoInventory) => {
        draft.sources = value.sources
        draft.issue = value.issues.join('；') || null
        if (!value.sources.some(source => source.id === draft.selected)) draft.selected = value.sources[0]?.id ?? null
      },
      analysis: (draft, value: SessionVideoAnalysis) => { draft.analyses = { ...draft.analyses, [value.sourceId]: value } },
      retryFailed: (draft) => { draft.analyses = Object.fromEntries(Object.entries(draft.analyses).filter(([, analysis]) => analysis.state === 'ready')) },
      toggle: (draft) => { draft.open = !draft.open },
      select: (draft, id: string) => { draft.selected = id },
      openSource: (draft, id: string) => { draft.selected = id; draft.open = true },
      collect: (draft, id: string, value: boolean) => { draft.collected = { ...draft.collected, [id]: value } },
    },
  })
}
/** Shared Session store type for native slot props. */
export type VideoStore = ReturnType<typeof createVideoStore>
