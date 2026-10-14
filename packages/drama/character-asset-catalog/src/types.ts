/** Distinct asset identities and evidence boundaries for character catalog candidates. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable logical source configured by the operator, independent of a TOS bucket or key. */
export type CharacterStorageSourceId = Branded<'character-storage-source-id'>
/** Original identity declared by one source metadata record. */
export type OriginalCharacterAssetId = Branded<'original-character-asset-id'>
/** Catalog identity derived from a stable source namespace and original ID. */
export type CatalogAssetId = Branded<'character-catalog-asset-id'>
/** Existing Phase 1 draft reference identity; absent from new flat metadata. */
export type Phase1ReferenceId = Branded<'phase1-reference-id'>
/** Project-scoped story character identity, never inferred by this package. */
export type ProjectCharacterId = Branded<'project-character-id'>
/** Project namespace required to interpret a character ID. */
export type ProjectId = Branded<'project-id'>
/** Supplier parent asset identity, distinct from the catalog and project identities. */
export type SupplierAssetId = Branded<'supplier-asset-id'>
/** Supplier material identity under a parent asset. */
export type SupplierMaterialId = Branded<'supplier-material-id'>
/** Supplier namespace required to interpret supplier asset and material IDs. */
export type SupplierProviderId = Branded<'supplier-provider-id'>
/** Supplier account namespace required to interpret supplier asset and material IDs. */
export type SupplierAccountId = Branded<'supplier-account-id'>

/** A future project association must carry its project scope explicitly. */
export interface ProjectCharacterLink {
  project_id: ProjectId
  character_id: ProjectCharacterId
  catalog_asset_id: CatalogAssetId
}

/** A future supplier association must carry provider and account scope explicitly. */
export interface SupplierMaterialLink {
  provider: SupplierProviderId
  provider_account_id: SupplierAccountId
  asset_id: SupplierAssetId
  material_id: SupplierMaterialId
  catalog_asset_id: CatalogAssetId
}

/** JSON data retained without rewriting the source metadata. */
export type CharacterMetadataJsonValue = null | boolean | number | string
  | CharacterMetadataJsonValue[] | { [key: string]: CharacterMetadataJsonValue }
/** A parsed JSON object with metadata keys preserved verbatim. */
export type CharacterMetadataJsonObject = { [key: string]: CharacterMetadataJsonValue }
/** Explicitly supported metadata layouts. */
export type MetadataFormat = 'phase1_v2' | 'legacy_aliases' | 'flat'
/** Classification of a raw metadata status claim; it is never an approval grant. */
export type MetadataStatusClass = 'pending_review' | 'approved_claim' | 'rejected_claim' | 'unknown'

/** One appearance label, with its actual metadata location rather than invented review evidence. */
export interface AppearanceClaim {
  value: string
  metadata_pointer: string
  source_record: CharacterMetadataJsonValue | null
}

/** A parsed candidate. It carries no authoritative approval or TOS access. */
export interface CharacterMetadataRecord {
  identity: {
    catalog_asset_id: CatalogAssetId
    original_asset_id: OriginalCharacterAssetId
    reference_id: Phase1ReferenceId | null
  }
  raw: {
    format: MetadataFormat
    metadata: CharacterMetadataJsonObject
    source: CharacterMetadataJsonValue
    status: string
    id_field: 'asset_id' | 'id' | 'both'
    file_field: 'file_name' | 'images[0].filename' | 'both'
  }
  adapted: {
    asset_id: OriginalCharacterAssetId
    file_name: string
    category: string | null
    setting: string | null
    art_style: string | null
    era: readonly string[] | null
    gender: string | null
    appearance: readonly AppearanceClaim[] | null
    metadata_status_class: MetadataStatusClass
  }
  derived: {
    storage_source_id: CharacterStorageSourceId
    metadata_key: string
    image_key: string
    declared_sha256: string | null
    declared_bytes: number | null
  }
  unknown: {
    metadata_fields: CharacterMetadataJsonObject
    tos_object_version: null
    authoritative_review: null
    rights_authorization: null
    reuse_scope: null
  }
  safety: {
    can_publish: false
    can_reuse: false
    can_bind: false
  }
}

/** A candidate whose image bytes were read and compared with any declared digest or size. */
export interface VerifiedCharacterAsset extends CharacterMetadataRecord {
  observed: {
    sha256: string
    bytes: number
  }
}

/** Caller-owned, read-only source. This package never lists, uploads, or alters objects. */
export interface CharacterObjectReader {
  read(source: CharacterStorageSourceId, key: string): Promise<Uint8Array>
}
