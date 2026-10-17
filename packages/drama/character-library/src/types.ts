/** Public types for the Host-owned character reference library. */
import type { CatalogAssetId, MetadataFormat, MetadataStatusClass, OriginalCharacterAssetId } from '@deepseek-ai/dsh-character-asset-catalog'


/** The two reviewed historical object prefixes. No caller can supply another prefix. */
export type CharacterLibraryPrefix =
  | 'assets/reference/characters/stylized/ancient/ancient/'
  | 'assets/reference/characters/stylized/urban/urban/'

/** User-facing collection selector, mapped internally to one fixed prefix. */
export type CharacterLibraryCollection = 'ancient' | 'urban'

/** Project role policy input; it is not catalog metadata. */
export type CharacterRoleClass = 'lead' | 'important_support' | 'support' | 'extra'

/** One object listed by the deployment-specific store. */
export interface CharacterLibraryObjectListItem {
  readonly key: string
  readonly bytes: number
  readonly etag: string | null
}

/** One bounded store listing page. */
export interface CharacterLibraryObjectListPage {
  readonly objects: readonly CharacterLibraryObjectListItem[]
  readonly nextCursor: string | null
}

/** Read-only store listing request. */
export interface CharacterLibraryObjectListRequest {
  readonly prefix: CharacterLibraryPrefix
  readonly cursor?: string
  readonly limit: number
}

/** Object metadata returned without fetching its body. */
export interface CharacterLibraryObjectHead {
  readonly key: string
  readonly bytes: number
  readonly etag: string | null
  readonly contentType: string | null
}

/** A bounded in-memory object read. */
export interface CharacterLibraryObjectGet extends CharacterLibraryObjectHead {
  readonly data: Uint8Array
}

/** Store readiness computed without constructing an SDK client or doing network IO. */
export interface CharacterLibraryObjectStoreStatus {
  readonly readConfigured: boolean
  readonly writeConfigured: boolean
}

/** Read-only catalog projection. It never grants use permission. */
export interface CharacterLibraryEntry {
  readonly catalogAssetId: CatalogAssetId
  readonly originalAssetId: OriginalCharacterAssetId
  readonly collection: CharacterLibraryCollection
  readonly format: MetadataFormat
  readonly metadataStatus: MetadataStatusClass
  readonly metadataKey: string
  readonly imageKey: string
  readonly category: string | null
  readonly setting: string | null
  readonly artStyle: string | null
  readonly era: readonly string[]
  readonly gender: string | null
  readonly appearance: readonly string[]
  readonly tags: readonly string[]
  readonly safety: {
    readonly canPublish: false
    readonly canReuse: false
    readonly canBind: false
    readonly applyAllowed: false
  }
}

/** Mounted domain status. A missing service is represented by the Consumer as unconfigured. */
export interface CharacterLibraryStatus {
  readonly configured: boolean
  readonly sourceId: 'muse-character-reference-qa'
  readonly readOnly: true
  readonly uploadPending: 'available' | 'unavailable'
}

/** Bounded library browse request. */
export interface CharacterLibraryBrowseRequest {
  readonly collection?: CharacterLibraryCollection | 'all'
  readonly query?: string
  readonly metadataStatus?: MetadataStatusClass
  readonly cursor?: string
  readonly limit?: number
}

/** One page of read-only character references. */
export interface CharacterLibraryBrowseResult {
  readonly entries: readonly CharacterLibraryEntry[]
  readonly nextCursor: string | null
  readonly scanned: number
}

/** Stable catalog identity lookup. */
export interface CharacterLibraryDetailRequest {
  readonly catalogAssetId: CatalogAssetId | string
}

/** Bounded image preview request. */
export interface CharacterLibraryPreviewRequest extends CharacterLibraryDetailRequest {
  readonly maxBytes?: number
  /** Original-image digest observed while matching; a changed image is rejected. */
  readonly expectedSha256?: string
}

/** Verified preview bytes. Controllers own any later data-URL or transport encoding. */
export interface CharacterLibraryPreview {
  readonly catalogAssetId: CatalogAssetId
  readonly metadataStatus: MetadataStatusClass
  readonly data: Uint8Array
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp'
  readonly bytes: number
  readonly sha256: string
  readonly safety: CharacterLibraryEntry['safety']
}

/** Structured, bounded role requirements supplied by a Host consumer. */
export interface CharacterRecommendationRequest {
  readonly roleClass: CharacterRoleClass
  /** Required for any non-lead lookup; recorded in the recommendation explanation, never in catalog metadata. */
  readonly supportingUseReason?: string
  readonly collection?: CharacterLibraryCollection | 'all'
  readonly query?: string
  readonly requiredEra?: string
  readonly gender?: string
  readonly styleTerms?: readonly string[]
  readonly traitTerms?: readonly string[]
  readonly roleTerms?: readonly string[]
}

/** One scored candidate without any implied approval. */
export interface CharacterRecommendationCandidate {
  readonly entry: CharacterLibraryEntry
  readonly score: number
  readonly matched: readonly string[]
}

/** One ranked reference with a digest measured from verified original image bytes. */
export interface CharacterMatchCandidate extends CharacterRecommendationCandidate {
  readonly imageSha256: string
}

/** Bounded metadata-first match; candidates still require visual selection and separate use authorization. */
export type CharacterMatchResult =
  | {
    readonly status: 'candidates'
    readonly candidates: readonly CharacterMatchCandidate[]
    readonly reason: string
    readonly uncertainties: readonly string[]
    readonly applyAllowed: false
  }
  | {
    readonly status: 'no_match'
    readonly reason: string
    readonly uncertainties: readonly string[]
    readonly applyAllowed: false
  }

/** Deterministic recommendation result. Equal top scores require review instead of an ID tie-break. */
export type CharacterRecommendationResult =
  | {
    readonly status: 'recommended'
    readonly candidate: CharacterRecommendationCandidate
    readonly reason: string
    readonly uncertainties: readonly string[]
    readonly applyAllowed: false
  }
  | {
    readonly status: 'needs_review'
    readonly candidates: readonly CharacterRecommendationCandidate[]
    readonly reason: string
    readonly uncertainties: readonly string[]
    readonly applyAllowed: false
  }
  | {
    readonly status: 'no_match'
    readonly reason: string
    readonly uncertainties: readonly string[]
    readonly applyAllowed: false
  }
