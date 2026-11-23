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
