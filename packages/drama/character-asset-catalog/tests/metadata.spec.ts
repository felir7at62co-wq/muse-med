import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CharacterCatalogError,
  loadCharacterAssets,
  parseCharacterMetadata,
} from '../src/index.ts'
import type { CharacterCatalogErrorCode, CharacterObjectReader } from '../src/index.ts'

const source = 'character-reference'
const flatKey = 'assets/reference/characters/stylized/urban/urban/char_urban_female_001/metadata.json'
const v2Key = 'assets/reference/characters/stylized/ancient/ancient/char_3d_0004/metadata.json'
const picture = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
const digest = createHash('sha256').update(picture).digest('hex')

function flat(): Record<string, unknown> {
  return {
    asset_id: 'char_urban_female_001',
    file_name: 'image.jpg',
    category: 'character',
    era: 'modern',
    style: 'anime_illustration',
    gender: 'female',
    appearance: ['black hair', 'white shirt'],
    source: 'owner supplied',
    status: 'pending_review',
  }
}

function v2(): Record<string, unknown> {
  return {
    schema_version: 2,
    id: 'char_3d_0004',
    images: [{ filename: 'old.jpg', sha256: digest, bytes: picture.byteLength }],
    source: { platform: 'fixture', rights_status: 'unconfirmed' },
    status: 'pending_review',
    style: 'ancient',
    era: [],
    gender: 'unknown',
    appearance: {
      descriptors: [{ value: 'long robe', source: { kind: 'fixture', record: 'local' } }],
    },
    review: { reuse_approved: false },
  }
}

function parse(metadata: Record<string, unknown>, key = flatKey) {
  return parseCharacterMetadata(JSON.stringify(metadata), source, key)
}

function code(action: () => unknown): CharacterCatalogErrorCode {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(CharacterCatalogError)
    return (error as CharacterCatalogError).code
  }
  throw new Error('Expected a catalog error')
}

function reader(objects: Record<string, Uint8Array>): CharacterObjectReader {
  return {
    read: async (_source, key) => {
      const value = objects[key]
      if (!value) throw new Error('Missing fixture object')
      return value
    },
  }
}

