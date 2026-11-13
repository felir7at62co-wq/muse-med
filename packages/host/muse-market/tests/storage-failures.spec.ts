/** Standard native storage failures through public migration, import and HTTP upload operations. */
import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MuseMarketLocal } from '../src/local.ts'
import { handleMarket, MuseMarketCatalog } from '../src/server.ts'
import type { MarketServerConfig } from '../src/server.ts'
import { parseMarketAccountId, parseMarketPublication } from '../src/cloud-protocol.ts'
import { createMarketPackage, marketDigest, marketRelease } from '../src/package.ts'
import { directory, limits, manifest, resources } from './fixtures.ts'

const fault = vi.hoisted(() => {
  const state: { next?: { operation: 'lstat' | 'writeFile' | 'link'; path: string; skip: number; error: Error }; consumed: number } = { consumed: 0 }
  return state
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const inspect = (operation: 'lstat' | 'writeFile' | 'link', path: unknown): void => {
    const selected = fault.next
    if (selected?.operation !== operation || selected.path !== path) return
    if (selected.skip > 0) { selected.skip--; return }
    delete fault.next
    fault.consumed++
    throw selected.error
  }
  return { ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => { inspect('lstat', args[0]); return await fs.lstat(...args) },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => { inspect('writeFile', args[0]); await fs.writeFile(...args) },
    link: async (...args: Parameters<typeof fs.link>) => { inspect('link', args[1]); await fs.link(...args) },
  }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  delete fault.next; fault.consumed = 0
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Market storage failure fixture cleanup failed')
})

async function localFixture() {
  const f = await directory(); cleanups.push(f.cleanup)
  const root = join(f.root, 'market'), local = new MuseMarketLocal({ root, limits })
  await local.ready()
  return { root, local, archive: createMarketPackage(manifest, resources, limits) }
}

it('unit: preserves the original ledger when its migration read receives a standard access refusal', async () => {
  const f = await localFixture(), ledger = join(f.root, 'installations.json')
  const original = Buffer.from(JSON.stringify({ version: 1, installations: [] }) + '\n')
  await writeFile(ledger, original)
  const denied = Object.assign(new Error('Fixture migration read denied'), { code: 'EACCES' })
  // Finish the first validated read's two path checks before refusing the migration reread.
  fault.next = { operation: 'lstat', path: ledger, skip: 2, error: denied }
  await expect(f.local.initializeActivation()).rejects.toBe(denied)
  expect(fault.consumed).toBe(1)
  expect(await readFile(ledger)).toEqual(original)
  await expect(readFile(join(f.root, 'installations.v1.backup.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(f.local.defaults()).rejects.toThrow('activation-not-initialized')
  await f.local.initializeActivation()
  expect(await f.local.defaults()).toEqual({ revision: 0, defaults: [] })
  expect(await readFile(join(f.root, 'installations.v1.backup.json'))).toEqual(original)
})

it('unit: refuses a failed migration backup without committing the successor and later retries from the original bytes', async () => {
  const f = await localFixture(), ledger = join(f.root, 'installations.json')
  const original = Buffer.from(JSON.stringify({ version: 1, installations: [] }) + '\n')
  const backup = join(f.root, 'installations.v1.backup.json')
  await writeFile(ledger, original)
  const denied = Object.assign(new Error('Fixture migration backup denied'), { code: 'EACCES' })
  fault.next = { operation: 'writeFile', path: backup, skip: 0, error: denied }
  await expect(f.local.initializeActivation()).rejects.toBe(denied)
  expect(fault.consumed).toBe(1)
  expect(await readFile(ledger)).toEqual(original)
  await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.local.list()).toEqual([])
  await f.local.initializeActivation()
  expect(await f.local.defaults()).toEqual({ revision: 0, defaults: [] })
  expect(await readFile(backup)).toEqual(original)
})

it('unit: propagates a destination inspection refusal before staging or ledger commit and admits the unchanged archive after recovery', async () => {
  const f = await localFixture(), release = marketRelease(f.archive, limits)
  const denied = Object.assign(new Error('Fixture installation lookup denied'), { code: 'EACCES' })
  fault.next = { operation: 'lstat', path: join(f.root, 'packages', release.id), skip: 0, error: denied }
  await expect(f.local.install(f.archive)).rejects.toBe(denied)
  expect(fault.consumed).toBe(1)
  expect(await f.local.list()).toEqual([])
  expect(await readdir(join(f.root, 'packages'))).toEqual([])
  expect((await readdir(f.root)).filter(name => name.startsWith('.pending-'))).toEqual([])
  await expect(readFile(join(f.root, 'installations.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const installed = await f.local.install(f.archive)
  expect(installed).toEqual({ release, enabled: false })
  expect(await f.local.verify(installed.release)).toEqual(Buffer.from(f.archive))
  expect(await f.local.list()).toEqual([installed])
})

it('unit: cleans a failed archive retain over native HTTP and releases capacity for the same original upload key', async () => {
  const f = await directory(); cleanups.push(f.cleanup)
  const config: MarketServerConfig = { root: f.root, limits, maxReleases: 100, maxActiveUploads: 1,
    jsonRequestBytes: 16384, jsonResponseBytes: 2 * 1024 * 1024, catalogLimit: 100 }
  const store = await MuseMarketCatalog.open(config); cleanups.push(async () => { await store.close() })
  const admin = { id: parseMarketAccountId('a'.repeat(16)), username: 'admin', admin: true }
  const author = { id: parseMarketAccountId('b'.repeat(16)), username: 'author', admin: false }
  const publisher = await store.invite(admin, 'Production team', author.id)
  const server = createServer((request, response) => {
    void handleMarket(store, request, response, author, config).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  cleanups.push(async () => {
    if (!server.listening) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing native loopback address')
  const origin = `http://127.0.0.1:${address.port}/api/market/v1`
  const archive = createMarketPackage(manifest, resources, limits)
  const denied = Object.assign(new Error('Fixture immutable archive link failed'), { code: 'EIO' })
  fault.next = { operation: 'link', path: join(f.root, 'blobs', marketDigest(archive) + '.zip'), skip: 0, error: denied }
  const upload = async () => await fetch(origin + '/uploads', { method: 'POST', body: new Uint8Array(archive),
    headers: { 'x-market-publisher': publisher, 'idempotency-key': 'retained-original-key-after-storage-failure' } })
  const refused = await upload()
  expect(refused.status).toBe(500)
  expect(await refused.json()).toEqual({ error: 'market-unavailable' })
  expect(fault.consumed).toBe(1)
  expect(await readdir(join(f.root, 'blobs'))).toEqual([])
  expect(store.list(author, { q: '', mine: true })).toEqual([])
  const response = await upload()
  expect(response.status).toBe(201)
  const saved = parseMarketPublication(await response.json(), limits)
  expect(saved).toMatchObject({ status: 'draft', revision: 1, sha256: marketDigest(archive), bytes: archive.byteLength, manifest })
  expect(store.list(author, { q: '', mine: true })).toEqual([saved])
  const download = await fetch(origin + '/releases/' + saved.id + '/download')
  expect(download.status).toBe(200)
  expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(archive))
})
