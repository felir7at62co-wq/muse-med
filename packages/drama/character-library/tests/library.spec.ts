import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import CharacterLibrary, { ANCIENT_PREFIX, CHARACTER_LIBRARY_SOURCE_ID, CharacterLibraryError, CharacterLibraryObjectStore, CharacterLibraryStoreError, URBAN_PREFIX } from '../src/index.ts'
import type { CharacterLibraryObjectGet, CharacterLibraryObjectHead, CharacterLibraryObjectListPage, CharacterLibraryObjectListRequest } from '../src/index.ts'
import { assertSafeKey, boundedList, boundedText, detectDecodableImage, detectImage, metadataCandidate } from '../src/validation.ts'

const structuralJpeg = Uint8Array.of(
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x00, 0xff, 0xd9,
)
const jpeg = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOALqGf//Z',
  'base64',
)
const jpegChanged = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCnABE/v//Z',
  'base64',
)
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z1D/HwAF/gJ+fM5MPgAAAABJRU5ErkJggg==',
  'base64',
)
const structuralPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
  'base64',
)
const structuralWebp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([18, 0, 0, 0]),
  Buffer.from('WEBPVP8L'),
  Buffer.from([6, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0]),
])
const webp = Buffer.from('UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAAAcQ/e9f/wMR0f8A', 'base64')

function little32(value: number): Buffer {
  return Buffer.from([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ])
}

function webpChunk(name: string, body: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(name),
    little32(body.byteLength),
    Buffer.from(body),
    ...body.byteLength % 2 === 0 ? [] : [Buffer.from([0])],
  ])
}

function webpFile(...chunks: readonly Uint8Array[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks.map(chunk => Buffer.from(chunk))])
  return Buffer.concat([Buffer.from('RIFF'), little32(body.byteLength), body])
}

function vp8Body(width: number, height: number): Buffer {
  return Buffer.from([
    0, 0, 0, 0x9d, 0x01, 0x2a,
    width & 0xff, (width >> 8) & 0x3f,
    height & 0xff, (height >> 8) & 0x3f,
    0,
  ])
}

function vp8xBody(width: number, height: number): Buffer {
  const encodedWidth = width - 1
  const encodedHeight = height - 1
  return Buffer.from([
    0, 0, 0, 0,
    encodedWidth & 0xff, (encodedWidth >> 8) & 0xff, (encodedWidth >> 16) & 0xff,
    encodedHeight & 0xff, (encodedHeight >> 8) & 0xff, (encodedHeight >> 16) & 0xff,
  ])
}
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

interface Stored {
  data: Uint8Array
  contentType: string
  etag: string
}

class FakeStore extends CharacterLibraryObjectStore {
  readonly objects = new Map<string, Stored>()
  readonly calls: string[] = []
  listCalls = 0
  readConfigured = true
  writeConfigured = true
  statusError = false

  status() {
    if (this.statusError) throw new Error('synthetic status failure')
    return { readConfigured: this.readConfigured, writeConfigured: this.writeConfigured }
  }

  seed(key: string, data: Uint8Array, contentType = 'application/octet-stream'): void {
    this.objects.set(key, { data: data.slice(), contentType, etag: sha(data) })
  }

  seedJson(key: string, value: unknown): void {
    this.seed(key, Buffer.from(JSON.stringify(value)), 'application/json')
  }

  async list(request: CharacterLibraryObjectListRequest): Promise<CharacterLibraryObjectListPage> {
    this.calls.push('list:' + request.prefix)
    this.listCalls++
    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(request.prefix))
      .sort(([left], [right]) => left.localeCompare(right))
    const offset = request.cursor === undefined ? 0 : Number(request.cursor)
    const selected = all.slice(offset, offset + request.limit)
    const next = offset + selected.length
    return {
      objects: selected.map(([key, value]) => ({
        key,
        bytes: value.data.byteLength,
        etag: value.etag,
      })),
      nextCursor: next < all.length ? String(next) : null,
    }
  }

  async head(key: string): Promise<CharacterLibraryObjectHead | null> {
    this.calls.push('head:' + key)
    const value = this.objects.get(key)
    return value === undefined ? null : {
      key,
      bytes: value.data.byteLength,
      etag: value.etag,
      contentType: value.contentType,
    }
  }

  async get(key: string, maxBytes: number): Promise<CharacterLibraryObjectGet> {
    this.calls.push('get:' + key)
    const value = this.objects.get(key)
    if (value === undefined) throw new CharacterLibraryStoreError('NOT_FOUND')
    if (value.data.byteLength > maxBytes) throw new CharacterLibraryStoreError('OBJECT_TOO_LARGE')
    return {
      key,
      data: value.data.slice(),
      bytes: value.data.byteLength,
      etag: value.etag,
      contentType: value.contentType,
    }
  }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const store = new FakeStore(ctx)
  const library = new CharacterLibrary(ctx)
  return { ctx, store, library }
}

function v2(
  id: string,
  image: Uint8Array,
  options: {
    collection?: 'ancient' | 'urban'
    status?: string
    era?: readonly string[]
    gender?: string
    style?: string
    tags?: readonly string[]
    appearance?: readonly string[]
  } = {},
) {
  const collection = options.collection ?? 'urban'
  const prefix = collection === 'ancient' ? ANCIENT_PREFIX : URBAN_PREFIX
  const metadataKey = prefix + id + '/metadata.json'
  const imageKey = prefix + id + '/portrait.jpg'
  return {
    metadataKey,
    imageKey,
    metadata: {
      schema_version: 2,
      id,
      images: [{ filename: 'portrait.jpg', sha256: sha(image), bytes: image.byteLength }],
      source: { platform: 'synthetic-test', rights_status: 'unconfirmed' },
      status: options.status ?? 'pending_review',
      category: 'character',
      style: options.style ?? (collection === 'ancient' ? '古装' : '现代甜美'),
      era: options.era ?? (collection === 'ancient' ? ['古代'] : ['现代']),
      gender: options.gender ?? 'female',
      appearance: {
        descriptors: (options.appearance ?? ['温柔']).map(value => ({
          value,
          source: { kind: 'synthetic-test' },
        })),
      },
      tags: options.tags ?? ['少女感'],
    },
  }
}

