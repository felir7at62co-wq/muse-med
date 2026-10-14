/** Strict, read-only adaptation and verification for character metadata objects. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
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
  VerifiedCharacterAsset,
} from './types.ts'

/** Machine-readable rejection for malformed or unavailable catalog input. */
export type CharacterCatalogErrorCode =
  | 'INVALID_SOURCE_ID'
  | 'INVALID_METADATA_KEY'
  | 'INVALID_METADATA_JSON'
  | 'UNSUPPORTED_METADATA_VERSION'
  | 'MISSING_ID'
  | 'INVALID_ID'
  | 'CONFLICTING_ID'
  | 'MISSING_FILE_NAME'
  | 'INVALID_FILE_NAME'
  | 'CONFLICTING_FILE_NAME'
  | 'MISSING_SOURCE'
  | 'INVALID_SOURCE'
  | 'MISSING_STATUS'
  | 'INVALID_STATUS'
  | 'INVALID_FIELD'
  | 'INVALID_DECLARED_IMAGE'
  | 'DUPLICATE_ASSET_ID'
  | 'METADATA_UNAVAILABLE'
  | 'IMAGE_UNAVAILABLE'
  | 'IMAGE_MISMATCH'

/** Failure code and source key without logging metadata contents or credentials. */
export class CharacterCatalogError extends Error {
  constructor(
    readonly code: CharacterCatalogErrorCode,
    readonly metadataKey: string | null = null,
  ) {
    super(code)
    this.name = 'CharacterCatalogError'
  }
}

const has = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const knownMetadataFields = new Set([
  'schema_version', 'asset_id', 'id', 'file_name', 'images', 'source', 'status',
  'category', 'style', 'era', 'gender', 'appearance',
])

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code: CharacterCatalogErrorCode, key: string | null = null): never {
  throw new CharacterCatalogError(code, key)
}

function sourceId(value: string): CharacterStorageSourceId {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) fail('INVALID_SOURCE_ID')
  return brandString<CharacterStorageSourceId>(value)
}

function metadataKey(value: string): string {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\u0000-\u001f\u007f?#:]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')
    || value.split('/').at(-1) !== 'metadata.json') fail('INVALID_METADATA_KEY')
  return value
}

function originalId(value: unknown): OriginalCharacterAssetId {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    fail('INVALID_ID')
  }
  return brandString<OriginalCharacterAssetId>(value)
}

function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || value === '.' || value === '..' || /[\/\\\u0000-\u001f\u007f:?*"<>\|]/.test(value)) {
    fail('INVALID_FILE_NAME')
  }
  return value
}

function optionalString(raw: Record<string, unknown>, name: string): string | null {
  if (!has(raw, name)) return null
  const value = raw[name]
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_FIELD')
  return value
}

function era(raw: Record<string, unknown>): readonly string[] | null {
  if (!has(raw, 'era')) return null
  const value = raw.era
  if (typeof value === 'string' && value.trim()) return [value]
  if (Array.isArray(value) && value.every(item => typeof item === 'string' && !!item.trim())) {
    return value as string[]
  }
  return fail('INVALID_FIELD')
}

function appearance(raw: Record<string, unknown>, format: MetadataFormat): readonly AppearanceClaim[] | null {
  if (!has(raw, 'appearance')) return null
  const value = raw.appearance
  if (format === 'flat') {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && !!item.trim())) {
      fail('INVALID_FIELD')
    }
    return (value as string[]).map((item, index) => ({
      value: item,
      metadata_pointer: '/appearance/' + String(index),
      source_record: null,
    }))
  }
  if (!object(value) || !Array.isArray(value.descriptors)) fail('INVALID_FIELD')
  return value.descriptors.map((item: unknown, index: number) => {
    if (!object(item) || typeof item.value !== 'string' || !item.value.trim()) fail('INVALID_FIELD')
    return {
      value: item.value,
      metadata_pointer: '/appearance/descriptors/' + String(index),
      source_record: has(item, 'source') ? item.source as CharacterMetadataJsonValue : null,
    }
  })
}

