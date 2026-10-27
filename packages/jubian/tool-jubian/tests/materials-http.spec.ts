import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod } from '../src/methods.ts'

const ROW = { id: 3, assetId: 5, assetName: '角色', assetUrl: 'https://example.test/a.png',
  assetType: 1, isUsed: 1, hsAssetStatus: 'Active' }

describe('material list through the Jubian HTTP client', () => {
  it('reads singleton, multiple, empty and enveloped lists without accepting errors or plain objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jubian-materials-http-'))
    let body: unknown = [ROW]
    const seen: string[] = []
    const server = createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const client = new JubianClient({ credential: async () => 'synthetic-token',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
      const ledger = new JubianLedger({ root })
      const read = async () => await assetMethod(client, ledger, { method: 'materials', script_id: 2708 })
      expect(await read()).toMatchObject({ materials: { total: 1, total_source: 'page_count', rows: [{ material_id: 3, asset_id: 5 }] },
        guidance: expect.stringContaining('不能作为全部素材总数') })
      body = [ROW, { ...ROW, id: 4 }]
      expect(await read()).toMatchObject({ materials: { total: 2, total_source: 'page_count', rows: [{ material_id: 3 }, { material_id: 4 }] } })
      body = []
      expect(await read()).toMatchObject({ materials: { total: 0, total_source: 'page_count', rows: [] } })
      body = { code: 200, total: 7, rows: [ROW] }
      expect(await read()).toMatchObject({ materials: { total: 7, total_source: 'provider', rows: [{ material_id: 3 }] } })
      body = { code: 200, total: 'invalid', rows: [ROW] }
      await expect(read()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
      body = { code: 200, data: ROW }
      await expect(read()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
      body = [{ ...ROW, rows: 'invalid' }]
      await expect(read()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
      body = { code: 403, msg: 'synthetic refusal' }
      await expect(read()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(seen).toHaveLength(8)
      expect(seen.every(value => value.startsWith('GET /aigc/material/list?'))).toBe(true)
      expect(await ledger.records()).toEqual([])
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
