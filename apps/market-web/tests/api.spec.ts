import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { marketDigest, readMarketPackage } from '@deepseek-ai/dsh-muse-market/package'
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import { createMarketBrowserClient, marketWebConfig, readMarketBody } from '../src/api.ts'

const policy = { limits: { archiveBytes: 1048576, expandedBytes: 4194304, fileCount: 64 },
  allowedPlugins: ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill'], requestTimeoutMs: 5000, metadataBytes: 1048576 }
const config = marketWebConfig(policy)
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
async function fixture(name = 'storyboard-starter'): Promise<{ release: MarketRelease; bytes: Uint8Array }> {
  const path = new URL('../../../packages/host/muse-market/tests/fixtures/handoff/' + name + '-1.0.0.zip', import.meta.url)
  const bytes = new Uint8Array(await readFile(path))
  return { bytes, release: { id: 'a'.repeat(32) as MarketRelease['id'], publisherId: 'b'.repeat(32) as MarketRelease['publisherId'],
    publisher: 'Studio', sha256: marketDigest(bytes), bytes: bytes.length, revision: 1, reviewNote: '', status: 'draft', createdAt: '2026-11-02T00:00:00Z',
    manifest: readMarketPackage(bytes, config.limits, config.allowedPlugins).manifest } }
}
afterEach(() => { vi.unstubAllGlobals() })

it('requires explicit bounded public settings and never accepts private credential configuration', () => {
  expect(marketWebConfig(policy)).toEqual(policy)
  expect(marketWebConfig({ ...policy, secretFile: '/private/secret' })).not.toHaveProperty('secretFile')
  for (const value of [{}, { ...policy, requestTimeoutMs: 0 }, { ...policy, allowedPlugins: ['arbitrary-module'] },
    { ...policy, limits: { ...policy.limits, archiveBytes: 100 * 1024 * 1024 } }]) expect(() => marketWebConfig(value)).toThrow('invalid-market-config')
})

it('uses same-origin cookies without constructing authority headers and validates returned release fields', async () => {
  const { release } = await fixture(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [release] }))
  const client = createMarketBrowserClient(config, fetcher)
  expect(await client.actions.catalog('分镜', 'skill', true)).toEqual([release])
  const [url, options] = fetcher.mock.calls[0]!
  expect(url).toBe('/api/market/v1/catalog?q=%E5%88%86%E9%95%9C&kind=skill&mine=true')
  expect(options).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', redirect: 'manual' })
  expect(new Headers(options?.headers).has('cookie')).toBe(false)
  expect(new Headers(options?.headers).has('authorization')).toBe(false)
  fetcher.mockResolvedValueOnce(response({ items: [{ ...release, revision: 0 }] }))
  await expect(client.actions.catalog('', '', false)).rejects.toThrow('invalid-release')
  await client.close()
})

it.each<[number, string]>([[401, 'login-required'], [303, 'login-required'], [403, 'publisher-required'], [409, 'cloud-conflict'], [413, 'archive-too-large'], [429, 'rate-limited'], [503, 'cloud-unavailable']])('maps HTTP %s to a bounded account or market failure', async (status, reason) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'private upstream diagnostic' }, status))
  const client = createMarketBrowserClient(config, fetcher)
  await expect(client.actions.identity()).rejects.toThrow(reason)
  await client.close()
})

it('validates team identity and sends explicit ZIP uploads with the caller-retained retry key', async () => {
  const { release, bytes } = await fixture(), fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ publishers: [{ id: release.publisherId, title: release.publisher }], admin: false }))
    .mockResolvedValueOnce(response(release, 201))
  const client = createMarketBrowserClient(config, fetcher)
  expect(await client.actions.identity()).toEqual({ publishers: [{ id: release.publisherId, title: release.publisher }], admin: false })
  expect((await client.actions.uploadArchive(bytes, release.publisherId, 'request-retained-1')).status).toBe('draft')
  const [url, options] = fetcher.mock.calls[1]!
  expect(url).toBe('/api/market/v1/uploads')
  expect(options?.method).toBe('POST')
  expect(new Headers(options?.headers).get('idempotency-key')).toBe('request-retained-1')
  expect(new Headers(options?.headers).get('x-market-publisher')).toBe(release.publisherId)
  expect(new Uint8Array(await new Response(options?.body).arrayBuffer())).toEqual(bytes)
  await expect(client.actions.uploadArchive(bytes, 'other', 'request-retained-1')).rejects.toThrow('invalid-selection')
  await client.close()
})

it('sends the selected preset in a Bot ZIP and reads it back from the saved release', async () => {
  const { release, bytes } = await fixture('storyboard-director')
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    const sent = new Uint8Array(await new Response(options?.body).arrayBuffer())
    const { manifest } = readMarketPackage(sent, config.limits, config.allowedPlugins)
    expect(manifest.presetPortrait).toBe('coding-assistant')
    return response({ ...release, bytes: sent.length, sha256: marketDigest(sent), manifest }, 201)
  })
  const client = createMarketBrowserClient(config, fetcher)
  try {
    expect(await client.actions.previewArchive(bytes)).not.toHaveProperty('presetPortrait')
    const saved = await client.actions.uploadArchive(bytes, release.publisherId, 'portrait-request-1', 'coding-assistant')
    expect(saved.manifest.presetPortrait).toBe('coding-assistant')
  } finally {
    await client.close()
  }
})

it('shows bounded package validation failures without exposing raw error bodies', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ error: 'file-mismatch' }, 400))
    .mockResolvedValueOnce(response({ error: 'private account diagnostic' }, 400))
  const client = createMarketBrowserClient(config, fetcher)
  await expect(client.actions.identity()).rejects.toThrow('invalid-archive')
  await expect(client.actions.identity()).rejects.toThrow('cloud-unavailable')
  await client.close()
})

it('downloads only bytes matching both the immutable digest and length', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { release, bytes } = await fixture()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(Uint8Array.from(bytes)))
  const client = createMarketBrowserClient(config, fetcher)
  expect(await client.actions.downloadArchive(release)).toEqual({ name: 'storyboard-starter-1.0.0.zip', bytes })
  const changed = Uint8Array.from(bytes); changed[0] = (changed[0]! + 1) % 256
  fetcher.mockResolvedValueOnce(new Response(changed))
  await expect(client.actions.downloadArchive(release)).rejects.toThrow('invalid-archive')
  await expect(client.actions.downloadArchive({ ...release, bytes: bytes.length + 1 })).rejects.toThrow('invalid-archive')
  await client.close()
})

it('rejects oversized response declarations and streamed bodies while cancelling the reader', async () => {
  const cancelled = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1025)) }, cancel: cancelled })
  await expect(readMarketBody(new Response(body), 1024)).rejects.toThrow('invalid-response')
  expect(cancelled).toHaveBeenCalledOnce()
  await expect(readMarketBody(new Response('small', { headers: { 'content-length': '999999' } }), 1024)).rejects.toThrow('invalid-response')
})

it('aborts and settles outstanding calls before replacing the browser client', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => { reject(new DOMException('Stopped', 'AbortError')) }, { once: true })
  }))
  const client = createMarketBrowserClient(config, fetcher)
  const result = client.actions.catalog('', '', false)
  const rejected = expect(result).rejects.toThrow('Stopped')
  await client.close(); await rejected
  await expect(client.actions.identity()).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledOnce()
})
