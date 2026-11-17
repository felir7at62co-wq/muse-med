/** Browser-to-cloud requests preserve verified bytes and use the existing login. */
import { describe, expect, it, vi } from 'vitest'
import { createMarketPackage, marketDigest, readMarketPackage } from '@deepseek-ai/dsh-muse-market/src/package.ts'
import { parseMarketAccountId, parseMarketPublicationId, parseMarketPublisherId,
  parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { createMarketBrowserClient, marketWebConfig, readMarketBody } from '../src/api.ts'
import type { MarketPublication } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { createLegacySkillPackage } from '@deepseek-ai/dsh-muse-market/src/legacy-skill.ts'
import { parseMarketLegacyCatalog } from '@deepseek-ai/dsh-muse-market/legacy'
import { originalCatalogEntry, originalSkillArchive } from '../../../packages/host/muse-market/tests/legacy-fixtures.ts'

const config = marketWebConfig({ limits: { archiveBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, fileCount: 64 },
  requestTimeoutMs: 5000, metadataBytes: 1024 * 1024 })
const accountId = parseMarketAccountId('a'.repeat(16)), publisherId = parseMarketPublisherId('b'.repeat(32))
const identity = { publishers: [{ id: publisherId, title: 'Studio' }], admin: true }
const instructions = '---\nname: fixture-skill\ndescription: Review a scene.\n---\nKeep the original facts.\n'
const archive = createMarketPackage({ name: 'fixture-skill', title: 'Scene review', description: 'Review scenes.',
  version: '1.0.0', license: 'MIT', category: 'writing', examples: [], requirements: [], formatVersion: 1, kind: 'skill',
  skills: [{ name: 'fixture-skill', path: 'skills/fixture-skill/SKILL.md' }] },
{ 'skills/fixture-skill/SKILL.md': new TextEncoder().encode(instructions) }, config.limits)
const publication = (bytes = archive): MarketPublication => ({ id: parseMarketPublicationId('c'.repeat(32)),
  publisherId, publisher: 'Studio', sha256: marketDigest(bytes), bytes: bytes.length,
  manifest: readMarketPackage(bytes, config.limits).manifest, revision: 1, status: 'published',
  reviewNote: '', createdAt: '2026-11-14T00:00:00.000Z' })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

function authenticated(fetcher: typeof fetch): typeof fetch {
  return async (path, options) => path === '/api/muse.account' ? json({ accountId })
    : path === '/api/market/v1/me' ? json(identity) : await fetcher(path, options)
}

describe('public transport bounds', () => {
  it('resolves explicit defaults and rejects invalid resource limits', () => {
    expect(config.limits.recordBytes).toBe(4 * 1024 * 1024)
    expect(config.catalogLimit).toBe(100)
    expect(config).not.toHaveProperty('cookie')
    expect(() => marketWebConfig({})).toThrow('invalid-config')
    expect(() => marketWebConfig({ ...config, requestTimeoutMs: 0 })).toThrow('invalid-config')
  })

  it('rejects bodies above their bound and releases the stream', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)) }, cancel }))
    await expect(readMarketBody(response, 10)).rejects.toThrow('response-too-large')
    expect(cancel).toHaveBeenCalledTimes(1)
    await expect(readMarketBody(new Response('x', { headers: { 'content-length': 'bad' } }), 10))
      .rejects.toThrow('response-too-large')
  })

  it('cancels active HTTP requests when the page carrier closes', async () => {
    let notifyStarted = (): void => { throw new Error('Readiness promise was not initialized') }
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const fetcher = vi.fn<typeof fetch>(async (_path, options) => await new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true }); notifyStarted()
    }))
    const client = createMarketBrowserClient(config, fetcher)
    const result = expect(client.actions.catalog('', false)).rejects.toThrow('cloud-timeout')
    await started; await client.close(); await result
  })
})