function seed(store: FakeStore, fixture: ReturnType<typeof v2>, image: Uint8Array = jpeg): void {
  store.seedJson(fixture.metadataKey, fixture.metadata)
  store.seed(fixture.imageKey, image, 'image/jpeg')
}

function expectLibraryError(
  promise: Promise<unknown>,
  code: CharacterLibraryError['code'],
  stage?: CharacterLibraryError['stage'],
) {
  return expect(promise).rejects.toMatchObject({
    name: 'CharacterLibraryError',
    code,
    ...(stage === undefined ? {} : { stage }),
  })
}

describe('read-only character library', () => {
  it('reports a mounted read-only boundary without touching storage', () => {
    const { store, library } = setup()
    expect(library.status()).toEqual({
      configured: true,
      sourceId: CHARACTER_LIBRARY_SOURCE_ID,
      readOnly: true,
      uploadPending: 'unavailable',
    })
    expect(store.calls).toEqual([])
    store.readConfigured = false
    expect(library.status()).toMatchObject({ configured: false, uploadPending: 'unavailable' })
    expect(store.calls).toEqual([])
    store.writeConfigured = false
    expect(library.status()).toMatchObject({ configured: false, uploadPending: 'unavailable' })
    store.statusError = true
    expect(library.status()).toMatchObject({ configured: false })
  })

  it('fails closed before object IO when the read provider is unconfigured', async () => {
    const { store, library } = setup()
    store.readConfigured = false
    await expectLibraryError(library.browse(), 'UNCONFIGURED', 'browse')
    await expectLibraryError(library.detail({
      catalogAssetId: 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':missing',
    }), 'UNCONFIGURED', 'detail')
    expect(store.calls).toEqual([])
  })

  it('does not trust non-boolean provider readiness values', async () => {
    const { store, library } = setup()
    store.status = () => ({ readConfigured: 'yes', writeConfigured: 1 }) as never
    expect(library.status()).toMatchObject({ configured: false, uploadPending: 'unavailable' })
    await expectLibraryError(library.browse(), 'UNCONFIGURED', 'browse')
    expect(store.calls).toEqual([])
  })

  it('browses only fixed prefixes, ignores folder markers and supports filtering and cursors', async () => {
    const { store, library } = setup()
    const sweet = v2('sweet', jpeg, { tags: ['少女感', '温柔'] })
    const ancient = v2('ancient', jpeg, {
      collection: 'ancient',
      gender: 'male',
      tags: ['冷峻'],
      appearance: ['长袍'],
    })
    seed(store, sweet)
    seed(store, ancient)
    store.seed(URBAN_PREFIX, new Uint8Array())
    store.seed(URBAN_PREFIX + 'sweet/', new Uint8Array())
    store.seed(URBAN_PREFIX + 'sweet/readme.txt', Buffer.from('ignored'))
    const first = await library.browse({ query: '少女感', limit: 1 })
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]).toMatchObject({
      collection: 'urban',
      metadataStatus: 'pending_review',
      safety: { canPublish: false, canReuse: false, canBind: false, applyAllowed: false },
    })
    expect(first.nextCursor).toBeNull()
    const allFirst = await library.browse({ limit: 1 })
    expect(allFirst.entries).toHaveLength(1)
    expect(allFirst.nextCursor).toMatch(/^v1:1:/)
    const allSecond = await library.browse({ limit: 1, cursor: allFirst.nextCursor! })
    expect(allSecond.entries).toHaveLength(1)
    expect(allSecond.nextCursor).toBeNull()
    expect(store.calls.filter(call => call.startsWith('list:'))).toContain('list:' + ANCIENT_PREFIX)
    expect(store.calls.filter(call => call.startsWith('list:'))).toContain('list:' + URBAN_PREFIX)
  })

  it('sanitizes untrusted tags and projects absent optional claims as empty lists', async () => {
    const { store, library } = setup()
    const absent = v2('absent-claims', jpeg)
    delete (absent.metadata as { era?: readonly string[] }).era
    delete (absent.metadata as { appearance?: unknown }).appearance
    delete (absent.metadata as { tags?: readonly string[] }).tags
    seed(store, absent)
    const invalid = v2('invalid-tags', jpeg, { tags: ['bad\u0000tag'] })
    seed(store, invalid)
    const excessive = v2('excessive-tags', jpeg, {
      tags: Array.from({ length: 33 }, (_, index) => `tag-${String(index)}`),
    })
    seed(store, excessive)
    const result = await library.browse({ collection: 'urban' })
    expect(result.entries.map(entry => ({
      id: String(entry.catalogAssetId).split(':').at(-1),
      era: entry.era,
      appearance: entry.appearance,
      tags: entry.tags,
    }))).toEqual([
      { id: 'absent-claims', era: [], appearance: [], tags: [] },
      { id: 'excessive-tags', era: ['现代'], appearance: ['温柔'], tags: [] },
      { id: 'invalid-tags', era: ['现代'], appearance: ['温柔'], tags: [] },
    ])
  })

  it('filters by claimed status without treating the claim as approval', async () => {
    const { store, library } = setup()
    seed(store, v2('pending', jpeg))
    seed(store, v2('rejected', jpeg, { status: 'rejected' }))
    const result = await library.browse({
      collection: 'urban', metadataStatus: 'pending_review',
    })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ metadataStatus: 'pending_review' })
  })

  it('rejects invalid browse requests and provider keys outside the requested prefix', async () => {
    expect.assertions(4)
    const { store, library } = setup()
    await expectLibraryError(library.browse({ limit: 0 }), 'INVALID_REQUEST', 'browse')
    await expectLibraryError(library.browse({ query: 'x'.repeat(201) }), 'INVALID_REQUEST', 'browse')
    await expectLibraryError(library.browse({ cursor: 'not-a-cursor' }), 'INVALID_REQUEST', 'browse')
    store.list = async request => ({
      objects: [{ key: request.prefix === URBAN_PREFIX
        ? ANCIENT_PREFIX + 'escape/metadata.json'
        : URBAN_PREFIX + 'escape/metadata.json', bytes: 1, etag: null }],
      nextCursor: null,
    })
    await expectLibraryError(library.browse(), 'LIST_FAILED', 'browse')
  })

  it('rejects repeated and unbounded listing cursors', async () => {
    expect.assertions(2)
    const { store, library } = setup()
    store.list = async () => ({ objects: [], nextCursor: 'same' })
    await expectLibraryError(library.browse({ collection: 'urban' }), 'LIST_FAILED', 'browse')
    let page = 0
    store.list = async () => ({ objects: [], nextCursor: String(++page) })
    await expectLibraryError(library.browse({ collection: 'urban' }), 'LIST_BOUND_EXCEEDED', 'browse')
  })

  it('rejects malformed listing pages and oversized metadata before reads', async () => {
    const malformed: unknown[] = [
      null,
      { objects: null, nextCursor: null },
      { objects: [], nextCursor: '' },
      { objects: [], nextCursor: 'x'.repeat(513) },
      { objects: [], nextCursor: 'bad\u0000cursor' },
      { objects: [null], nextCursor: null },
      { objects: [{ key: URBAN_PREFIX + 'x/metadata.json', bytes: -1, etag: null }], nextCursor: null },
      { objects: [{ key: URBAN_PREFIX + 'x/metadata.json', bytes: 1, etag: 1 }], nextCursor: null },
      { objects: [{ key: URBAN_PREFIX + 'x/metadata.json', bytes: 256 * 1024 + 1, etag: null }], nextCursor: null },
    ]
    for (const page of malformed) {
      const { store, library } = setup()
      store.list = async () => page as CharacterLibraryObjectListPage
      await expect(library.browse({ collection: 'urban' })).rejects.toBeInstanceOf(CharacterLibraryError)
    }
    const { store, library } = setup()
    store.list = async request => ({
      objects: Array.from({ length: request.limit + 1 }, (_, index) => ({
        key: `${URBAN_PREFIX}x${String(index)}/metadata.json`, bytes: 1, etag: null,
      })),
      nextCursor: null,
    })
    await expect(library.browse({ collection: 'urban' })).rejects.toMatchObject({ code: 'LIST_FAILED' })
  })

  it('wraps provider listing and metadata read failures without leaking them', async () => {
    const listed = setup()
    listed.store.list = async () => { throw new Error('secret provider detail') }
    await expect(listed.library.browse({ collection: 'urban' })).rejects.toMatchObject({
      code: 'LIST_FAILED', stage: 'browse', message: 'LIST_FAILED',
    })

    const read = setup()
    const fixture = v2('read-failure', jpeg)
    seed(read.store, fixture)
    read.store.get = async () => { throw new CharacterLibraryStoreError('READ_FAILED') }
    await expect(read.library.browse({ collection: 'urban' })).rejects.toMatchObject({
      code: 'LIST_FAILED', stage: 'browse', message: 'LIST_FAILED',
    })
  })

  it('rejects malformed metadata reads, invalid UTF-8 and invalid JSON', async () => {
    const fixture = v2('invalid-get', jpeg)
    const malformedGets: unknown[] = [
      null,
      { key: 'wrong', data: new Uint8Array(), bytes: 0, etag: null, contentType: null },
      { key: fixture.metadataKey, data: 'not-bytes', bytes: 9, etag: null, contentType: null },
      { key: fixture.metadataKey, data: new Uint8Array(), bytes: 1, etag: null, contentType: null },
      { key: fixture.metadataKey, data: new Uint8Array(), bytes: 0, etag: 1, contentType: null },
      { key: fixture.metadataKey, data: new Uint8Array(), bytes: 0, etag: null, contentType: 1 },
    ]
    for (const response of malformedGets) {
      const { store, library } = setup()
      seed(store, fixture)
      store.get = async () => response as CharacterLibraryObjectGet
      await expect(library.browse({ collection: 'urban' })).rejects.toMatchObject({
        code: 'PREVIEW_UNAVAILABLE', stage: 'browse',
      })
    }
    const badUtf8 = setup()
    badUtf8.store.seed(fixture.metadataKey, Uint8Array.of(0xff), 'application/json')
    await expect(badUtf8.library.browse({ collection: 'urban' })).rejects.toMatchObject({
      code: 'CATALOG_REJECTED',
    })
    const badJson = setup()
    badJson.store.seed(fixture.metadataKey, Buffer.from('{'), 'application/json')
    await expect(badJson.library.browse({ collection: 'urban' })).rejects.toMatchObject({
      code: 'CATALOG_REJECTED',
    })
  })

  it('deduplicates repeated keys and rejects duplicate catalog identities', async () => {
    const repeated = setup()
    const one = v2('repeat', jpeg)
    seed(repeated.store, one)
    let page = 0
    repeated.store.list = async () => ({
      objects: [{ key: one.metadataKey, bytes: 10, etag: null }],
      nextCursor: page++ === 0 ? 'next' : null,
    })
    await expect(repeated.library.browse({ collection: 'urban' })).resolves.toMatchObject({ scanned: 1 })

    const duplicate = setup()
    const left = v2('same', jpeg)
    const right = v2('other-key', jpeg)
    seed(duplicate.store, left)
    duplicate.store.seedJson(right.metadataKey, { ...right.metadata, id: 'same' })
    await expect(duplicate.library.browse({ collection: 'urban' })).rejects.toMatchObject({
      code: 'CATALOG_REJECTED',
    })
  })

  it('loads detail and rejects invalid or missing catalog identities', async () => {
    const { store, library } = setup()
    const fixture = v2('detail', jpeg)
    seed(store, fixture)
    const entry = await library.detail({
      catalogAssetId: 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':detail',
    })
    expect(entry.metadataKey).toBe(fixture.metadataKey)
    await expectLibraryError(library.detail({ catalogAssetId: 'other:detail' }), 'INVALID_REQUEST', 'detail')
    await expectLibraryError(library.detail({
      catalogAssetId: 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':missing',
    }), 'ASSET_NOT_FOUND', 'detail')
  })

  it('returns a bounded verified image preview and copies its bytes', async () => {
    const { store, library } = setup()
    const fixture = v2('preview', jpeg)
    seed(store, fixture)
    const result = await library.preview({
      catalogAssetId: 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':preview',
    })
    expect(result).toMatchObject({
      contentType: 'image/jpeg',
      bytes: jpeg.byteLength,
      sha256: sha(jpeg),
      metadataStatus: 'pending_review',
      safety: { applyAllowed: false },
    })
    result.data[0] = 0
    expect(store.objects.get(fixture.imageKey)?.data[0]).toBe(0xff)
    await expectLibraryError(library.preview({
      catalogAssetId: result.catalogAssetId,
      maxBytes: 2,
    }), 'PREVIEW_UNAVAILABLE', 'preview')
    await expectLibraryError(library.preview({
      catalogAssetId: result.catalogAssetId,
      maxBytes: 0,
    }), 'INVALID_REQUEST', 'preview')
  })

  it('rejects altered, non-image and content-type-conflicting previews', async () => {
    expect.assertions(3)
    const mismatch = setup()
    const fixture = v2('mismatch', jpeg)
    seed(mismatch.store, fixture)
    mismatch.store.seed(fixture.imageKey, png, 'image/png')
    await expectLibraryError(mismatch.library.preview({
      catalogAssetId: 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':mismatch',
    }), 'IMAGE_MISMATCH', 'preview')

    const invalid = setup()
    const bad = v2('bad', Uint8Array.of(1, 2, 3, 4))
    seed(invalid.store, bad, Uint8Array.of(1, 2, 3, 4))
    await expectLibraryError(invalid.library.preview({
      catalogAssetId: 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':bad',
    }), 'IMAGE_INVALID', 'preview')

    const wrongType = setup()
    const typed = v2('typed', jpeg)
    seed(wrongType.store, typed)
    wrongType.store.objects.get(typed.imageKey)!.contentType = 'image/png'
    await expectLibraryError(wrongType.library.preview({
      catalogAssetId: 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':typed',
    }), 'IMAGE_INVALID', 'preview')
  })

  it('preserves domain read errors raised while the catalog loads preview bytes', async () => {
    const { store, library } = setup()
    const fixture = v2('invalid-image-read', jpeg)
    seed(store, fixture)
    const originalGet = store.get.bind(store)
    store.get = async (key, maxBytes) => key === fixture.imageKey
      ? { key, data: new Uint8Array(), bytes: 1, etag: null, contentType: null }
      : originalGet(key, maxBytes)
    await expect(library.preview({
      catalogAssetId: 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':invalid-image-read',
    })).rejects.toMatchObject({ code: 'PREVIEW_UNAVAILABLE', stage: 'preview' })
  })

  it('rejects metadata identity, key and original-image changes between listing and preview', async () => {
    for (const change of ['id', 'image_key', 'metadata_claim'] as const) {
      const { store, library } = setup()
      const fixture = v2('stable', jpeg)
      seed(store, fixture)
      const originalGet = store.get.bind(store)
      let metadataReads = 0
      store.get = async (key, maxBytes) => {
        if (key === fixture.metadataKey && ++metadataReads === 2) {
          const metadata = structuredClone(fixture.metadata)
          if (change === 'id') metadata.id = 'different'
          if (change === 'image_key') metadata.images[0]!.filename = 'different.jpg'
          if (change === 'metadata_claim') metadata.status = 'approved'
          store.seedJson(fixture.metadataKey, metadata)
        }
        return originalGet(key, maxBytes)
      }
      await expectLibraryError(library.preview({
        catalogAssetId: `character:${CHARACTER_LIBRARY_SOURCE_ID}:stable`,
      }), 'IMAGE_MISMATCH', 'preview')
    }
  })

  it('rejects an invalid expected digest and a changed verified original image', async () => {
    const { store, library } = setup()
    const fixture = v2('digest', jpeg, { status: 'pending_review' })
    seed(store, fixture)
    const catalogAssetId = `character:${CHARACTER_LIBRARY_SOURCE_ID}:digest`
    await expectLibraryError(library.preview({ catalogAssetId, expectedSha256: 'not-a-digest' }),
      'INVALID_REQUEST', 'preview')
    expect((await library.preview({ catalogAssetId, expectedSha256: sha(jpeg) })).sha256).toBe(sha(jpeg))
    const changed = v2('digest', jpegChanged, { status: 'pending_review' })
    seed(store, changed, jpegChanged)
    await expectLibraryError(library.preview({ catalogAssetId, expectedSha256: sha(jpeg) }),
      'IMAGE_MISMATCH', 'preview')
    expect((await library.preview({ catalogAssetId, expectedSha256: sha(jpegChanged) })).sha256)
      .toBe(sha(jpegChanged))
  })
})

