/** Script Workshop draft data shared by the Muse editor and chat tools. @module */
import type { ScriptKind, ScriptRights, ScriptStyle } from './types.ts'

/** A cloud draft accessible to the signed-in Workshop user. */
export interface ScriptDraftSummary {
  readonly id: number
  readonly title: string
  readonly status: string
  readonly episodeCount: number
  readonly updatedAt: string | null
}

/** Search and pagination for the signed-in user's drafts. */
export interface ScriptDraftListRequest {
  readonly query?: string
  readonly offset: number
  readonly limit: number
}

/** A page of draft cards, with a cursor for the next page. */
export interface ScriptDraftList {
  readonly items: readonly ScriptDraftSummary[]
  readonly nextOffset: number | null
}

/** A draft to read or publish. */
export interface ScriptDraftRequest {
  readonly draftId: number
}

/** The editable episodes and context for a draft, with the whole-draft revision for publishing. */
export interface ScriptDraft extends ScriptDraftSummary {
  readonly episodes: readonly { readonly episode: number; readonly title: string }[]
  readonly context: {
    readonly outline: string | null
    readonly storyBible: string | null
  }
  readonly revision: string
  readonly canFinalize: boolean
}

/** A single episode of a particular draft. */
export interface ScriptDraftEpisodeRequest extends ScriptDraftRequest {
  readonly episode: number
}

/** An unapplied revision submitted for review by the signed-in editor. */
export interface ScriptDraftCandidate {
  readonly id: string
  readonly baseRevision: string
  readonly content: string
  readonly summary: string
  readonly createdAt: string
}

/** Saved episode text and any candidate awaiting the signed-in editor. */
export interface ScriptDraftEpisode extends ScriptDraftEpisodeRequest {
  readonly title: string
  readonly revision: string
  readonly version: number
  readonly content: string
  readonly candidate: ScriptDraftCandidate | null
}

/** Save human edits against the version displayed in the editor. */
export interface ScriptDraftSaveRequest extends ScriptDraftEpisodeRequest {
  readonly baseRevision: string
  readonly content: string
}

/** Submit a proposed change without updating the saved episode. */
export interface ScriptDraftStageRequest extends ScriptDraftSaveRequest {
  readonly summary: string
}

/** Review a specific proposal in a single episode. */
export interface ScriptDraftCandidateRequest extends ScriptDraftEpisodeRequest {
  readonly candidateId: string
}

/** Publish the exact reviewed draft version to the finalized library. */
export interface ScriptDraftFinalizeRequest extends ScriptDraftRequest {
  readonly baseRevision: string
  readonly rights: ScriptRights
  readonly kind: ScriptKind
  readonly style: ScriptStyle
  readonly originWorkId?: string
  readonly originTitle?: string
}

/** A draft's source text and structured screenplay are stored separately. */
export type ScriptDraftLayer = 'chapter' | 'storyboard'

/** One imported episode, in the order it appears in the draft. */
export interface ScriptDraftImportEpisode {
  readonly title?: string
  readonly content?: string
  readonly shotsJson?: string
}

/** Create a blank draft, or import a document or an ordered list of episodes. */
export interface ScriptDraftCreateRequest {
  readonly title: string
  readonly episodeCount?: number
  readonly episodes?: readonly ScriptDraftImportEpisode[]
  readonly requestId?: string
  readonly file?: { readonly filename: string; readonly base64: string }
}

/** Structured screenplay for one episode. The JSON preserves fields owned by the Workshop. */
export interface ScriptDraftStoryboard extends ScriptDraftEpisodeRequest {
  readonly title: string
  readonly shotsJson: string
  readonly revision: string
  readonly version: number
  readonly exists: boolean
  readonly stale: boolean
}

/** Save structured screenplay for the exact revision displayed. */
export interface ScriptDraftStoryboardSaveRequest extends ScriptDraftEpisodeRequest {
  readonly baseRevision: string
  readonly shotsJson: string
}

/** Select one layer's history for an episode. */
export interface ScriptDraftHistoryRequest extends ScriptDraftEpisodeRequest {
  readonly layer: ScriptDraftLayer
}

/** Metadata of one saved historical version. */
export interface ScriptDraftHistoryItem {
  readonly id: number
  readonly version: number
  readonly createdAt: string | null
  readonly createdBy: string | null
}

/** Available historical versions of an episode layer. */
export interface ScriptDraftHistory {
  readonly items: readonly ScriptDraftHistoryItem[]
}

/** Content of a historical version, as plain text or structured JSON for its layer. */
export interface ScriptDraftHistoryEntry extends ScriptDraftHistoryItem {
  readonly content: string
}

/** Identify a historical version in one episode and layer. */
export interface ScriptDraftHistoryEntryRequest extends ScriptDraftHistoryRequest {
  readonly historyId: number
}

/** Restore an historical version as a new revision of the same layer. */
export interface ScriptDraftHistoryRestoreRequest extends ScriptDraftHistoryEntryRequest {
  readonly baseRevision: string
}

/** The updated episode layer after a manual restore. */
export interface ScriptDraftHistoryRestore {
  readonly episode: ScriptDraftEpisode | null
  readonly storyboard: ScriptDraftStoryboard | null
}

/** Select the saved material and document format to export. */
export interface ScriptDraftExportRequest extends ScriptDraftRequest {
  readonly kind: 'chapters' | 'storyboards' | 'mixed' | 'outline'
  readonly format: 'docx' | 'txt' | 'md'
  readonly episode?: number
}

/** An authenticated Workshop export, carried as base64 so it can be saved locally. */
export interface ScriptDraftExport {
  readonly filename: string
  readonly mime: string
  readonly base64: string
}
