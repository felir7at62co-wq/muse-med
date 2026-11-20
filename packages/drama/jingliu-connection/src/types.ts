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
  /** Production mode key, such as `drama`, `narration` or `anime`; '' when unknown. */
  mode: string
  /** Frame ratio such as `9:16`; '' when unknown. */
  aspect: string
  /** ISO creation time; '' for productions the studio never dated. */
  createdAt: string
  /** Technical defaults chosen at creation; '' where not set. */
  profile: { videoModel: string; generationMode: string; resolution: string }
}

/** The choices the studio offers for a new production. */
export interface StudioCatalog {
  /** Production modes with the art styles each allows, first style the default. */
  modes: { key: string; label: string; styles: { key: string; label: string; enabled: boolean }[] }[]
  aspects: string[]
  resolutions: string[]
  imageModels: { id: string; name: string }[]
  videoModels: { id: string; name: string }[]
  generationModes: { id: string; name: string }[]
}

/** Settings of a production to create; every value comes from {@link StudioCatalog}, '' for the studio default. */
export interface StudioNewProject {
  title: string
  mode: string
  artStyle: string
  aspect: string
  resolution: string
  videoModel: string
  imageModel: string
  generationMode: string
}

/** A production asset or a view-only reference from the signed-in studio library. */
export interface StudioAsset {
  id: string
  name: string
  kind: string
  thumbnail: string
  description: string
  referenceOnly: boolean
  /** Productions that use this asset. */
  uses: number
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

/** Production-wide configuration of one project, read-only in the workbench. */
export interface StudioConfig {
  projectId: string
  title: string
  /** Frame ratio such as `9:16`. */
  aspect: string
  artStyle: string
  /** `drama` (live-action story) or `narration` (narrated drama), as the studio names it. */
  mode: string
  resolution: string
  imageModel: string
  videoModel: string
}

/** One episode of a production. */
export interface StudioEpisode {
  /** Episode number as the studio counts it, from 1. */
  number: number
  title: string
  hasShots: boolean
}

/** One shot of an episode with its locked or generated video prompt. */
export interface StudioShot {
  id: string
  /** Position within the whole production. */
  order: number
  episode: number
  /** Position within its episode, from 1. */
  index: number
  prompt: string
  characters: string[]
  location: string
  props: string[]
  durationSec: number | null
  hasVideo: boolean
  /** Why the last generation failed, or ''. */
  failReason: string
  stale: boolean
}

/** One generated version of a shot's video. */
export interface StudioShotVersion {
  number: number
  model: string
  videoPath: string
  createdAt: string
}

/** The media of one shot: the video in use, its first frame and every version. */
export interface StudioShotMedia {
  shotId: string
  videoPath: string
  firstFramePath: string
  adoptedVersion: number | null
  versions: StudioShotVersion[]
}

/** A character, location, prop or other asset of one production. */
export interface StudioProjectAsset {
  id: string
  kind: string
  name: string
  imagePath: string
  prompt: string
}

/** A voice, narration, music or sound-effect clip of one production. */
export interface StudioAudioClip {
  id: string
  kind: string
  text: string
  path: string
  durationSec: number | null
}

/** Everything the workbench's asset page shows for one production. */
export interface StudioProjectAssets {
  assets: StudioProjectAsset[]
  audio: StudioAudioClip[]
}
