/**
 * Types only: the reconcile evidence `_probe/asset-reconcile.json` carries, the
 * remote values the comparison is made of, and the model-facing result.
 *
 * The evidence fields are the pipeline's own contract, not this package's: the
 * workspace's `_tools/asset_reconcile_report.py` and the host's paid-generation
 * gate both read the file this package writes, so a field's name, type and
 * meaning are fixed here rather than designed here.
 *
 * @module @deepseek-ai/dsh-tool-drama-assets/types
 */

/** One asset row of `/aigc/asset/list`, reduced to the fields the comparison settles on. */
export interface RemoteAsset {
  /** Provider asset id (`id`). */
  asset_id: number
  /** Provider removal flag (`delFlag`); the comparison keeps only the `"0"` rows. */
  del_flag?: string | undefined
  /** Provider asset name (`assetName`), absent when the row carries none. */
  name?: string | undefined
  /** Provider asset category number (`assetType`): 1=character, 2=scene, 3=prop. */
  asset_type?: number | undefined
  /** Provider URL (`url`), absent when the row carries none. */
  url?: string | undefined
  /** Provider creation stamp (`createTime`), absent when the row carries none. */
  create_time?: string | undefined
}

/** One material row of `/aigc/material/list`, reduced to the fields the comparison settles on. */
export interface RemoteMaterial {
  /** Provider material id (`id`). */
  material_id: number
  /** Provider asset id (`assetId`); null when the row names none. */
  asset_id: number | null
  /** Provider material name (`assetName`), absent when the row carries none. */
  name?: string | undefined
  /** Provider asset category number (`assetType`). */
  asset_type?: number | undefined
  /** Provider name flag (`isUsed`); true only for the integer 1. */
  is_used: boolean
  /** Provider hosting status (`hsAssetStatus`), absent when the row carries none. */
  hs_asset_status?: string | undefined
  /** Provider URL (`assetUrl`), absent when the row carries none. */
  url?: string | undefined
  /** Provider creation stamp (`createTime`), absent when the row carries none. */
  create_time?: string | undefined
}

/** One remote asset the manifest does not record: the pair the paid-generation gate blocks on. */
export interface UnregisteredItem {
  /** Provider asset id. */
  asset_id: number
  /** The material row's own id; the reader accepts no row without one. */
  material_id: number
  /** Name the material row carried, else the asset row's, else null. */
  name: string | null
  /** Category number the material row carried, else the asset row's, else null. */
  asset_type: number | null
  /** The `isUsed` value the row carried: 1 for every item on this list. */
  is_used: number
  /** The `hsAssetStatus` value the row carried: `Active` for every item on this list. */
  hs_asset_status: string
  /** URL the material row carried, else the asset row's, else null. */
  url: string | null
  /** Creation stamp the material row carried, else the asset row's, else null. */
  create_time: string | null
}

/** One manifest row whose asset id the remote project does not hold. */
export interface DanglingItem {
  /** Manifest `stable_id`, or null when the row declared none. */
  stable_id: string | null
  /** The manifest's Jubian asset id. */
  jubian_asset_id: number
  /** Manifest name, or null when the row declared none. */
  name: string | null
  /** Why this entry is reported, in the pipeline's own words. */
  why: string
}

/**
 * One person's disposition of one unregistered asset, kept across runs.
 *
 * This is a type alias rather than an interface on purpose: it is the value of a
 * durable JSON map, and an alias is what TypeScript lets a JSON object stand in for.
 */
export type Disposition = {
  /** `pending`, `registered`, or `ignored`. */
  status: string
  /** Why the asset is not needed; required and non-empty for `ignored`. */
  note: string
}

/** Every disposition one evidence file carries, keyed by asset id as text. */
export type Dispositions = Record<string, Disposition>

/** The paid-generation policy this evidence records, so the gate reads the same numbers. */
export interface ReconcilePolicy {
  /** The paid image channel the pipeline buys from. */
  image_channel: string
  /** Price of one image on that channel, CNY. */
  image_unit_price_cny: number
  /** Attempts one asset may take. */
  max_attempts_per_asset: number
  /** Worst-case cost of one asset across those attempts, CNY. */
  worst_case_cny_per_asset: number
  /** What the cross-project search is and where its conclusion goes. */
  cross_project_reuse: string
}

/** The evidence document written to `_probe/asset-reconcile.json`. */
export interface ReconcileReport {
  /** Project id, read from the manifest. */
  script_id: number
  /** When the comparison ran, with the `+08:00` offset. */
  ran_at: string
  /** How many rows each remote read returned and what the comparison used. */
  source: {
    asset_list_rows: number
    material_list_rows: number
    remote_alive: number
    remote_used: number
  }
  /** What the manifest declared. */
  manifest: {
    items: number
    lead_readonly_records: number
    asset_ids: number
  }
  /** Used remote assets the manifest also records. */
  matched: number
  /** Remote used-and-active assets the manifest does not record. */
  unregistered: UnregisteredItem[]
  /** Manifest records whose asset id the remote project does not hold. */
  dangling: DanglingItem[]
  /** Every disposition this report carries, plus the ones inherited from the previous report. */
  disposition: Dispositions
  /** Unregistered asset ids with no `registered` or `ignored` disposition. */
  blocking: number[]
  /** Ignored asset ids whose note is empty. */
  ignored_without_note: number[]
  /** Whether the evidence may release a paid asset creation. */
  ready: boolean
  /** The paid-generation policy in force. */
  policy: ReconcilePolicy
  /** The cross-project search conclusion a person wrote, carried forward verbatim. */
  cross_project_note: string
}

/** One project's own `assets_manifest.json`, as the comparison reads it. */
export interface Manifest {
  /** Project id the remote reads are keyed by. */
  script_id: number
  /** Asset rows this pipeline generated. */
  items: Record<string, unknown>[]
  /** Lead-character rows kept outside `items`. */
  lead_readonly_records: Record<string, unknown>[]
}

/** The method one call dispatches. */
export type DramaAssetsMethod = 'reconcile' | 'dispose'

/** The status a `dispose` call may write. */
export type DisposeStatus = 'registered' | 'ignored'
