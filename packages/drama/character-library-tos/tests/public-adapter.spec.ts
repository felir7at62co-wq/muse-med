/** Anonymous public reads discover live characters and preserve domain verification. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import CharacterLibrary, { CHARACTER_LIBRARY_SOURCE_ID } from '@deepseek-ai/dsh-character-library'
import { afterEach, expect, it, vi } from 'vitest'
import { CHARACTER_LIBRARY_ANCIENT_PREFIX as ancient, CHARACTER_LIBRARY_URBAN_PREFIX as urban } from '../src/adapter.ts'
import { PublicTosCharacterLibraryAdapter } from '../src/public-adapter.ts'
import { apply } from '../src/index.ts'

const key = ancient + 'char_3d_0004/metadata.json'
const headers = { 'content-length': '3', 'content-type': 'application/json', etag: '"0123456789abcdef0123456789abcdef"' }
const partial = { ...headers, 'content-range': 'bytes 0-2/3' }
afterEach(() => { vi.unstubAllGlobals() })

it('lists live metadata pages anonymously and preserves the service continuation token', async () => {
  const token = 'opaque/next+page=1', second = ancient + 'new_person/metadata.json'
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    expect(url.origin).toBe('https://muse.tos-cn-beijing.volces.com')
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('list-type')).toBe('2')
    expect(url.searchParams.get('prefix')).toBe(ancient)
    expect(url.searchParams.get('max-keys')).toBe('4')
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    expect(options?.headers).toBeUndefined()
    return Response.json(url.searchParams.has('continuation-token') ? {
      Contents: [{ Key: second, Size: 7, ETag: headers.etag }], IsTruncated: false,
    } : {
      Name: 'muse', Prefix: ancient, MaxKeys: 4, KeyCount: 4, IsTruncated: true, NextContinuationToken: token,
      Contents: [{ Key: key, Size: 3, ETag: headers.etag },
        { Key: ancient + 'char_3d_0004/portrait.png', Size: 30 },
        { Key: ancient + 'folder/', Size: 0 }, { Key: ancient, Size: 0 }],
    })
  })
  const adapter = new PublicTosCharacterLibraryAdapter(1000, fetcher)
  const first = await adapter.list({ prefix: ancient, limit: 4 })
  expect(first).toEqual({ objects: [{ key, bytes: 3, etag: headers.etag }], nextCursor: token })
  const next = await adapter.list({ prefix: ancient, limit: 4, cursor: token })
  expect(next).toEqual({ objects: [{ key: second, bytes: 7, etag: headers.etag }], nextCursor: null })
  expect(fetcher).toHaveBeenCalledTimes(2)
  const input = fetcher.mock.calls[1]![0]
  const url = input instanceof Request ? new URL(input.url) : new URL(input)
  expect(url.searchParams.get('continuation-token')).toBe(token)
})

it('discovers newly added characters and observes metadata changes and deletion without restarting', async () => {
  const added = urban + 'new_character/metadata.json', image = urban + 'new_character/portrait.png'
  const objects = new Map<string, string>([[key, 'abc']])
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    if (url.searchParams.get('list-type') === '2') {
      return Response.json({ IsTruncated: false, Contents: [...objects].filter(([name]) => name.startsWith(url.searchParams.get('prefix')!))
        .map(([name, data]) => ({ Key: name, Size: Buffer.byteLength(data), ETag: headers.etag })) })
    }
    const data = objects.get(url.pathname.slice(1))
    if (data === undefined) return new Response(null, { status: 404 })
    const bytes = Buffer.byteLength(data)
    return new Response(options?.method === 'HEAD' ? null : data, { status: options?.method === 'HEAD' ? 200 : 206,
      headers: { ...headers, 'content-length': String(bytes), 'content-range': `bytes 0-${bytes - 1}/${bytes}` } })
  })
  const adapter = new PublicTosCharacterLibraryAdapter(1000, fetcher)
  expect((await adapter.list({ prefix: urban, limit: 10 })).objects).toEqual([])
  objects.set(added, 'abc'); objects.set(image, 'png')
  expect((await adapter.list({ prefix: urban, limit: 10 })).objects).toEqual([{ key: added, bytes: 3, etag: headers.etag }])
  expect((await adapter.head(added))?.bytes).toBe(3)
  expect((await adapter.get(image, 10)).data).toEqual(Buffer.from('png'))
  objects.set(added, 'updated')
  expect((await adapter.list({ prefix: urban, limit: 10 })).objects[0]?.bytes).toBe(7)
  expect((await adapter.get(added, 10)).data).toEqual(Buffer.from('updated'))
  objects.delete(added)
  expect((await adapter.list({ prefix: urban, limit: 10 })).objects).toEqual([])
  expect(await adapter.head(added)).toBeNull()
  await expect(adapter.get(added, 10)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

it('accepts omitted or null contents only when TOS reports an empty page', async () => {
  for (const page of [{ KeyCount: 0, IsTruncated: false }, { KeyCount: 0, Contents: null, IsTruncated: false }]) {
    const adapter = new PublicTosCharacterLibraryAdapter(1000, async () => Response.json(page))
    expect(await adapter.list({ prefix: ancient, limit: 1 })).toEqual({ objects: [], nextCursor: null })
  }
  for (const page of [{ IsTruncated: false }, { KeyCount: 1, IsTruncated: false },
    { KeyCount: 0, Contents: {}, IsTruncated: false }, { Contents: null, IsTruncated: false },
    { KeyCount: 1, Contents: { Key: key, Size: 3 }, IsTruncated: false }]) {
    const adapter = new PublicTosCharacterLibraryAdapter(1000, async () => Response.json(page))
    await expect(adapter.list({ prefix: ancient, limit: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  }
})

it('rejects invalid page parameters before network access', async () => {
  const fetcher = vi.fn<typeof fetch>(), adapter = new PublicTosCharacterLibraryAdapter(1000, fetcher)
  for (const limit of [0, 129, NaN]) await expect(adapter.list({ prefix: ancient, limit })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  for (const cursor of ['', '\u200b', 'x'.repeat(2049)]) {
    await expect(adapter.list({ prefix: ancient, limit: 1, cursor })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects malformed, oversized and unsafe native listing responses', async () => {
  const item = { Key: key, Size: 3, ETag: headers.etag }
  const valid = { Contents: [item], IsTruncated: false }
  for (const value of [null, [], {}, { ...valid, Contents: {} }, { ...valid, IsTruncated: 'false' },
    { ...valid, Name: 'other' }, { ...valid, Prefix: urban }, { ...valid, MaxKeys: 2 }, { ...valid, KeyCount: 0 },
    { ...valid, Contents: [item, item] }, { Contents: [item], IsTruncated: true },
    { ...valid, NextContinuationToken: '\u200b' }, { ...valid, Contents: [{ ...item, Size: -1 }] },
    { ...valid, Contents: [{ ...item, Size: '3' }] }, { ...valid, Contents: [{ ...item, ETag: 7 }] },
    ...[urban + 'other/metadata.json', ancient + '../metadata.json', ancient + 'x/%2e%2e/metadata.json', ancient + 'x\\metadata.json']
      .map(Key => ({ ...valid, Contents: [{ ...item, Key }] }))]) {
    const adapter = new PublicTosCharacterLibraryAdapter(1000, async () => Response.json(value))
    await expect(adapter.list({ prefix: ancient, limit: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  }
  const duplicate = new PublicTosCharacterLibraryAdapter(1000, async () => Response.json({ ...valid, Contents: [item, item] }))
  await expect(duplicate.list({ prefix: ancient, limit: 2 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  const repeated = new PublicTosCharacterLibraryAdapter(1000, async () => Response.json({ ...valid, IsTruncated: true, NextContinuationToken: 'same' }))
  await expect(repeated.list({ prefix: ancient, limit: 1, cursor: 'same' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  for (const body of ['<ListBucketResult/>', '{', new Uint8Array([255])]) {
    const adapter = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(body))
    await expect(adapter.list({ prefix: ancient, limit: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  }
  let cancelled = false
  const oversized = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) }, cancel() { cancelled = true },
  })))
  await expect(oversized.list({ prefix: ancient, limit: 1 })).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' })
  expect(cancelled).toBe(true)
})

it('rejects traversal, unknown roots and non-image files without making requests', async () => {
  const fetcher = vi.fn<typeof fetch>(), adapter = new PublicTosCharacterLibraryAdapter(1000, fetcher)
  for (const unsafe of ['releases/private.json', ancient + '../metadata.json', ancient + 'char_3d_0004/.env',
    ancient + 'char_3d_0004/sub/image.jpg', ancient + 'char_3d_0004/image%2Ejpg',
    ...[' image.png', 'image.png ', 'image|.png', 'image*.png', 'image".png', 'image<.png', 'image>.png']
      .map(name => ancient + 'char_3d_0004/' + name), ancient + 'x'.repeat(1025)]) {
    await expect(adapter.head(unsafe)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('reads bounded Range bytes and live metadata', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
    expect(options).toMatchObject({ method: 'GET', headers: { range: 'bytes=0-3' }, redirect: 'error', credentials: 'omit' })
    return new Response('abc', { status: 206, headers: partial })
  })
  expect(await new PublicTosCharacterLibraryAdapter(1000, fetcher).get(key, 3)).toEqual({
    key, bytes: 3, etag: headers.etag, contentType: 'application/json', data: Buffer.from('abc'),
  })
})

it('treats absent objects as missing and omits invalid metadata headers', async () => {
  const missing = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(null, { status: 404 }))
  expect(await missing.head(key)).toBeNull()
  await expect(missing.get(key, 100)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  const plain = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(null, { headers: { 'content-length': '0' } }))
  expect(await plain.head(key)).toEqual({ key, bytes: 0, etag: null, contentType: null })
  const invalid = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(null, {
    headers: { 'content-length': '0', etag: 'private-header', 'content-type': 'text/plain; charset=utf-8' },
  }))
  expect(await invalid.head(key)).toEqual({ key, bytes: 0, etag: null, contentType: null })
})

it('refuses invalid metadata lengths, HTTP refusals and ignored Range requests', async () => {
  for (const length of [undefined, 'invalid', '9007199254740992']) {
    const adapter = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(null, {
      headers: length === undefined ? {} : { 'content-length': length },
    }))
    await expect(adapter.head(key)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  }
  const refused = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(null, { status: 403 }))
  await expect(refused.list({ prefix: ancient, limit: 1 })).rejects.toMatchObject({ code: 'READ_FAILED' })
  await expect(refused.head(key)).rejects.toMatchObject({ code: 'READ_FAILED' })
  await expect(refused.get(key, 10)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  const ignored = new PublicTosCharacterLibraryAdapter(1000, async () => new Response('abc', { headers }))
  await expect(ignored.get(key, 3)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

it('validates Range totals, lengths and declared byte bounds before consuming a body', async () => {
  for (const range of [undefined, 'invalid', 'bytes 0-1/3', 'bytes 0-0/0', 'bytes 0-2/9007199254740992', 'bytes 0-9007199254740992/3']) {
    const adapter = new PublicTosCharacterLibraryAdapter(1000, async () => new Response('abc', {
      status: 206, headers: { ...headers, ...(range === undefined ? {} : { 'content-range': range }) },
    }))
    await expect(adapter.get(key, 3)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  }
  const oversized = new PublicTosCharacterLibraryAdapter(1000, async () => new Response('abcd', {
    status: 206, headers: { ...headers, 'content-range': 'bytes 0-3/4' },
  }))
  await expect(oversized.get(key, 3)).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' })
  const mismatch = new PublicTosCharacterLibraryAdapter(1000, async () => new Response('abc', {
    status: 206, headers: { ...partial, 'content-length': '2' },
  }))
  await expect(mismatch.get(key, 3)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  for (const limit of [0, NaN, 20 * 1024 * 1024 + 1]) await expect(mismatch.get(key, limit)).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' })
})

it('cancels oversized streams and rejects truncated or absent bodies', async () => {
  let cancelled = false
  const oversized = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('abcd')) }, cancel() { cancelled = true; throw Error('private') },
  }), { status: 206, headers: partial }))
  await expect(oversized.get(key, 3)).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' })
  expect(cancelled).toBe(true)
  const truncated = new PublicTosCharacterLibraryAdapter(1000, async () => new Response('ab', { status: 206, headers: partial }))
  await expect(truncated.get(key, 3)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  const absent = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(null, { status: 206, headers: partial }))
  await expect(absent.get(key, 3)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  const broken = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(new ReadableStream({
    start(controller) { controller.error(Error('private')) },
  }), { status: 206, headers: partial }))
  await expect(broken.get(key, 3)).rejects.toMatchObject({ code: 'READ_FAILED' })
})

it('sanitizes network errors, caller cancellation and response cleanup failures', async () => {
  const failed = new PublicTosCharacterLibraryAdapter(1000, async () => { throw Error('private-network') })
  await expect(failed.list({ prefix: ancient, limit: 1 })).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' })
  await expect(failed.head(key)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' })
  const controller = new AbortController(); controller.abort()
  await expect(failed.list({ prefix: ancient, limit: 1 }, controller.signal)).rejects.toMatchObject({ code: 'READ_FAILED' })
  await expect(failed.head(key, controller.signal)).rejects.toMatchObject({ code: 'READ_FAILED' })
  const disconnected = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(new ReadableStream({
    start(stream) { stream.error(Error('private-body-disconnection')) },
  })))
  await expect(disconnected.list({ prefix: ancient, limit: 1 }))
    .rejects.toMatchObject({ code: 'READ_FAILED', message: 'READ_FAILED' })
  const cleanup = new PublicTosCharacterLibraryAdapter(1000, async () => new Response(new ReadableStream({
    cancel() { throw Error('private') },
  }), { status: 404 }))
  expect(await cleanup.head(key)).toBeNull()
})

it('mounts public reads explicitly and rejects credential references in that mode', async () => {
  const ctx = new Context()
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    if (url.searchParams.get('list-type') === '2') return Response.json({ Contents: [{ Key: key, Size: 3 }], IsTruncated: false })
    return options?.method === 'HEAD' ? new Response(null, { headers }) : new Response('abc', { status: 206, headers: partial })
  })
  vi.stubGlobal('fetch', fetcher)
  apply(ctx, { publicRead: true, connectionTimeoutMs: 1000, requestTimeoutMs: 1000 })
  expect(ctx.characterLibraryObjectStore.status()).toEqual({ readConfigured: true, writeConfigured: false })
  expect((await ctx.characterLibraryObjectStore.list({ prefix: ancient, limit: 1 })).objects).toHaveLength(1)
  expect((await ctx.characterLibraryObjectStore.head(key))?.bytes).toBe(3)
  expect((await ctx.characterLibraryObjectStore.get(key, 3)).data).toEqual(Buffer.from('abc'))
  expect(() => { apply(new Context(), { publicRead: true, readAccessKeyIdRef: 'READ_KEY',
    readSecretAccessKeyRef: 'READ_SECRET', connectionTimeoutMs: 1000, requestTimeoutMs: 1000 }) }).toThrow(/cannot be combined/)
  await ctx.fiber.dispose()
})

it.each(['portrait.png', 'portrait final.png', '头像.png', '_portrait.png'])(
  'browses both prefixes and previews %s when the other collection is empty', async (filename) => {
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z1D/HwAF/gJ+fM5MPgAAAABJRU5ErkJggg==', 'base64')
    const id = 'char_urban_male_005', directory = urban + id + '/', metadataKey = directory + 'metadata.json'
    const json = Buffer.from(JSON.stringify({ schema_version: 2, id, images: [{ filename,
      sha256: createHash('sha256').update(image).digest('hex'), bytes: image.byteLength }],
    source: { platform: 'synthetic-test', rights_status: 'unconfirmed' }, status: 'pending_review', category: 'character', style: '都市' }))
    let present = true
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input)
      if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix')
        return Response.json(prefix === ancient ? { Prefix: ancient, KeyCount: 0, IsTruncated: false }
          : { Prefix: urban, KeyCount: present ? 1 : 0, IsTruncated: false,
            Contents: present ? [{ Key: metadataKey, Size: json.byteLength }] : null })
      }
      if (!present || !url.pathname.startsWith('/' + urban)) return new Response(null, { status: 404 })
      const data = url.pathname.slice(1) === metadataKey ? json : image
      const contentType = data === json ? 'application/json' : 'image/png'
      return new Response(options?.method === 'HEAD' ? null : data, { status: options?.method === 'HEAD' ? 200 : 206,
        headers: { 'content-length': String(data.byteLength), 'content-type': contentType,
          'content-range': `bytes 0-${data.byteLength - 1}/${data.byteLength}` } })
    })
    vi.stubGlobal('fetch', fetcher)
    const ctx = new Context()
    apply(ctx, { publicRead: true, connectionTimeoutMs: 1000, requestTimeoutMs: 1000 })
    const library = new CharacterLibrary(ctx)
    try {
      const page = await library.browse({ collection: 'all' })
      expect(page.entries).toHaveLength(1)
      expect(page.entries[0]).toMatchObject({ collection: 'urban' })
      expect(page.nextCursor).toBeNull()
      const preview = await library.preview({ catalogAssetId: `character:${CHARACTER_LIBRARY_SOURCE_ID}:${id}` })
      expect(preview.data).toEqual(new Uint8Array(image))
      expect(fetcher.mock.calls.some(([input]) => input instanceof URL
      && input.pathname === '/' + directory + encodeURIComponent(filename))).toBe(true)
      present = false
      expect(await library.browse({ collection: 'all' })).toEqual({ entries: [], nextCursor: null, scanned: 0 })
      expect(fetcher.mock.calls.some(([input]) => input instanceof URL && input.pathname === '/' + ancient + id + '/metadata.json')).toBe(true)
      expect(fetcher.mock.calls.every(([input]) => input instanceof URL && input.origin === 'https://muse.tos-cn-beijing.volces.com')).toBe(true)
    } finally { await ctx.fiber.dispose() }
  },
)
