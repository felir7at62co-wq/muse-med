/** Durable, local production plans and source-backed asset candidates. */
export type ProductionKind = 'character' | 'scene' | 'prop' | 'voice'

/** One live project asset; image URLs are references, not evidence of visual review. */
export interface ProductionAsset {
  asset_id: number
  name: string
  kind: ProductionKind
  url: string | null
  material_id: string | null
  usable: boolean
  character_id?: string | undefined
  voice_period_id?: string | undefined
  duration_seconds?: number | undefined
  aliases?: string[] | undefined
  state_or_costume?: string | undefined
  scene_conditions?: string[] | undefined
  audio_duration_basis?: 'project_reference_metadata' | undefined
}

/** One shot's intended identity and appearance, supplied by Muse or parsed from explicit fields. */
export interface ProductionRequirement {
  shot: number
  kind: ProductionKind
  name: string
  state?: string | undefined
  conditions?: string[] | undefined
  character_id?: string | undefined
  voice_period_id?: string | undefined
}

/** A local choice applies to this shot and identity only, including an explicit omission. */
export interface ProductionChoice {
  shot: number
  kind: ProductionKind
  name: string
  asset_id: number | null
}

/** A metadata comparison does not establish visual or acoustic identity. */
export interface ProductionMatch extends ProductionRequirement {
  candidates: (ProductionAsset & { reasons: string[]; compatible: boolean })[]
  candidate_count: number
  candidates_truncated: boolean
  selected_asset_id: number | null
  selection_basis: 'explicit' | 'unique_metadata' | 'unresolved' | 'omitted'
  review_required: true
}

/** Findings are advisory; they do not prevent saving a local plan or publishing a draft. */
export interface ProductionWarning {
  code: string
  shot: number | null
  name?: string | undefined
  message: string
}

/** One independently publishable card, preserving whole authored shots. */
export interface ProductionPackage {
  index: number
  name: string
  shots: number[]
  duration: number
  prompt: string
  images: { asset_id: number; material_key: string }[]
  voices: ProductionAsset[]
  storyboard_id: number | null
  expected_snapshot_sha256: string | null
  current_assets: { material_key: string; name: string; asset_id: number | null; kind: string; url: string | null }[]
  target_candidates: number[]
}

/** Complete local preview, sufficient for restart, per-shot revision and free publication. */
export interface ProductionPlan {
  version: 1
  operation: 'muse_production'
  project_dir: string
  script_id: number
  script_name: string
  episode: number
  episode_id: number
  source_path: string
  source_sha256: string
  source: string
  requirements: ProductionRequirement[]
  choices: ProductionChoice[]
  targets: { index: number; storyboard_id: number | null }[]
  assets: ProductionAsset[]
  matches: ProductionMatch[]
  packages: ProductionPackage[]
  warnings: ProductionWarning[]
  model: {
    modelId: string
    platformId: string
    standardId: number
    modelGenerationTypeId: number
    videoStandardId: number
    genType: number
    ratio: string
    resolution: string
    maxDurationSeconds: number | null
    revision: number
  }
  fingerprint: string
}
