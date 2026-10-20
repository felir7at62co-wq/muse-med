/** Complete acquisition rejects changing, foreign or duplicate project inventory. */
import { expect, it } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { productionRows } from '../src/production.ts'

function inventory(pages: Record<string, unknown>[]) {
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