function declaredImage(image: Record<string, unknown> | null): {
  sha256: string | null
  bytes: number | null
} {
  if (!image) return { sha256: null, bytes: null }
  const hasSha256 = has(image, 'sha256')
  const hasBytes = has(image, 'bytes')
  const sha256 = hasSha256 ? image.sha256 : null
  const bytes = hasBytes ? image.bytes : null
  if (hasSha256 && (typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256))) {
    fail('INVALID_DECLARED_IMAGE')
  }
  if (hasBytes && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)) {
    fail('INVALID_DECLARED_IMAGE')
  }
  return { sha256: sha256 as string | null, bytes: bytes as number | null }
}

function statusClass(status: string): MetadataStatusClass {
  if (status === 'pending_review') return 'pending_review'
  if (status === 'approved') return 'approved_claim'
  if (status === 'rejected') return 'rejected_claim'
  return 'unknown'
}

/** Parse one JSON metadata object using only the configured source identity and exact object key.
 * @param json - Raw JSON text read by the caller; it is never rewritten.
 * @param source - Operator-owned stable namespace, not a bucket or request parameter from an Agent.
 * @param key - Exact metadata object key, including its real directory levels.
 * @returns A read-only candidate with own-property metadata keys, separate source claims, derived keys and unknown authority.
 */
export function parseCharacterMetadata(
  json: string,
  source: string,
  key: string,
): CharacterMetadataRecord {
  const storageId = sourceId(source)
  const safeKey = metadataKey(key)
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    fail('INVALID_METADATA_JSON', safeKey)
  }
  if (!object(raw)) fail('INVALID_METADATA_JSON', safeKey)
  if (has(raw, 'schema_version') && raw.schema_version !== 2) {
    fail('UNSUPPORTED_METADATA_VERSION', safeKey)
  }
  const hasAssetId = has(raw, 'asset_id')
  const hasId = has(raw, 'id')
  const hasFlatName = has(raw, 'file_name')
  const format: MetadataFormat = raw.schema_version === 2 ? 'phase1_v2'
    : hasAssetId || hasFlatName ? 'flat' : 'legacy_aliases'
  const newId = hasAssetId ? originalId(raw.asset_id) : null
  const oldId = hasId ? originalId(raw.id) : null
  if (newId !== null && oldId !== null && newId !== oldId) fail('CONFLICTING_ID', safeKey)
  const id = newId ?? oldId
  if (id === null) fail('MISSING_ID', safeKey)

  const flatName = hasFlatName ? fileName(raw.file_name) : null
  let image: Record<string, unknown> | null = null
  let oldName: string | null = null
  if (has(raw, 'images')) {
    if (!Array.isArray(raw.images) || !object(raw.images[0])) fail('MISSING_FILE_NAME', safeKey)
    image = raw.images[0]
    if (!has(image, 'filename')) fail('MISSING_FILE_NAME', safeKey)
    oldName = fileName(image.filename)
  }
  if (flatName !== null && oldName !== null && flatName !== oldName) {
    fail('CONFLICTING_FILE_NAME', safeKey)
  }
  const selectedName = flatName ?? oldName
  if (selectedName === null) fail('MISSING_FILE_NAME', safeKey)
  if (format === 'phase1_v2' && (oldId === null || oldName === null)) fail('INVALID_FIELD', safeKey)

  if (!has(raw, 'source')) fail('MISSING_SOURCE', safeKey)
  if ((typeof raw.source !== 'string' || !raw.source.trim()) && !object(raw.source)) {
    fail('INVALID_SOURCE', safeKey)
  }
  if (!has(raw, 'status')) fail('MISSING_STATUS', safeKey)
  if (typeof raw.status !== 'string' || !raw.status.trim()) fail('INVALID_STATUS', safeKey)

  const style = optionalString(raw, 'style')
  const declared = declaredImage(image)
  const directory = safeKey.slice(0, safeKey.length - 'metadata.json'.length)
  const catalogId = brandString<CatalogAssetId>('character:' + storageId + ':' + id)
  const referenceId = format === 'phase1_v2' ? brandString<Phase1ReferenceId>(oldId as string) : null
  const rawMetadata = raw as CharacterMetadataJsonObject
  const unknownMetadataFields: CharacterMetadataJsonObject = Object.fromEntries(
    Object.entries(rawMetadata).filter(([name]) => !knownMetadataFields.has(name)),
  )
  return {
    identity: {
      catalog_asset_id: catalogId,
      original_asset_id: id,
      reference_id: referenceId,
    },
    raw: {
      format,
      metadata: rawMetadata,
      source: raw.source as CharacterMetadataJsonValue,
      status: raw.status,
      id_field: hasAssetId && hasId ? 'both' : hasAssetId ? 'asset_id' : 'id',
      file_field: hasFlatName && oldName !== null ? 'both' : hasFlatName ? 'file_name' : 'images[0].filename',
    },
    adapted: {
      asset_id: id,
      file_name: selectedName,
      category: optionalString(raw, 'category'),
      setting: format === 'phase1_v2' ? style : null,
      art_style: format === 'flat' ? style : null,
      era: era(raw),
      gender: optionalString(raw, 'gender'),
      appearance: appearance(raw, format),
      metadata_status_class: statusClass(raw.status),
    },
    derived: {
      storage_source_id: storageId,
      metadata_key: safeKey,
      image_key: directory + selectedName,
      declared_sha256: declared.sha256,
      declared_bytes: declared.bytes,
    },
    unknown: {
      metadata_fields: unknownMetadataFields,
      tos_object_version: null,
      authoritative_review: null,
      rights_authorization: null,
      reuse_scope: null,
    },
    safety: {
      can_publish: false,
      can_reuse: false,
      can_bind: false,
    },
  }
}

