/** Transient video selection shared by one conversation's shelf and inline cards. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionVideoAnalysis, SessionVideoInventory, SessionVideoSource } from '@deepseek-ai/dsh-session-video'

/** JSON-compatible state; media elements and DOM measurements remain component-local. */
export interface VideoState {
  sources: readonly SessionVideoSource[]
  analyses: Readonly<Record<string, SessionVideoAnalysis>>
  detectErrors: Readonly<Record<string, string>>
  open: boolean
  selected: string | null
  observed: Readonly<Record<string, number>>
  issue: string | null
  inventoryRevision: number
}

type VideoActions = {
  inventory: (draft: VideoState, value: SessionVideoInventory) => void
  analysis: (draft: VideoState, value: SessionVideoAnalysis) => void
  detectionFailed: (draft: VideoState, id: string, version: string) => void
  retryFailed: (draft: VideoState) => void
  toggle: (draft: VideoState) => void
  openSource: (draft: VideoState, id: string) => void
  observe: (draft: VideoState, id: string, delta: 1 | -1) => void
  refreshInventory: (draft: VideoState) => void
}

/** Create Session-scoped selection and successful source observations.
 * @returns The declared store handle shared by this plugin's registrations.
 */
export function createVideoStore(): EngineStoreHandle<VideoState, VideoActions> {
  return defineStore({
    init: (): VideoState => ({ sources: [], analyses: {}, detectErrors: {}, open: false, selected: null,
      observed: {}, issue: null, inventoryRevision: 0 }),
    actions: {
      inventory: (draft, value: SessionVideoInventory) => {
        draft.sources = value.sources
        draft.issue = value.issues.join('；') || null
        draft.detectErrors = Object.fromEntries(Object.entries(draft.detectErrors).filter(([id, version]) =>
          value.sources.some(source => source.id === id && source.version === version)))
        draft.analyses = Object.fromEntries(Object.entries(draft.analyses).filter(([id, analysis]) =>
          value.sources.some(source => source.id === id && source.version === analysis.sourceVersion)))
        if (!value.sources.some(source => source.id === draft.selected)) { draft.selected = null; draft.open = false }
      },
      analysis: (draft, value: SessionVideoAnalysis) => {
        if (!draft.sources.some(source => source.id === value.sourceId && source.version === value.sourceVersion)) return
        draft.analyses = { ...draft.analyses, [value.sourceId]: value }
      },
      detectionFailed: (draft, id: string, version: string) => {
        if (draft.sources.some(source => source.id === id && source.version === version)) {
          draft.detectErrors = { ...draft.detectErrors, [id]: version }
        }
      },
      retryFailed: (draft) => {
        draft.analyses = Object.fromEntries(Object.entries(draft.analyses).filter(([, analysis]) => analysis.state === 'ready'))
        draft.detectErrors = {}
      },
      toggle: (draft) => { draft.open = !draft.open },
      openSource: (draft, id: string) => { draft.selected = id; draft.open = true },
      observe: (draft, id: string, delta: 1 | -1) => {
        const count = (draft.observed[id] ?? 0) + delta
        if (count > 0) draft.observed = { ...draft.observed, [id]: count }
        else draft.observed = Object.fromEntries(Object.entries(draft.observed).filter(([key]) => key !== id))
      },
      refreshInventory: (draft) => { draft.inventoryRevision++ },
    },
  })
}
/** Shared Session store type for native slot props. */
export type VideoStore = ReturnType<typeof createVideoStore>