describe('character catalog metadata adaptation', () => {
  it('retains prototype-named unknown keys as own JSON data', () => {
    const json = JSON.stringify(flat()).slice(0, -1)
      + ',"__proto__":{"review_claim":"unconfirmed"},"constructor":"source constructor","prototype":{"id":"source prototype"}}'
    const item = parseCharacterMetadata(json, source, flatKey)
    const fields = item.unknown.metadata_fields
    expect(Object.hasOwn(fields, '__proto__')).toBe(true)
    expect(fields['__proto__']).toEqual({ review_claim: 'unconfirmed' })
    expect(Object.hasOwn(fields, 'constructor')).toBe(true)
    expect(fields['constructor']).toBe('source constructor')
    expect(Object.hasOwn(fields, 'prototype')).toBe(true)
    expect(fields['prototype']).toEqual({ id: 'source prototype' })
    expect(fields).not.toHaveProperty('review_claim')
    expect(JSON.parse(JSON.stringify(fields))).toEqual({
      ['__proto__']: { review_claim: 'unconfirmed' },
      constructor: 'source constructor',
      prototype: { id: 'source prototype' },
    })
    expect(item.safety).toEqual({ can_publish: false, can_reuse: false, can_bind: false })
  })

  it('does not expose unknown metadata values through an inherited prototype', () => {
    const json = JSON.stringify(flat()).slice(0, -1) + ',"__proto__":{"review_claim":"unconfirmed"}}'
    const item = parseCharacterMetadata(json, source, flatKey)
    expect(item.unknown.metadata_fields).not.toHaveProperty('review_claim')
    expect(item.unknown.authoritative_review).toBeNull()
    expect(item.safety).toEqual({ can_publish: false, can_reuse: false, can_bind: false })
  })

  it('accepts flat metadata without inventing a Phase 1 reference or authorization', () => {
    const input = flat()
    const before = JSON.stringify(input)
    const item = parse(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(item.identity).toEqual({
      catalog_asset_id: 'character:character-reference:char_urban_female_001',
      original_asset_id: 'char_urban_female_001',
      reference_id: null,
    })
    expect(item.raw).toMatchObject({
      format: 'flat',
      source: 'owner supplied',
      status: 'pending_review',
      id_field: 'asset_id',
      file_field: 'file_name',
    })
    expect(item.adapted).toMatchObject({
      asset_id: 'char_urban_female_001',
      file_name: 'image.jpg',
      category: 'character',
      setting: null,
      art_style: 'anime_illustration',
      era: ['modern'],
      gender: 'female',
      metadata_status_class: 'pending_review',
    })
    expect(item.adapted.appearance).toEqual([
      { value: 'black hair', metadata_pointer: '/appearance/0', source_record: null },
      { value: 'white shirt', metadata_pointer: '/appearance/1', source_record: null },
    ])
    expect(item.derived).toMatchObject({
      metadata_key: flatKey,
      image_key: 'assets/reference/characters/stylized/urban/urban/char_urban_female_001/image.jpg',
      declared_sha256: null,
      declared_bytes: null,
    })
    expect(item.unknown).toEqual({
      metadata_fields: {},
      tos_object_version: null,
      authoritative_review: null,
      rights_authorization: null,
      reuse_scope: null,
    })
    expect(item.safety).toEqual({ can_publish: false, can_reuse: false, can_bind: false })
  })

  it('accepts Phase 1 v2 without confusing its setting label with art style', () => {
    const item = parse(v2(), v2Key)
    expect(item.identity).toEqual({
      catalog_asset_id: 'character:character-reference:char_3d_0004',
      original_asset_id: 'char_3d_0004',
      reference_id: 'char_3d_0004',
    })
    expect(item.raw.source).toEqual({ platform: 'fixture', rights_status: 'unconfirmed' })
    expect(item.unknown.metadata_fields).toEqual({ review: { reuse_approved: false } })
    expect(item.raw.id_field).toBe('id')
    expect(item.raw.file_field).toBe('images[0].filename')
    expect(item.adapted).toMatchObject({
      asset_id: 'char_3d_0004',
      file_name: 'old.jpg',
      category: null,
      setting: 'ancient',
      art_style: null,
      era: [],
      gender: 'unknown',
    })
    expect(item.adapted.appearance).toEqual([{
      value: 'long robe',
      metadata_pointer: '/appearance/descriptors/0',
      source_record: { kind: 'fixture', record: 'local' },
    }])
    expect(item.derived).toMatchObject({
      image_key: 'assets/reference/characters/stylized/ancient/ancient/char_3d_0004/old.jpg',
      declared_sha256: digest,
      declared_bytes: picture.byteLength,
    })
  })

  it('accepts consistent old and new aliases in one v2 record', () => {
    const metadata = { ...v2(), asset_id: 'char_3d_0004', file_name: 'old.jpg' }
    const item = parse(metadata, v2Key)
    expect(item.raw.id_field).toBe('both')
    expect(item.raw.file_field).toBe('both')
    expect(item.identity.reference_id).toBe('char_3d_0004')
  })

  it('keeps unversioned legacy aliases distinct from confirmed Phase 1 v2 semantics', () => {
    const metadata = v2()
    delete metadata.schema_version
    const item = parse(metadata, v2Key)
    expect(item.raw.format).toBe('legacy_aliases')
    expect(item.identity.reference_id).toBeNull()
    expect(item.adapted.setting).toBeNull()
    expect(item.adapted.art_style).toBeNull()
    expect(item.raw.metadata.style).toBe('ancient')
  })

  it('keeps a flat record flat when it carries consistent legacy aliases', () => {
    const metadata = { ...flat(), id: 'char_urban_female_001', images: [{ filename: 'image.jpg' }] }
    const item = parse(metadata)
    expect(item.raw.format).toBe('flat')
    expect(item.raw.id_field).toBe('both')
    expect(item.raw.file_field).toBe('both')
    expect(item.adapted.art_style).toBe('anime_illustration')
    expect(item.identity.reference_id).toBeNull()
  })

  it('adapts an available old filename without creating the absent new field', () => {
    const metadata = flat()
    delete metadata.file_name
    metadata.images = [{ filename: 'image.jpg' }]
    const item = parse(metadata)
    expect(item.raw.format).toBe('flat')
    expect(item.raw.file_field).toBe('images[0].filename')
    expect(Object.hasOwn(item.raw.metadata, 'file_name')).toBe(false)
    expect(item.derived.image_key).toBe(flatKey.replace('metadata.json', 'image.jpg'))
  })

  it('rejects conflicting IDs and filenames instead of choosing one', () => {
    expect(code(() => parse({ ...v2(), asset_id: 'other' }, v2Key))).toBe('CONFLICTING_ID')
    expect(code(() => parse({ ...v2(), file_name: 'other.jpg' }, v2Key))).toBe('CONFLICTING_FILE_NAME')
  })

  it('rejects missing and malformed identity or image fields', () => {
    const noId = flat()
    delete noId.asset_id
    expect(code(() => parse(noId))).toBe('MISSING_ID')
    expect(code(() => parse({ ...flat(), asset_id: 'bad/id' }))).toBe('INVALID_ID')
    expect(code(() => parse({ ...flat(), id: null }))).toBe('INVALID_ID')
    const noFile = flat()
    delete noFile.file_name
    expect(code(() => parse(noFile))).toBe('MISSING_FILE_NAME')
    expect(code(() => parse({ ...flat(), file_name: '../escape.jpg' }))).toBe('INVALID_FILE_NAME')
    expect(code(() => parse({ ...flat(), file_name: 'C:drive.jpg' }))).toBe('INVALID_FILE_NAME')
    expect(code(() => parse({ ...flat(), images: [] }))).toBe('MISSING_FILE_NAME')
    expect(code(() => parse({ ...flat(), images: [{}] }))).toBe('MISSING_FILE_NAME')
    expect(code(() => parse({ ...flat(), images: [{ filename: 1 }] }))).toBe('INVALID_FILE_NAME')
    expect(code(() => parse({ ...v2(), images: [{ filename: 'old.jpg', sha256: 'wrong' }] }, v2Key)))
      .toBe('INVALID_DECLARED_IMAGE')
    expect(code(() => parse({ ...v2(), images: [{ filename: 'old.jpg', bytes: -1 }] }, v2Key)))
      .toBe('INVALID_DECLARED_IMAGE')
    expect(code(() => parse({ ...v2(), images: [{ filename: 'old.jpg', bytes: null }] }, v2Key)))
      .toBe('INVALID_DECLARED_IMAGE')
  })

  it('rejects invalid JSON, versions, source and status without fabricating replacements', () => {
    expect(code(() => parseCharacterMetadata('{', source, flatKey))).toBe('INVALID_METADATA_JSON')
    expect(code(() => parseCharacterMetadata('[]', source, flatKey))).toBe('INVALID_METADATA_JSON')
    expect(code(() => parse({ ...flat(), schema_version: 3 }))).toBe('UNSUPPORTED_METADATA_VERSION')
    expect(code(() => parse({ ...flat(), source: null }))).toBe('INVALID_SOURCE')
    expect(code(() => parse({ ...flat(), source: '' }))).toBe('INVALID_SOURCE')
    const noSource = flat()
    delete noSource.source
    expect(code(() => parse(noSource))).toBe('MISSING_SOURCE')
    const noStatus = flat()
    delete noStatus.status
    expect(code(() => parse(noStatus))).toBe('MISSING_STATUS')
    expect(code(() => parse({ ...flat(), status: '' }))).toBe('INVALID_STATUS')
    expect(code(() => parse({ ...flat(), schema_version: 2 }))).toBe('INVALID_FIELD')
  })

  it('keeps unknown status explicit and never turns metadata approval claims into authority', () => {
    expect(parse({ ...flat(), status: 'unexpected' }).adapted.metadata_status_class).toBe('unknown')
    const claimedApproved = parse({ ...flat(), status: 'approved' })
    expect(claimedApproved.raw.status).toBe('approved')
    expect(claimedApproved.adapted.metadata_status_class).toBe('approved_claim')
    expect(claimedApproved.unknown.authoritative_review).toBeNull()
    expect(claimedApproved.safety.can_reuse).toBe(false)
    expect(parse({ ...flat(), status: 'rejected' }).adapted.metadata_status_class).toBe('rejected_claim')
    const pending = parse({ ...v2(), review: { reuse_approved: true } }, v2Key)
    expect(pending.adapted.metadata_status_class).toBe('pending_review')
    expect(pending.safety.can_publish).toBe(false)
  })

  it('does not fill absent flat descriptive fields or grant reuse', () => {
    const minimal = {
      asset_id: 'char_minimal',
      file_name: 'image.jpg',
      source: 'fixture',
      status: 'pending_review',
    }
    const item = parse(minimal)
    expect(item.adapted).toMatchObject({
      category: null,
      setting: null,
      art_style: null,
      era: null,
      gender: null,
      appearance: null,
    })
    expect(item.raw.metadata).toEqual(minimal)
    expect(item.unknown.rights_authorization).toBeNull()
    expect(item.safety.can_reuse).toBe(false)
  })

  it('rejects malformed descriptive claims rather than dropping them', () => {
    expect(code(() => parse({ ...flat(), category: 1 }))).toBe('INVALID_FIELD')
    expect(parse({ ...flat(), era: [] }).adapted.era).toEqual([])
    expect(code(() => parse({ ...flat(), era: [''] }))).toBe('INVALID_FIELD')
    expect(code(() => parse({ ...flat(), appearance: ['valid', 1] }))).toBe('INVALID_FIELD')
    expect(code(() => parse({ ...v2(), appearance: { descriptors: [{}] } }, v2Key)))
      .toBe('INVALID_FIELD')
    expect(code(() => parse({ ...v2(), appearance: [] }, v2Key))).toBe('INVALID_FIELD')
    expect(parse({ ...v2(), appearance: { descriptors: [{ value: 'long robe' }] } }, v2Key)
      .adapted.appearance?.[0]?.source_record).toBeNull()
  })

  it('requires a configured source namespace and exact safe metadata key', () => {
    expect(code(() => parseCharacterMetadata(JSON.stringify(flat()), 'bad/source', flatKey)))
      .toBe('INVALID_SOURCE_ID')
    expect(code(() => parseCharacterMetadata(JSON.stringify(flat()), source, '../metadata.json')))
      .toBe('INVALID_METADATA_KEY')
    expect(code(() => parseCharacterMetadata(JSON.stringify(flat()), source, 'assets\\metadata.json')))
      .toBe('INVALID_METADATA_KEY')
    expect(code(() => parseCharacterMetadata(JSON.stringify(flat()), source, 'assets/index.json')))
      .toBe('INVALID_METADATA_KEY')
    expect(code(() => parseCharacterMetadata(JSON.stringify(flat()), source, 'C:metadata.json')))
      .toBe('INVALID_METADATA_KEY')
  })

  it('reads an explicit flat image and distinguishes observed digest from absent declaration', async () => {
    const metadata = flat()
    const imageKey = flatKey.replace('metadata.json', 'image.jpg')
    const assets = await loadCharacterAssets(source, [flatKey], reader({
      [flatKey]: Buffer.from(JSON.stringify(metadata)),
      [imageKey]: picture,
    }))
    expect(assets).toHaveLength(1)
    expect(assets[0]?.observed).toEqual({ sha256: digest, bytes: picture.byteLength })
    expect(assets[0]?.derived.declared_sha256).toBeNull()
    expect(assets[0]?.raw.metadata).toEqual(metadata)
  })

  it('reads and checks v2 declared size and hash', async () => {
    const imageKey = v2Key.replace('metadata.json', 'old.jpg')
    const assets = await loadCharacterAssets(source, [v2Key], reader({
      [v2Key]: Buffer.from(JSON.stringify(v2())),
      [imageKey]: picture,
    }))
    expect(assets[0]?.derived.declared_sha256).toBe(digest)
    expect(assets[0]?.observed.sha256).toBe(digest)
  })

  it('reports a genuinely missing image file', async () => {
    const missing = join(import.meta.dirname, 'fixtures', 'missing-image.jpg')
    await expect(loadCharacterAssets(source, [flatKey], {
      read: async (_source, key) => key === flatKey
        ? Buffer.from(JSON.stringify(flat()))
        : readFile(missing),
    })).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' })
  })

  it('rejects unavailable metadata, malformed UTF-8 and altered image bytes', async () => {
    await expect(loadCharacterAssets(source, [flatKey], reader({})))
      .rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' })
    await expect(loadCharacterAssets(source, [flatKey], reader({ [flatKey]: Uint8Array.of(0xff) })))
      .rejects.toMatchObject({ code: 'INVALID_METADATA_JSON' })
    const imageKey = v2Key.replace('metadata.json', 'old.jpg')
    await expect(loadCharacterAssets(source, [v2Key], reader({
      [v2Key]: Buffer.from(JSON.stringify(v2())),
      [imageKey]: Uint8Array.of(1, 2, 3),
    }))).rejects.toMatchObject({ code: 'IMAGE_MISMATCH' })
  })

  it('rejects duplicate original asset IDs within a source, including different object paths', async () => {
    const secondKey = 'assets/reference/characters/stylized/urban/urban/duplicate/metadata.json'
    const imageKey = flatKey.replace('metadata.json', 'image.jpg')
    await expect(loadCharacterAssets(source, [flatKey, secondKey], reader({
      [flatKey]: Buffer.from(JSON.stringify(flat())),
      [secondKey]: Buffer.from(JSON.stringify(flat())),
      [imageKey]: picture,
    }))).rejects.toMatchObject({ code: 'DUPLICATE_ASSET_ID', metadataKey: secondKey })
    expect(parseCharacterMetadata(JSON.stringify(flat()), 'other-source', flatKey).identity.catalog_asset_id)
      .not.toBe(parse(flat()).identity.catalog_asset_id)
  })
})