/** Read exact metadata keys and image bytes without listing or mutating the source.
 * @param source - Operator-owned source namespace.
 * @param metadataKeys - Explicit metadata object keys; discovery belongs to a later source adapter.
 * @param reader - Read-only object access supplied by the caller.
 * @returns Complete verified records, or throws without publishing a partial result.
 */
export async function loadCharacterAssets(
  source: string,
  metadataKeys: readonly string[],
  reader: CharacterObjectReader,
): Promise<readonly VerifiedCharacterAsset[]> {
  const storageId = sourceId(source)
  const seen = new Set<CatalogAssetId>()
  const result: VerifiedCharacterAsset[] = []
  for (const key of metadataKeys) {
    const safeKey = metadataKey(key)
    let metadataBytes: Uint8Array
    try {
      metadataBytes = await reader.read(storageId, safeKey)
    } catch {
      fail('METADATA_UNAVAILABLE', safeKey)
    }
    let json: string
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)
    } catch {
      fail('INVALID_METADATA_JSON', safeKey)
    }
    const item = parseCharacterMetadata(json, source, safeKey)
    if (seen.has(item.identity.catalog_asset_id)) fail('DUPLICATE_ASSET_ID', safeKey)
    seen.add(item.identity.catalog_asset_id)
    let imageBytes: Uint8Array
    try {
      imageBytes = await reader.read(storageId, item.derived.image_key)
    } catch {
      fail('IMAGE_UNAVAILABLE', safeKey)
    }
    const observed = {
      sha256: createHash('sha256').update(imageBytes).digest('hex'),
      bytes: imageBytes.byteLength,
    }
    if (item.derived.declared_bytes !== null && item.derived.declared_bytes !== observed.bytes
      || item.derived.declared_sha256 !== null
        && item.derived.declared_sha256.toLowerCase() !== observed.sha256) {
      fail('IMAGE_MISMATCH', safeKey)
    }
    result.push({ ...item, observed })
  }
  return result
}
