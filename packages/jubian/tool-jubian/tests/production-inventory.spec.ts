/** Complete acquisition rejects changing, foreign or duplicate project inventory. */
import { expect, it } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { productionRows, readProductionLibrary } from '../src/production.ts'

function inventory(pages: unknown[]) {
  const paths: string[] = []
  const client = new JubianClient({ baseUrl: 'https://inventory.invalid', credential: () => Promise.resolve('offline-token'),
    fetch: (input) => {
      const address = new URL(input instanceof Request ? input.url : String(input))
      paths.push(address.pathname + address.search)
      const data = pages[Number(address.searchParams.get('pageNum')) - 1]
      if (!data) return Promise.reject(new Error('Unexpected inventory page'))
      return Promise.resolve(new Response(JSON.stringify({ code: 200, data })))
    } })
  return { client, paths }
}

it('acquires every bounded page before returning complete project evidence', async () => {
  const f = inventory([{ total: 2, rows: [{ id: 1, scriptId: 4908 }] }, { total: 2, rows: [{ id: 2, scriptId: 4908 }] }])
  expect(await productionRows(f.client, 4908, 'asset', 1, 3, new AbortController().signal)).toHaveLength(2)
  expect(f.paths).toEqual(['/aigc/asset/list?scriptId=4908&pageNum=1&pageSize=1',
    '/aigc/asset/list?scriptId=4908&pageNum=2&pageSize=1'])
})

it.each([
  { label: 'duplicate identity', pages: [{ total: 2, rows: [{ id: 1 }] }, { total: 2, rows: [{ id: 1 }] }] },
  { label: 'changing total', pages: [{ total: 2, rows: [{ id: 1 }] }, { total: 3, rows: [{ id: 2 }] }] },
  { label: 'missing total', pages: [{ rows: [{ id: 1 }] }] },
  { label: 'foreign project', pages: [{ total: 1, rows: [{ id: 1, scriptId: 9999 }] }] },
  { label: 'oversized page', pages: [{ total: 2, rows: [{ id: 1 }, { id: 2 }] }] },
  { label: 'incomplete final page', pages: [{ total: 2, rows: [{ id: 1 }] }, { total: 2, rows: [] }] },
])('does not call $label complete inventory', async ({ pages }) => {
  const f = inventory(pages)
  await expect(productionRows(f.client, 4908, 'asset', 1, 3, new AbortController().signal)).rejects.toThrow()
})

it('respects the acquisition bound and foreground cancellation', async () => {
  const f = inventory([{ total: 2, rows: [{ id: 1 }] }])
  await expect(productionRows(f.client, 4908, 'asset', 1, 1, new AbortController().signal)).rejects.toThrow('page limit')
  const controller = new AbortController(); controller.abort()
  await expect(productionRows(f.client, 4908, 'asset', 1, 3, controller.signal)).rejects.toThrow()
  expect(f.paths).toHaveLength(1)
})

it('rejects a non-object inventory envelope and invalid row identities', async () => {
  for (const data of [[], { total: 1, rows: [{ id: 0 }] }]) {
    const f = inventory([data])
    await expect(productionRows(f.client, 4908, 'asset', 1, 1, new AbortController().signal)).rejects.toThrow()
  }
})

it('marks unsupported kinds, absent subjects and unsafe image addresses without guessing usable assets', async () => {
  const rows = [
    { id: 1, assetType: 0, assetName: 'unsupported', delFlag: '0' },
    { id: 2, assetType: 1, assetName: 'absent subject', delFlag: '0' },
    { id: 3, assetType: 2, assetName: 'invalid URL', delFlag: '0' },
    { id: 4, assetType: 3, assetName: 'credentials in URL', delFlag: '0' },
    { id: 5, assetType: 4, assetName: 'voice', assetUrl: 'http://insecure.test/a.wav', delFlag: '0' },
    { id: 6, assetType: 1, assetName: 'missing address', delFlag: '1' },
  ]
  const materials = [{ id: 13, assetId: 3, isUsed: 1, hsAssetStatus: 'Active', assetUrl: 'bad-url', hsAssetId: 'scene' },
    { id: 14, assetId: 4, isUsed: 1, hsAssetStatus: 'Active', assetUrl: 'https://user:pass@example.test/a.png', hsAssetId: 'prop' },
    { id: 16, assetId: 6, isUsed: 1, hsAssetStatus: 'Active', hsAssetId: 'missing' }]
  const client = new JubianClient({ baseUrl: 'https://inventory.invalid', credential: async () => 'offline', fetch: async (input) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
    const selected = path.includes('/asset/') ? rows : materials
    return new Response(JSON.stringify({ code: 200, data: { total: selected.length, rows: selected } }))
  } })
  const result = await readProductionLibrary(client, 4908, 100, 2, new AbortController().signal)
  expect(result).toHaveLength(5)
  expect(result.every(row => !row.usable && row.url === null)).toBe(true)
})