describe('recommendation policy', () => {
  it('returns at most three distinct verified images without promoting pending-review candidates', async () => {
    const { store, library } = setup()
    store.writeConfigured = false
    for (const id of ['e', 'b', 'd', 'a', 'c']) {
      seed(store, v2(id, jpeg, { tags: ['温柔'], status: 'pending_review' }))
    }
    const result = await library.matchCandidates({ roleClass: 'lead', traitTerms: ['温柔'] })
    expect(result.status).toBe('candidates')
    if (result.status !== 'candidates') throw new Error('unexpected result')
    expect(result.candidates.map(candidate => String(candidate.entry.catalogAssetId).split(':').at(-1)))
      .toEqual(['a', 'b', 'c'])
    expect(result.candidates.map(candidate => candidate.imageSha256)).toEqual([sha(jpeg), sha(jpeg), sha(jpeg)])
    expect(result.uncertainties).toContain('candidate_limit_reached')
    expect(result.candidates.map(candidate => candidate.entry.metadataStatus))
      .toEqual(['pending_review', 'pending_review', 'pending_review'])
    expect(result.candidates.map(candidate => candidate.entry.safety))
      .toEqual([expect.objectContaining({ canBind: false, applyAllowed: false }),
        expect.objectContaining({ canBind: false, applyAllowed: false }),
        expect.objectContaining({ canBind: false, applyAllowed: false })])
    expect(result.applyAllowed).toBe(false)
    expect(store.calls.some(call => call.startsWith('ingest:'))).toBe(false)
    expect(store.calls.filter(call => call.endsWith('/portrait.jpg'))).toHaveLength(3)
  })

  it('fails closed when a ranked candidate image is corrupt', async () => {
    const { store, library } = setup()
    seed(store, v2('corrupt', structuralJpeg, { tags: ['温柔'] }), structuralJpeg)
    await expectLibraryError(library.matchCandidates({ roleClass: 'lead', traitTerms: ['温柔'] }),
      'IMAGE_INVALID', 'preview')
  })

  it('ranks stronger metadata matches first and retains a bounded supporting-role exception', async () => {
    const { store, library } = setup()
    seed(store, v2('weak', jpeg, { tags: ['温柔'] }))
    seed(store, v2('strong', jpeg, { tags: ['温柔', '英勇'] }))
    const result = await library.matchCandidates({
      roleClass: 'support', supportingUseReason: '关键角色需要保持镜头连续性。',
      traitTerms: ['温柔', '英勇'],
    })
    expect(result.status).toBe('candidates')
    if (result.status !== 'candidates') throw new Error('unexpected result')
    expect(result.candidates.map(candidate => String(candidate.entry.catalogAssetId).split(':').at(-1)))
      .toEqual(['strong', 'weak'])
    expect(result.uncertainties).toContain('supporting_role_exception')
    expect(result.reason).toContain('关键角色需要保持镜头连续性。')
  })

  it('returns no candidates for an empty match without reading image objects', async () => {
    const { store, library } = setup()
    const result = await library.matchCandidates({ roleClass: 'lead' })
    expect(result).toMatchObject({ status: 'no_match', applyAllowed: false })
    expect(store.calls).toEqual([])
  })

  it('selects one unique modern sweet heroine while preserving pending-review denial flags', async () => {
    const { store, library } = setup()
    seed(store, v2('sweet', jpeg, {
      gender: 'female',
      era: ['现代'],
      style: '现代甜美',
      tags: ['少女感', '温柔'],
    }))
    seed(store, v2('plain', jpeg, {
      gender: 'male',
      era: ['现代'],
      style: '都市',
      tags: ['冷峻'],
    }))
    const result = await library.recommend({
      roleClass: 'lead',
      requiredEra: '现代',
      gender: 'female',
      styleTerms: ['甜美'],
      traitTerms: ['少女感', '温柔'],
    })
    expect(result.status).toBe('recommended')
    if (result.status !== 'recommended') throw new Error('unexpected result')
    expect(String(result.candidate.entry.catalogAssetId)).toContain(':sweet')
    expect(result.candidate.entry.metadataStatus).toBe('pending_review')
    expect(result.candidate.entry.safety).toEqual({
      canPublish: false,
      canReuse: false,
      canBind: false,
      applyAllowed: false,
    })
    expect(result.applyAllowed).toBe(false)
  })

  it('rejects declared era conflicts and returns no reliable 1980s match', async () => {
    const { store, library } = setup()
    seed(store, v2('modern', jpeg, { era: ['现代'], tags: ['女工'] }))
    const result = await library.recommend({
      roleClass: 'lead',
      requiredEra: '1980年代',
      roleTerms: ['女工'],
    })
    expect(result).toMatchObject({ status: 'no_match', applyAllowed: false })
  })

  it('returns an ancient cold male and excludes a rejected claim', async () => {
    const { store, library } = setup()
    seed(store, v2('ancient-male', jpeg, {
      collection: 'ancient',
      gender: 'male',
      style: '古装',
      tags: ['冷峻'],
    }))
    seed(store, v2('rejected', jpeg, {
      collection: 'ancient',
      status: 'rejected',
      gender: 'male',
      style: '古装',
      tags: ['冷峻'],
    }))
    const result = await library.recommend({
      roleClass: 'lead',
      collection: 'ancient',
      requiredEra: '古代',
      gender: 'male',
      traitTerms: ['冷峻'],
    })
    expect(result.status).toBe('recommended')
    if (result.status !== 'recommended') throw new Error('unexpected result')
    expect(String(result.candidate.entry.catalogAssetId)).toContain(':ancient-male')
  })

  it('requires review for an exact top-score tie instead of breaking it by ID', async () => {
    const { store, library } = setup()
    seed(store, v2('a', jpeg, { tags: ['温柔'] }))
    seed(store, v2('z', jpeg, { tags: ['温柔'] }))
    const result = await library.recommend({ roleClass: 'lead', traitTerms: ['温柔'] })
    expect(result.status).toBe('needs_review')
    if (result.status !== 'needs_review') throw new Error('unexpected result')
    expect(result.candidates).toHaveLength(2)
    expect(result.reason).toContain('did not break the tie')
  })

  it('skips non-leads by default and permits a bounded story-specific exception', async () => {
    const { store, library } = setup()
    seed(store, v2('support', jpeg, { tags: ['医生'] }))
    const skipped = await library.recommend({ roleClass: 'support', roleTerms: ['医生'] })
    expect(skipped).toMatchObject({
      status: 'no_match',
      uncertainties: ['supporting_role_default_skip'],
    })
    expect(store.listCalls).toBe(0)
    const allowed = await library.recommend({
      roleClass: 'support',
      supportingUseReason: '本集关键医生需要保持跨镜头一致。',
      roleTerms: ['医生'],
    })
    expect(allowed.status).toBe('recommended')
    expect(allowed.reason).toContain('本集关键医生')
    await expectLibraryError(library.recommend({
      roleClass: 'extra',
      supportingUseReason: 'x'.repeat(301),
      roleTerms: ['路人'],
    }), 'INVALID_REQUEST', 'recommend')
  })

  it('rejects empty requirements before listing', async () => {
    const { store, library } = setup()
    const result = await library.recommend({ roleClass: 'lead' })
    expect(result).toMatchObject({ status: 'no_match', reason: 'No bounded character requirements were supplied.' })
    expect(store.listCalls).toBe(0)
  })

  it('validates role inputs and exercises query and unclassified-era scoring', async () => {
    const { store, library } = setup()
    const future = v2('future', jpeg, { tags: ['未来', '医生'] })
    seed(store, future)
    await expect(library.recommend({
      roleClass: 'invalid' as 'lead', traitTerms: ['医生'],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST', stage: 'recommend' })
    const result = await library.recommend({
      roleClass: 'lead',
      requiredEra: '未来',
      query: '医生 absent-term',
    })
    expect(result.status).toBe('recommended')
    if (result.status !== 'recommended') throw new Error('unexpected result')
    expect(result.candidate.matched).toEqual(expect.arrayContaining(['era-text', 'query:医生']))
    const noEraText = await library.recommend({
      roleClass: 'lead', requiredEra: '蒸汽时代', roleTerms: ['医生'], query: 'missing',
    })
    expect(noEraText.status).toBe('recommended')
    if (noEraText.status !== 'recommended') throw new Error('unexpected result')
    expect(noEraText.candidate.matched).not.toContain('query:missing')
  })

  it('reports a supporting-role exception and unconfirmed era when no candidate wins', async () => {
    const { store, library } = setup()
    const fixture = v2('no-era', jpeg, { tags: ['护士'] })
    delete (fixture.metadata as { era?: readonly string[] }).era
    seed(store, fixture)
    const recommended = await library.recommend({
      roleClass: 'lead', requiredEra: '现代', roleTerms: ['护士'],
    })
    expect(recommended.status).toBe('recommended')
    if (recommended.status !== 'recommended') throw new Error('unexpected result')
    expect(recommended.uncertainties).toContain('era_unconfirmed')
    const none = await library.recommend({
      roleClass: 'support', supportingUseReason: '本集必须保持配角连续性。', roleTerms: ['不存在'],
    })
    expect(none).toMatchObject({
      status: 'no_match', uncertainties: ['supporting_role_exception'], applyAllowed: false,
    })
    expect(none.reason).toContain('本集必须保持配角连续性')
  })
})

describe('boundary validation helpers', () => {
  it('accepts only fixed-prefix-safe keys and exact metadata candidates', () => {
    expect(() => { assertSafeKey(URBAN_PREFIX + 'x/metadata.json', URBAN_PREFIX) }).not.toThrow()
    for (const key of [null, '', 'x'.repeat(1025), 'a\\b', 'a\u0000b', URBAN_PREFIX + '../x']) {
      expect(() => { assertSafeKey(key, URBAN_PREFIX) }).toThrow(CharacterLibraryError)
    }
    expect(() => { assertSafeKey(ANCIENT_PREFIX + 'x/metadata.json', URBAN_PREFIX) })
      .toThrow(CharacterLibraryError)
    expect(metadataCandidate(URBAN_PREFIX, URBAN_PREFIX)).toBe(false)
    expect(metadataCandidate(URBAN_PREFIX + 'folder/', URBAN_PREFIX)).toBe(false)
    expect(metadataCandidate(URBAN_PREFIX + 'folder/readme.txt', URBAN_PREFIX)).toBe(false)
    expect(metadataCandidate(URBAN_PREFIX + 'folder/metadata.json', URBAN_PREFIX)).toBe(true)
    expect(() => metadataCandidate(URBAN_PREFIX + 'folder//', URBAN_PREFIX)).toThrow(CharacterLibraryError)
    expect(() => metadataCandidate(URBAN_PREFIX + 'folder//metadata.json', URBAN_PREFIX)).toThrow(CharacterLibraryError)
  })

  it('bounds text and lists without normalizing away invalid input', () => {
    expect(boundedText(undefined, 10, 'browse', true)).toBeUndefined()
    expect(boundedText(' value ', 10, 'browse')).toBe('value')
    for (const value of [undefined, 1, '', 'x'.repeat(11), 'bad\u0000value']) {
      expect(() => boundedText(value, 10, 'browse')).toThrow(CharacterLibraryError)
    }
    expect(boundedList(undefined, 2, 10, 'recommend')).toEqual([])
    expect(boundedList(['a', 'b'], 2, 10, 'recommend')).toEqual(['a', 'b'])
    expect(() => { boundedList('bad' as never, 2, 10, 'recommend') })
      .toThrow(CharacterLibraryError)
    expect(() => boundedList(['a', 'b', 'c'], 2, 10, 'recommend')).toThrow(CharacterLibraryError)
    expect(() => boundedList(['a', 'a'], 2, 10, 'recommend')).toThrow(CharacterLibraryError)
  })

  it('detects supported image structures with non-zero dimensions', () => {
    expect(detectImage(structuralJpeg)).toEqual({ mediaType: 'image/jpeg', extension: 'jpg' })
    expect(detectImage(structuralPng)).toEqual({ mediaType: 'image/png', extension: 'png' })
    expect(detectImage(structuralWebp)).toEqual({ mediaType: 'image/webp', extension: 'webp' })
    const zeroJpeg = structuralJpeg.slice()
    zeroJpeg[7] = 0
    zeroJpeg[8] = 0
    const zeroPng = Uint8Array.from(structuralPng)
    zeroPng.fill(0, 16, 24)
    const zeroWebp = Buffer.concat([
      Buffer.from('RIFF'), Buffer.from([22, 0, 0, 0]), Buffer.from('WEBPVP8 '),
      Buffer.from([10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 1, 0]),
    ])
    const badRiffLength = Uint8Array.from(structuralWebp)
    badRiffLength[4] = badRiffLength[4]! + 1
    for (const invalid of [
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9),
      structuralJpeg.slice(0, -2),
      zeroJpeg,
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2),
      zeroPng,
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
      badRiffLength,
      zeroWebp,
    ]) expect(detectImage(invalid)).toBeNull()
  })

  it('fully decodes supported images and rejects plausible corrupt containers', async () => {
    await expect(detectDecodableImage(jpeg)).resolves.toEqual({
      mediaType: 'image/jpeg', extension: 'jpg',
    })
    await expect(detectDecodableImage(png)).resolves.toEqual({
      mediaType: 'image/png', extension: 'png',
    })
    await expect(detectDecodableImage(webp)).resolves.toEqual({
      mediaType: 'image/webp', extension: 'webp',
    })
    const corruptPng = Buffer.from(structuralPng)
    const idat = corruptPng.indexOf(Buffer.from('IDAT'))
    corruptPng[idat + 4] = corruptPng[idat + 4]! ^ 0xff
    for (const invalid of [structuralJpeg, structuralWebp, corruptPng]) {
      expect(detectImage(invalid)).not.toBeNull()
      await expect(detectDecodableImage(invalid)).resolves.toBeNull()
    }
    await expect(detectDecodableImage(Uint8Array.of(1, 2, 3))).resolves.toBeNull()
    await expect(detectDecodableImage(Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      'base64',
    ))).resolves.toBeNull()
  })

  it('rejects malformed PNG, JPEG and WebP structural variants', () => {
    const mutate = (source: Uint8Array, index: number, value: number): Uint8Array => {
      const result = Uint8Array.from(source)
      result[index] = value
      return result
    }
    const pngIend = structuralPng.byteLength - 12
    const duplicateHeader = Buffer.from(structuralPng)
    duplicateHeader.write('IHDR', 37, 'ascii')
    const noImageData = Buffer.from(structuralPng)
    noImageData.write('tEXt', 37, 'ascii')
    const zeroPngHeight = Uint8Array.from(structuralPng)
    zeroPngHeight.fill(0, 20, 24)
    const iendWithData = Buffer.concat([
      structuralPng.subarray(0, pngIend),
      Buffer.from([0, 0, 0, 1]),
      Buffer.from('IEND'),
      Buffer.from([0]),
      structuralPng.subarray(structuralPng.byteLength - 4),
    ])
    const validInterlaced = mutate(structuralPng, 28, 1)
    expect(detectImage(validInterlaced)).toEqual({ mediaType: 'image/png', extension: 'png' })
    for (const invalid of [
      mutate(structuralPng, 11, 12),
      mutate(structuralPng, 12, 0),
      zeroPngHeight,
      mutate(structuralPng, 26, 1),
      mutate(structuralPng, 24, 0),
      mutate(structuralPng, 27, 1),
      mutate(structuralPng, 28, 2),
      mutate(structuralPng, 33, 0xff),
      duplicateHeader,
      noImageData,
      structuralPng.subarray(0, pngIend),
      Buffer.concat([structuralPng, Buffer.from([0])]),
      iendWithData,
    ]) expect(detectImage(invalid)).toBeNull()

    const frame = structuralJpeg.subarray(2, 15)
    const noScan = Buffer.concat([
      structuralJpeg.subarray(0, 15),
      Buffer.from([0xff, 0xe0, 0x00, 0x06, 0, 0, 0, 0]),
    ])
    const noEntropy = Buffer.concat([structuralJpeg.subarray(0, 25), Buffer.from([0xff, 0xd9])])
    const stuffedScan = Buffer.concat([
      structuralJpeg.subarray(0, 25),
      Buffer.from([0xff, 0x00, 0xff, 0xd0, 1, 0xff, 0xd9]),
    ])
    const filledMarker = Buffer.concat([
      structuralJpeg.subarray(0, 2), Buffer.from([0xff]), structuralJpeg.subarray(2),
    ])
    expect(detectImage(stuffedScan)).toEqual({ mediaType: 'image/jpeg', extension: 'jpg' })
    expect(detectImage(filledMarker)).toEqual({ mediaType: 'image/jpeg', extension: 'jpg' })
    const invalidMarkers = [0x00, 0x01, 0xd8, 0xd0].map(marker => Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, marker]),
      Buffer.alloc(19),
    ]))
    for (const invalid of [
      mutate(structuralJpeg, 2, 0),
      mutate(structuralJpeg, 5, 0),
      mutate(structuralJpeg, 5, 0xff),
      mutate(structuralJpeg, 10, 0),
      mutate(structuralJpeg, 11, 0),
      mutate(structuralJpeg, 5, 12),
      mutate(structuralJpeg, 18, 9),
      mutate(structuralJpeg, 19, 0),
      Buffer.concat([structuralJpeg.subarray(0, 15), frame, structuralJpeg.subarray(15)]),
      Buffer.concat([Buffer.from([0xff, 0xd8]), structuralJpeg.subarray(15), Buffer.alloc(10)]),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.alloc(19)]),
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(21, 0xff)]),
      Buffer.concat([structuralJpeg, Buffer.from([0])]),
      structuralJpeg.subarray(0, -1),
      structuralJpeg.subarray(0, -2),
      noScan,
      noEntropy,
      ...invalidMarkers,
    ]) expect(detectImage(invalid)).toBeNull()

    const lossy = webpFile(webpChunk('VP8 ', vp8Body(1, 1)))
    const extended = webpFile(
      webpChunk('VP8X', vp8xBody(1, 1)),
      webpChunk('JUNK', Uint8Array.of(1)),
      webpChunk('VP8L', Uint8Array.of(0x2f, 0, 0, 0, 0, 0)),
    )
    expect(detectImage(lossy)).toEqual({ mediaType: 'image/webp', extension: 'webp' })
    expect(detectImage(extended)).toEqual({ mediaType: 'image/webp', extension: 'webp' })
    const invalidVp8xBodies = [
      Uint8Array.of(...vp8xBody(1, 1).map((value, index) => index === 0 ? 0xc1 : value)),
      Uint8Array.of(...vp8xBody(1, 1).map((value, index) => index === 1 ? 1 : value)),
      Uint8Array.of(...vp8xBody(1, 1).map((value, index) => index === 2 ? 1 : value)),
      Uint8Array.of(...vp8xBody(1, 1).map((value, index) => index === 3 ? 1 : value)),
    ]
    const truncatedChunkHeader = webpFile(webpChunk('JUNK', new Uint8Array()), Buffer.alloc(6))
    const oversizedChunk = webpFile(Buffer.concat([
      Buffer.from('JUNK'), little32(100), Buffer.alloc(6),
    ]))
    for (const invalid of [
      truncatedChunkHeader,
      oversizedChunk,
      webpFile(webpChunk('VP8X', vp8xBody(1, 1))),
      webpFile(webpChunk('VP8X', vp8xBody(1, 1).subarray(0, 9)), webpChunk('VP8L', structuralWebp.subarray(20, 26))),
      ...invalidVp8xBodies.map(body => webpFile(webpChunk('VP8X', body), webpChunk('VP8L', structuralWebp.subarray(20, 26)))),
      webpFile(webpChunk('JUNK', new Uint8Array()), webpChunk('VP8X', vp8xBody(1, 1)), webpChunk('VP8L', structuralWebp.subarray(20, 26))),
      webpFile(webpChunk('VP8X', vp8xBody(1, 1)), webpChunk('VP8X', vp8xBody(1, 1)), webpChunk('VP8L', structuralWebp.subarray(20, 26))),
      webpFile(webpChunk('VP8 ', vp8Body(1, 1).subarray(0, 9))),
      webpFile(webpChunk('VP8 ', mutate(vp8Body(1, 1), 3, 0))),
      webpFile(webpChunk('VP8 ', vp8Body(1, 0))),
      webpFile(webpChunk('VP8 ', vp8Body(1, 1)), webpChunk('VP8L', structuralWebp.subarray(20, 26))),
      webpFile(webpChunk('VP8L', Uint8Array.of(0x2f, 0, 0, 0))),
      webpFile(webpChunk('VP8L', Uint8Array.of(0, 0, 0, 0, 0, 0))),
      webpFile(webpChunk('VP8L', Uint8Array.of(0x2f, 0, 0, 0, 0xe0, 0))),
      webpFile(webpChunk('VP8L', structuralWebp.subarray(20, 26)), webpChunk('VP8L', structuralWebp.subarray(20, 26))),
      webpFile(webpChunk('VP8X', vp8xBody(2, 1)), webpChunk('VP8L', structuralWebp.subarray(20, 26))),
      webpFile(webpChunk('VP8X', vp8xBody(1, 2)), webpChunk('VP8L', structuralWebp.subarray(20, 26))),
      webpFile(webpChunk('JUNK', new Uint8Array())),
    ]) expect(detectImage(invalid)).toBeNull()
  })
})
