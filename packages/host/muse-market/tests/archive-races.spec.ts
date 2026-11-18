/** Real blob changes at the cloud reader's open and post-read verification points. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createServer } from 'node:http'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMarket, MuseMarketCatalog } from '../src/server.ts'
import type { MarketServerConfig } from '../src/server.ts'
import { parseMarketAccountId, parseMarketPublication } from '../src/cloud-protocol.ts'
import { createMarketPackage } from '../src/package.ts'
import { limits, manifest, resources } from './fixtures.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const admin = { id: parseMarketAccountId('a'.repeat(16)), username: 'admin', admin: true }
const author = { id: parseMarketAccountId('b'.repeat(16)), username: 'author', admin: false }

async function fixture() {
  const root = await files.realpath(await files.mkdtemp(join(tmpdir(), 'muse-market-archive-race-')))
  const config: MarketServerConfig = { root, limits, maxReleases: 100, maxActiveUploads: 4,
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
    await files.rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing native loopback address')
  const origin = `http://127.0.0.1:${address.port}/api/market/v1`
  const publisher = await store.invite(admin, 'Race team', author.id)
  const archive = createMarketPackage(manifest, resources, limits)
  const uploaded = await fetch(origin + '/uploads', { method: 'POST', body: new Uint8Array(archive),
    headers: { 'x-market-publisher': publisher, 'idempotency-key': 'concurrent-blob-mutation' } })
  if (uploaded.status !== 201) throw new Error(`Upload failed: ${uploaded.status} ${await uploaded.text()}`)
  const publication = parseMarketPublication(await uploaded.json(), limits)
  return { root, store, origin, publication, archive, blob: join(root, 'blobs', publication.sha256 + '.zip') }
}

describe('cloud archive races', () => {
  it('refuses a blob swapped for a fresh copy between its path check and the opened handle', async () => {
    const f = await fixture(), staging = join(f.root, 'blob-staging')
    await files.writeFile(staging, f.archive)
    const open = files.open, inspectPath = vi.spyOn(files, 'lstat')
    let swapped = false
    const replace = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      if (args[0] === f.blob) {
        await files.rename(staging, f.blob)
        swapped = true
      }
      return open(...args)
    })
    try {
      const response = await fetch(`${f.origin}/releases/${f.publication.id}/download`)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'corrupt-storage' })
      expect(swapped).toBe(true)
      expect(inspectPath.mock.calls.filter(([path]) => path === f.blob)).toHaveLength(1)
    } finally {
      replace.mockRestore()
      inspectPath.mockRestore()
    }
  })

  it('refuses an opened blob whose modification time has changed after the payload read', async () => {
    const f = await fixture(), before = await files.lstat(f.blob)
    const stamp = new Date(Math.floor(before.mtimeMs / 1000) * 1000 - 60_000)
    const open = files.open, inspectPath = vi.spyOn(files, 'lstat')
    let measuredMtime: number | undefined
    let restoreHandle: (() => void) | undefined
    const change = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[0] === f.blob) {
        const stat = handle.stat.bind(handle)
        const measure = vi.spyOn(handle, 'stat').mockImplementationOnce(stat).mockImplementationOnce(async (...statArgs) => {
          await files.utimes(f.blob, stamp, stamp)
          const after = await stat(...statArgs)
          measuredMtime = Number(after.mtimeMs)
          return after
        })
        restoreHandle = () => { measure.mockRestore() }
      }
      return handle
    })
    try {
      await expect(f.store.download(f.publication.id, author)).rejects.toMatchObject({ code: 'corrupt-storage', status: 500 })
      expect(measuredMtime).toBe(stamp.getTime())
      expect(inspectPath.mock.calls.filter(([path]) => path === f.blob)).toHaveLength(1)
    } finally {
      restoreHandle?.()
      change.mockRestore()
      inspectPath.mockRestore()
    }
  })
})
