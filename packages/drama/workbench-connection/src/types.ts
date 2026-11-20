/** Script Workshop's finalized-script library as Muse reads it: scripts, versions, picks and production links. @module */

/** Library stage: waiting for a lead, picked by a lead, or made into a Jingliu project. */
export type ScriptStatus = 'waiting' | 'picked' | 'in_production'
/** Rights: an original script owned by the company, or a licensed adaptation. */
export type ScriptRights = 'original' | 'licensed'
/** Script form as Jingliu's project types name it: 剧情剧 (`drama`) or 解说剧 (`narration`). */
export type ScriptKind = 'drama' | 'narration'
/** Visual style as Jingliu's projects name it: 仿真人 (`realistic`) or 3D (`3d`). */
export type ScriptStyle = 'realistic' | '3d'

/** A Workshop user, by ID and shown name (null when the account has none). */
export interface ScriptPerson {
  readonly id: number
  readonly name: string | null
}

/** One script's library card. `originWorkId` names the original on the data station (`fanqie:…`, `hongguo:…`). */
export interface ScriptSummary {
  readonly id: number
  readonly title: string
  readonly owner: ScriptPerson
  readonly rights: ScriptRights
  readonly originWorkId: string | null
  readonly originTitle: string | null
  readonly kind: ScriptKind
  readonly style: ScriptStyle
  readonly episodes: number
  readonly words: number
  readonly status: ScriptStatus
  readonly latestVersion: number
  readonly picked: { readonly by: ScriptPerson; readonly version: number; readonly at: string | null } | null
  readonly project: { readonly id: string; readonly title: string } | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

/** One library page to read; `mine` keeps the caller's own scripts. */
export interface ScriptListRequest {
  readonly status?: ScriptStatus
  readonly q?: string
  readonly mine?: boolean
  readonly page: number
  readonly limit: number
}

/** One library page with counts per stage for the same search, and whether the caller may pick. */
export interface ScriptList {
  readonly items: readonly ScriptSummary[]
  readonly total: number
  readonly page: number
  readonly limit: number
  readonly counts: { readonly waiting: number; readonly picked: number; readonly inProduction: number; readonly all: number }
  readonly canPick: boolean
}

/** One script to read; `version` defaults to the latest. */
export interface ScriptReadRequest {
  readonly id: number
  readonly version?: number
}

/** One episode of a script version. */
export interface ScriptEpisode {
  readonly order: number
  readonly title: string
  readonly content: string
}

/** One script with its versions, newest first, and the text of one version. */
export interface ScriptDetail {
  readonly script: ScriptSummary
  readonly canPick: boolean
  readonly versions: readonly { readonly number: number; readonly words: number; readonly createdAt: string | null; readonly by: ScriptPerson }[]
  readonly content: { readonly version: number; readonly episodes: readonly ScriptEpisode[] }
}

/** A lead's pick of one version. */
export interface ScriptPickRequest {
  readonly id: number
  readonly version: number
}

/** The Jingliu project a picked script became. */
export interface ScriptProductionRequest {
  readonly id: number
  readonly projectId: string
  readonly projectTitle: string
}