it('requests fresh same-origin catalog data without constructing credential headers', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [publication()] }))
  const client = createMarketBrowserClient(config, fetcher)
  expect(await client.actions.catalog('scene', false)).toEqual([publication()])
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/market/v1/catalog?q=&mine=false&kind=skill')
  const options = fetcher.mock.calls[0]?.[1]
  expect(options).toMatchObject({ credentials: 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'manual' })
  expect(new Headers(options?.headers).has('cookie')).toBe(false)
  expect(new Headers(options?.headers).has('authorization')).toBe(false)
  expect(await client.actions.catalog('fixture-skill', false)).toEqual([publication()])
  expect(await client.actions.catalog('', true)).toEqual([publication()])
  expect(fetcher.mock.lastCall?.[1]?.credentials).toBe('same-origin')
  fetcher.mockResolvedValueOnce(json({ items: [{ ...publication(), status: 'draft' }] }))
  await expect(client.actions.catalog('', false)).rejects.toThrow('invalid-response')
  await client.close()
})

it('resolves the legacy market identity from the stable account and refuses an account change', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accountId })).mockResolvedValueOnce(json(identity))
    .mockResolvedValueOnce(json({ accountId }))
  const client = createMarketBrowserClient(config, fetcher)
  expect(await client.actions.identity()).toEqual({ accountId, ...identity })
  fetcher.mockResolvedValueOnce(json({ accountId })).mockResolvedValueOnce(json(identity))
    .mockResolvedValueOnce(json({ accountId: 'd'.repeat(16) }))
  await expect(client.actions.identity()).rejects.toThrow('account-changed')
  await client.close()
})

it('prepares and uploads the same bound archive while preserving the input and retained request key', async () => {
  let uploaded: Uint8Array | undefined
  const fetcher = vi.fn<typeof fetch>(async (path, options) => {
    if (path === '/api/muse.account') return json({ accountId })
    if (path === '/api/market/v1/me') return json(identity)
    expect(path).toBe('/api/market/v1/uploads')
    expect(new Headers(options?.headers).get('idempotency-key')).toBe('upload-retained-1')
    expect(new Headers(options?.headers).get('x-market-publisher')).toBe(publisherId)
    expect(new Headers(options?.headers).get('x-muse-market-account')).toBe(accountId)
    uploaded = new Uint8Array(await new Response(options?.body).arrayBuffer())
    return json({ ...publication(uploaded), status: 'draft' })
  })
  const client = createMarketBrowserClient(config, fetcher)
  const prepared = await client.actions.prepareArchive(archive, 'storyboard-reviewer')
  expect(prepared.manifest.presetPortrait).toBe('storyboard-reviewer')
  expect(readMarketPackage(archive, config.limits).manifest.presetPortrait).toBeUndefined()
  const saved = await client.actions.uploadArchive(prepared.bytes, publisherId,
    parseMarketUploadRequestId('upload-retained-1'), accountId)
  expect(uploaded).toEqual(prepared.bytes)
  expect(saved.manifest).toEqual(prepared.manifest)
  expect(saved.status).toBe('draft')
  await client.close()
})

it('refuses an upload from a stale account before any mutation is sent', async () => {
  const fetcher = vi.fn<typeof fetch>(async path => path === '/api/muse.account'
    ? json({ accountId: 'd'.repeat(16) }) : json(identity))
  const client = createMarketBrowserClient(config, fetcher)
  await expect(client.actions.uploadArchive(archive, publisherId, parseMarketUploadRequestId('upload-retained-2'), accountId))
    .rejects.toThrow('account-changed')
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  await client.close()
})

it('verifies complete downloaded archives and rejects mismatched bytes', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(Uint8Array.from(archive)))
    .mockResolvedValueOnce(new Response('altered'))
  const client = createMarketBrowserClient(config, fetcher)
  const file = await client.actions.downloadPublication(publication())
  expect(file.bytes).toEqual(archive)
  expect(file.name).toBe('fixture-skill-1.0.0.zip')
  await expect(client.actions.downloadPublication(publication())).rejects.toThrow('digest-mismatch')
  await client.close()
})

it('returns a converted original ZIP identical to the Host package without claiming installation', async () => {
  const original = originalSkillArchive(), entry = originalCatalogEntry(original)
  const resource = parseMarketLegacyCatalog({ schemaVersion: 1, entries: [entry] }, '', config.limits, 100)[0]
  if (resource === undefined) throw new Error('Missing original fixture resource')
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(Uint8Array.from(original)))
  const client = createMarketBrowserClient(config, fetcher)
  const file = await client.actions.downloadLegacy(resource)
  expect(file.name).toBe('fixture-skill-0.1.0.zip')
  expect(file.bytes).toEqual(createLegacySkillPackage(resource, original, config.limits))
  expect(readMarketPackage(file.bytes, config.limits).manifest.skills[0]?.name).toBe('fixture-skill')
  expect(fetcher.mock.calls).toHaveLength(1)
  expect(fetcher.mock.calls[0]?.[0]).toBe(resource.downloadPath)
  expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('omit')
  await client.close()
})

