/** Project explicitly associated with a local conversation. */
export interface SelectedProject { id: string; title: string }

/** Data rendered by the Muse production panels. */
export interface StudioProject {
  id: string
  title: string
  episodes: number
  shots: number
  completed: number
  role: string
  thumbnail: string
}

/** A reusable media item visible to the signed-in studio account. */
export interface StudioAsset {
  id: string
  name: string
  kind: string
  thumbnail: string
}

/** A page of shared assets and the total matching count. */
export interface StudioLibrary {
  total: number
  items: StudioAsset[]
}

/** Filter and offset for a shared asset page. */
export interface StudioLibraryQuery {
  kind: 'all' | 'character' | 'location' | 'prop'
  query: string
  offset: number
}

/** Allowance, spending and held credit reported by the studio. */
export interface StudioBalance {
  unlimited: boolean
  available: string
  usedFen: number
  heldFen: number
}

/** Project-specific model overrides and video resolution from the native studio. */
export interface StudioOptions {
  projectId: string
  resolution: string
  resolutions: string[]
  models: { id: string; name: string }[]
  projectModel: string
  character: string
  location: string
  prop: string
}

/** A single changed project field; other users' concurrent settings are preserved. */
export type StudioSetting = 'resolution' | 'character' | 'location' | 'prop'

/** Current reference display preference for a production. */
export interface StudioPreferences {
  projectId: string
  hidePromptChips: boolean
}
