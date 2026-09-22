/** `jubian_asset register`: registering an existing image under an explicit category. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod } from '../src/methods.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A project whose existing asset is misfiled as a character, and the image it already holds. */
const MISFILED = { id: 125413, name: '豪华轿车内部｜日｜内｜现代都市豪门剧｜16x9空场景｜v1', assetType: 1 }
const IMAGE_URL = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/material/2026/09/19/aigc_image_995288.jpg'

interface Fixture {
  readonly client: JubianClient
  readonly ledger: JubianLedger
  readonly calls: { method: string; path: string; body: unknown }[]
  /** Add a row to what the next `/aigc/asset/list` answers, as a real create would. */
  readonly publish: (row: Record<string, unknown>) => void
}

/** Serve the asset list from mutable state; every other request is the create itself. */
async function fixture(created: Record<string, unknown> | null = { id: 900100, name: MISFILED.name, assetType: 2 }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jubian-register-'))
  roots.push(root)
  let assets: Record<string, unknown>[] = [MISFILED]
  const calls: Fixture['calls'] = []
  const client = new JubianClient({ credential: async () => 'token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = (url as URL).toString()
      if (path.includes('/aigc/asset/list')) {
        return new Response(JSON.stringify({ code: 200, data: { total: assets.length, rows: assets } }), { status: 200 })
      }
      calls.push({ method: String(init?.method), path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
      if (created !== null) assets = [...assets, created]
      return new Response(JSON.stringify({ code: 200, data: { id: 900100 } }), { status: 200 })
    } })
  return { client, ledger: new JubianLedger({ root: join(root, 'ledger') }), calls,
    publish: (row) => { assets = [...assets, row] } }
}

const ARGS = { method: 'register', script_id: 2708, asset_name: MISFILED.name, asset_url: IMAGE_URL } as const

it('registers an existing image under the requested category without generating one', async () => {
  const f = await fixture()
  const result = await assetMethod(f.client, f.ledger, { ...ARGS, asset_type: 2, idempotency_key: 'k1' })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]?.method).toBe('POST')
  expect(f.calls[0]?.path).toContain('/aigc/asset')
  // Exactly the captured upload-register body: no modelConfig and no isGenerate, which
  // is what keeps this request off the paid generation path.
  expect(f.calls[0]?.body).toEqual({ scriptId: 2708, assetName: MISFILED.name, assetType: 2, isLocal: 1, url: IMAGE_URL })
  expect(result.created_asset_id).toBe(900100)
  expect(result.new_asset_ids).toEqual([900100])
  // The tool must not report the operation as verified-free; the capture calls that an inference.
  expect(String(result.next)).toContain('账单')
})

it('identifies the new asset by list diff, not by the create response body', async () => {
  // The create publishes nothing the list can show: identity has to come from the diff,
  // so an unidentifiable outcome must say so rather than name a guessed asset.
  const f = await fixture(null)
  const result = await assetMethod(f.client, f.ledger, { ...ARGS, asset_type: 2, idempotency_key: 'k2' })
  expect(result.created_asset_id).toBeNull()
  expect(String(result.next)).toContain('无法唯一确定')
})

it('refuses a category outside 1/2/3 before sending anything', async () => {
  const f = await fixture()
  await expect(assetMethod(f.client, f.ledger, { ...ARGS, asset_type: 4, idempotency_key: 'k3' }))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.calls).toHaveLength(0)
})

it('does not resend a registration recorded under the same key', async () => {
  const f = await fixture()
  const first = await assetMethod(f.client, f.ledger, { ...ARGS, asset_type: 2, idempotency_key: 'k4' })
  const second = await assetMethod(f.client, f.ledger, { ...ARGS, asset_type: 2, idempotency_key: 'k4' })
  expect(first.replayed).toBe(false)
  expect(second.replayed).toBe(true)
  expect(f.calls).toHaveLength(1)
  expect(second.created_asset_id).toBeNull()
})
