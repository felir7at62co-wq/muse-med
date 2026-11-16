/** Transient video selection shared by one conversation's shelf and inline cards. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionVideoAnalysis, SessionVideoShotId, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video/types'
import type { VideoEpisodeFilter } from './target-selection.ts'

/** Source-local seek retained while the video workspace changes presentation. */
export interface VideoSeek {
  readonly sourceId: SessionVideoSourceId
  readonly time: number
  readonly revision: number
}

/** JSON-compatible state; media elements and DOM measurements remain component-local. */
export interface VideoState {
  analyses: Readonly<Record<string, SessionVideoAnalysis>>
  selected: SessionVideoSourceId | null
  selectedEpisode: VideoEpisodeFilter
  selectedShot: SessionVideoShotId | null
  zoom: number
  seek: VideoSeek | null
  handledNavigation: string | null
}

type VideoActions = {
  analysis: (draft: VideoState, value: SessionVideoAnalysis) => void
  retryFailed: (draft: VideoState) => void
  select: (draft: VideoState, id: SessionVideoSourceId) => void
  selectEpisode: (draft: VideoState, episode: VideoEpisodeFilter) => void
  selectShot: (draft: VideoState,
    value: { readonly sourceId: SessionVideoSourceId; readonly shotId: SessionVideoShotId; readonly time: number }) => void
  setZoom: (draft: VideoState, zoom: number) => void
  seekTo: (draft: VideoState, value: { readonly sourceId: SessionVideoSourceId; readonly time: number }) => void
  dismissNavigation: (draft: VideoState, key: string) => void
}

/** Create Session-scoped selection and successful source observations.
 * @returns The declared store handle shared by this plugin's registrations.
 */
export function createVideoStore(): EngineStoreHandle<VideoState, VideoActions> {
  return defineStore({
    init: (): VideoState => ({ analyses: {}, selected: null, selectedEpisode: 'all',
      selectedShot: null, zoom: 1, seek: null, handledNavigation: null }),
    actions: {
      analysis: (draft, value: SessionVideoAnalysis) => { draft.analyses = { ...draft.analyses, [value.sourceId]: value } },
      retryFailed: (draft) => { draft.analyses = Object.fromEntries(Object.entries(draft.analyses).filter(([, analysis]) => analysis.state === 'ready')) },
      select: (draft, id: SessionVideoSourceId) => { draft.selected = id; draft.selectedShot = null },
      selectEpisode: (draft, episode: VideoEpisodeFilter) => { draft.selectedEpisode = episode },
      selectShot: (draft, value) => {
        draft.selected = value.sourceId; draft.selectedShot = value.shotId
        draft.seek = { sourceId: value.sourceId, time: value.time, revision: (draft.seek?.revision ?? 0) + 1 }
      },
      setZoom: (draft, zoom: number) => { draft.zoom = zoom },
      seekTo: (draft, value) => {
        draft.selected = value.sourceId
        draft.seek = { ...value, revision: (draft.seek?.revision ?? 0) + 1 }
      },
      dismissNavigation: (draft, key: string) => { draft.handledNavigation = key },
    },
  })
}
/** Shared Session store type for native slot props. */
export type VideoStore = ReturnType<typeof createVideoStore>
