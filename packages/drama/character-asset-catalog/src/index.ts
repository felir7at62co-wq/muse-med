/** Read-only character asset metadata model and source-neutral adapter. */
export { CharacterCatalogError, loadCharacterAssets, parseCharacterMetadata } from './metadata.ts'
export type { CharacterCatalogErrorCode } from './metadata.ts'
export type {
  AppearanceClaim,
  CatalogAssetId,
  CharacterMetadataJsonObject,
  CharacterMetadataJsonValue,
  CharacterMetadataRecord,
  CharacterObjectReader,
  CharacterStorageSourceId,
  MetadataFormat,
  MetadataStatusClass,
  OriginalCharacterAssetId,
  Phase1ReferenceId,
  ProjectCharacterId,
  ProjectCharacterLink,
  ProjectId,
  SupplierAccountId,
  SupplierAssetId,
  SupplierMaterialId,
  SupplierMaterialLink,
  SupplierProviderId,
  VerifiedCharacterAsset,
} from './types.ts'