it('rejects a detail response for a different publication id', async () => {
  const expected = publication()
  const client = createMarketBrowserClient(config, async () => json({ ...expected, id: parseMarketPublicationId('d'.repeat(32)) }))
  await expect(client.actions.getPublication(expected.id)).rejects.toThrow('invalid-response')
  await client.close()
})

it('sends the original account assertion and accepts the exact next review revision', async () => {
  const original = { ...publication(), status: 'pending' as const }
  const expected = { ...original, status: 'published' as const, revision: 2, reviewNote: 'Reviewed.' }
  const fetcher = vi.fn<typeof fetch>(authenticated(async (path, options) => {
    expect(path).toBe(`/api/market/v1/releases/${original.id}/review`)
    expect(new Headers(options?.headers).get('x-muse-market-account')).toBe(accountId)
    expect(new Headers(options?.headers).has('cookie')).toBe(false)
    if (typeof options?.body !== 'string') throw new Error('Expected JSON review body')
    expect(JSON.parse(options.body)).toEqual({ revision: 1, action: 'approve', note: 'Reviewed.' })
    return json(expected)
  }))
  const client = createMarketBrowserClient(config, fetcher)
  expect(await client.actions.review(original.id, 1, 'approve', 'Reviewed.', accountId)).toEqual(expected)
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  await client.close()
})

it.each<Partial<MarketPublication>>([
  { id: parseMarketPublicationId('d'.repeat(32)) }, { revision: 9 }, { status: 'pending' }, { reviewNote: 'Other note' },
])('reads the original publication after a mismatched review response without repeating the write: %j', async (change) => {
  const original = { ...publication(), status: 'pending' as const }
  const next = { ...original, status: 'published' as const, revision: 2, reviewNote: 'Reviewed.' }
  const fetcher = vi.fn<typeof fetch>(authenticated(async (path, options) => {
    if (options?.method === 'POST') return json({ ...next, ...change })
    expect(path).toBe(`/api/market/v1/releases/${original.id}`)
    return json(original)
  }))
  const client = createMarketBrowserClient(config, fetcher)
  await expect(client.actions.review(original.id, 1, 'approve', 'Reviewed.', accountId)).rejects.toThrow('review-unconfirmed')
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  expect(fetcher.mock.calls.some(([path]) => path === `/api/market/v1/releases/${original.id}`)).toBe(true)
  await client.close()
})

it.each([503, 409])('reconciles an uncertain review by the original id without treating a %i conflict as success', async (status) => {
  const original = { ...publication(), status: 'pending' as const }
  const next = { ...original, status: 'published' as const, revision: 2, reviewNote: 'Reviewed.' }
  const fetcher = vi.fn<typeof fetch>(authenticated(async (_path, options) => options?.method === 'POST'
    ? new Response(null, { status }) : json(next)))
  const client = createMarketBrowserClient(config, fetcher)
  const result = client.actions.review(original.id, 1, 'approve', 'Reviewed.', accountId)
  if (status === 503) expect(await result).toEqual(next)
  else await expect(result).rejects.toThrow('cloud-conflict')
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  await client.close()
})

it('refuses to deliver a private publication downloaded across an account change', async () => {
  const item = { ...publication(), status: 'draft' as const }
  let active = accountId
  const fetcher = vi.fn<typeof fetch>(async (path) => {
    if (path === '/api/muse.account') return json({ accountId: active })
    if (path === '/api/market/v1/me') return json(identity)
    expect(path).toBe(`/api/market/v1/releases/${item.id}/download`)
    active = parseMarketAccountId('d'.repeat(16))
    return new Response(Uint8Array.from(archive))
  })
  const client = createMarketBrowserClient(config, fetcher)
  await expect(client.actions.downloadPublication(item)).rejects.toThrow('account-changed')
  await client.close()
})
