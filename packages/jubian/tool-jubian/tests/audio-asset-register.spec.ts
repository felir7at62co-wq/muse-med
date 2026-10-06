/** Voice registration preserves claims and reconciles only complete, stable inventories. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { registerAudioAsset } from '../src/audio-asset-register.ts'
import { bodyHash } from '../src/write.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const args = { script_id: 2708, asset_name: '角色声线 v1', asset_url: 'https://media.example/voice.wav', idempotency_key: 'voice-key' }
const limits = { pageLimit: 2, pageSize: 1 }
const asset = { id: 7, scriptId: 2708, assetType: 4, assetName: args.asset_name, url: args.asset_url }
const body = { scriptId: 2708, assetName: args.asset_name, assetType: 4, isLocal: 1, url: args.asset_url }

async function fixture(options: {
  pages?: (read: number, page: number) => unknown
  beforeRead?: (ledger: JubianLedger) => Promise<void>
  sendFailure?: boolean
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jubian-audio-register-'))
  roots.push(root)
  const ledger = new JubianLedger({ root }), requests: string[] = []
  let read = 0, sent = false
  const client = new JubianClient({ credential: async () => 'mock-token', fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${init?.method} ${url.pathname}`)
    if (init?.method === 'POST') {
      sent = true
      if (options.sendFailure) throw new Error('response disconnected')
      return new Response(JSON.stringify({ code: 200, data: 7 }))
    }
    if (++read === 1) await options.beforeRead?.(ledger)
    const data = options.pages?.(read, Number(url.searchParams.get('pageNum')))
      ?? { total: sent ? 1 : 0, rows: sent ? [asset] : [] }
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  return { client, ledger, requests }
}

it.each(['invalid', 'http://media.example/voice.wav', 'https://name:secret@media.example/voice.wav',
  'https://media.example/voice.wav#fragment'])('rejects unsafe uploaded voice URL %s before inventory reads', async (url) => {
  const f = await fixture()
  await expect(registerAudioAsset(f.client, f.ledger, { ...args, asset_url: url }, limits))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.requests).toEqual([])
})

it('rejects an empty voice name and a claimed key belonging to another request', async () => {
  const f = await fixture()
  await expect(registerAudioAsset(f.client, f.ledger, { ...args, asset_name: ' ' }, limits))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register',
    scriptId: 2708, requestSha256: 'sha256:different' })
  await expect(registerAudioAsset(f.client, f.ledger, args, limits)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests).toEqual([])
})

it.each([
  { total: 3, repeated: false }, { total: 2, repeated: true },
])('refuses changed totals or repeated identities across pages %j', async ({ total, repeated }) => {
  const f = await fixture({ pages: (_read, page) => page === 1
    ? { total: 2, rows: [asset] } : { total, rows: [{ ...asset, id: repeated ? 7 : 8 }] } })
  await expect(registerAudioAsset(f.client, f.ledger, args, limits)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests.some(request => request.startsWith('POST'))).toBe(false)
  expect(await f.ledger.records()).toEqual([])
})

it.each([true, false])('refuses incomplete inventory at %s empty-page termination', async (empty) => {
  const f = await fixture({ pages: () => ({ total: 3, rows: empty ? [] : [asset] }) })
  await expect(registerAudioAsset(f.client, f.ledger, args, { pageLimit: 1, pageSize: 1 }))
    .rejects.toThrow('Incomplete audio registration inventory')
  expect(f.requests).toHaveLength(1)
})

it('reconciles a timed-out registration by exact URL and name without submitting again', async () => {
  const f = await fixture({ sendFailure: true })
  expect(await registerAudioAsset(f.client, f.ledger, args, limits))
    .toMatchObject({ outcome: 'unknown', verified_readback: true, created_asset_id: 7, replayed: false })
  expect(await registerAudioAsset(f.client, f.ledger, args, limits))
    .toMatchObject({ outcome: 'unknown', verified_readback: true, created_asset_id: 7, replayed: true })
  expect(f.requests.filter(request => request.startsWith('POST'))).toHaveLength(1)
})

it('refuses incomplete post-send inventory and excludes existing exact matches from new identity', async () => {
  const f = await fixture({ pages: (read, page) => read === 1 ? { total: 1, rows: [asset] }
    : { total: 3, rows: [{ ...asset, id: page + 6 }] } })
  await expect(registerAudioAsset(f.client, f.ledger, args, limits)).rejects.toThrow('Incomplete')
  const prior = await fixture({ pages: () => ({ total: 1, rows: [asset] }) })
  expect(await registerAudioAsset(prior.client, prior.ledger, args, limits))
    .toMatchObject({ outcome: 'accepted', created_asset_id: null, verified_readback: false })
})

it('reconciles a matching claim that arrived during the preflight inventory', async () => {
  const f = await fixture({ beforeRead: async (ledger) => {
    await ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register',
      scriptId: 2708, requestSha256: bodyHash(body) })
  }, pages: () => ({ total: 1, rows: [asset] }) })
  expect(await registerAudioAsset(f.client, f.ledger, args, limits))
    .toMatchObject({ replayed: true, outcome: 'unknown', created_asset_id: 7 })
  expect(f.requests.some(request => request.startsWith('POST'))).toBe(false)
})

it('propagates a conflicting claim that arrived before sending the registration', async () => {
  const f = await fixture({ beforeRead: async (ledger) => {
    await ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_remove', requestSha256: 'sha256:other' })
  } })
  await expect(registerAudioAsset(f.client, f.ledger, args, limits)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests.some(request => request.startsWith('POST'))).toBe(false)
})
