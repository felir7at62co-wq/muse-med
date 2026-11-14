/** Real concurrent blob mutation against the cloud archive reader.
 *
 * The download path re-checks the opened handle and the exact byte count after reading, so
 * these tests mutate the retained blob from a second handle while a real read is in flight.
 * The catalog API is the entry the native HTTP handler serves; the first test also drives
 * real loopback requests, so the served refusal is covered end to end. Nothing here injects
 * a fake node:fs promise or a fabricated Stats object.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, lstat, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMarket, MuseMarketCatalog } from '../src/server.ts'
import type { MarketServerConfig } from '../src/server.ts'
import { MarketCloudError, parseMarketAccountId, parseMarketPublication } from '../src/cloud-protocol.ts'
import { createMarketPackage } from '../src/package.ts'
import { limits, manifest, resources } from './fixtures.ts'

const admin = { id: parseMarketAccountId('a'.repeat(16)), username: 'admin', admin: true }
const author = { id: parseMarketAccountId('b'.repeat(16)), username: 'author', admin: false }
const swappable = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT'])

async function fixture(policy = limits, archive = createMarketPackage(manifest, resources, policy)) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-market-archive-race-')))
  const config: MarketServerConfig = { root, limits: policy, maxReleases: 100, maxActiveUploads: 4,
    jsonRequestBytes: 16384, jsonResponseBytes: 2 * 1024 * 1024, catalogLimit: 100 }
  const store = await MuseMarketCatalog.open(config)
  const server = createServer((request, response) => {
    void handleMarket(store, request, response, author, config).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing native loopback address')
  const origin = `http://127.0.0.1:${address.port}/api/market/v1`
  const publisher = await store.invite(admin, 'Race team', author.id)
  const uploaded = await fetch(origin + '/uploads', { method: 'POST', body: new Uint8Array(archive),
    headers: { 'x-market-publisher': publisher, 'idempotency-key': 'concurrent-blob-mutation' } })
  if (uploaded.status !== 201) throw new Error(`Upload failed: ${uploaded.status} ${await uploaded.text()}`)
  const publication = parseMarketPublication(await uploaded.json(), policy)
  const scratch = join(root, 'settle-probe')
  await writeFile(scratch, 'x')
  return { root, store, origin, publication, archive, scratch, blob: join(root, 'blobs', publication.sha256 + '.zip') }
}

/** One native filesystem round trip is the only clock fine enough to place a write inside
 * a read of a few milliseconds: timers on this platform resolve in ~15.6ms ticks.
 */
async function settle(scratch: string, operations: number): Promise<void> {
  for (let index = 0; index < operations; index += 1) await lstat(scratch)
}

/** Count refusals from one real read, requiring the documented corrupt-storage code. */
async function attempt(store: MuseMarketCatalog, id: Parameters<MuseMarketCatalog['download']>[0]): Promise<string> {
  try { await store.download(id, author); return 'served' } catch (error) {
    if (!(error instanceof MarketCloudError)) throw error
    expect(error).toMatchObject({ code: 'corrupt-storage' })
    return error.code
  }
}

describe('cloud archive races', () => {
  it('refuses a blob swapped for a fresh copy between its path check and the opened handle', { timeout: 30_000 }, async () => {
    const f = await fixture(), staging = join(f.root, 'blob-staging')
    const stopped = { value: false }
    const replacing = (async () => {
      while (!stopped.value) {
        await writeFile(staging, f.archive)
        try { await rename(staging, f.blob) } catch (error) {
          // Windows refuses the swap while another handle owns the destination; retry it.
          if (!swappable.has((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
    })()
    const refusals: string[] = []
    try {
      for (let request = 0; request < 6; request += 1) {
        const response = await fetch(`${f.origin}/releases/${f.publication.id}/download`)
        if (response.status === 200) expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(f.archive))
        else {
          expect(response.status).toBe(500)
          expect(await response.json()).toEqual({ error: 'corrupt-storage' })
          refusals.push('corrupt-storage')
        }
      }
      for (let round = 0; round < 1500; round += 1) refusals.push(await attempt(f.store, f.publication.id))
    } finally {
      stopped.value = true
      await replacing
    }
    expect(refusals).toContain('corrupt-storage')
  })

  it('refuses a blob whose bytes change while the archive is being read', { timeout: 30_000 }, async () => {
    const policy = { ...limits, archiveBytes: 16 * 1024 * 1024, expandedBytes: 16 * 1024 * 1024 }
    const archive = createMarketPackage(manifest,
      { ...resources, 'skills/fixture-skill/assets/bulk.bin': randomBytes(4 * 1024 * 1024) }, policy)
    const f = await fixture(policy, archive), epoch = Date.now() - 60_000
    const refusals: string[] = []
    for (let step = 1; step <= 10; step += 1) {
      const reading = attempt(f.store, f.publication.id)
      // The retained blob is read in a few milliseconds; place the metadata write inside it,
      // after the opened-handle check and before the trailing exact-length check.
      await settle(f.scratch, 12 * step)
      const stamp = new Date(epoch + step * 1000)
      await utimes(f.blob, stamp, stamp)
      refusals.push(await reading)
    }
    expect(refusals).toContain('corrupt-storage')
  })
})
