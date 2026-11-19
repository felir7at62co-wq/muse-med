/** Image registration binds each receipt to one exact request and its verified asset. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as AtomicWrite from '@deepseek-ai/dsh-atomic-write'
import { afterEach, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod } from '../src/methods.ts'
import { assetRegistrationReceiptPath } from '../src/asset-register-receipt.ts'
import { registerImageAsset, resolveAssetRegistrationScanOptions } from '../src/asset-register.ts'
import { bodyHash } from '../src/write.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const request = (name: string, key: string) => ({ method: 'register', script_id: 2708,
  asset_name: name, asset_type: 3, asset_url: `https://media.example/${name}.png`, idempotency_key: key })

type Row = Record<string, unknown>
async function fixture(onPost: (body: Row, publish: (row: Row) => void) => Promise<void>, options: {
  initial?: Row[]
  list?: (read: number, page: number, data: { rows: Row[]; total: number }) => unknown
  detail?: (id: number, found: Row | null) => unknown
  materials?: unknown
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jubian-image-receipts-'))
  roots.push(root)
  const rows: Row[] = [...options.initial ?? []], writes: Row[] = [], requests: string[] = []
  let reads = 0
  const client = new JubianClient({ credential: async () => 'mock-token', fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${init?.method} ${url.pathname}${url.search}`)
    if (url.pathname.endsWith('/aigc/material/getGeneratedImageByAssetId')) {
      return Response.json({ code: 200, data: options.materials ?? [] })
    }
    if (url.pathname.endsWith('/aigc/asset/list')) {
      const page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
      const data = { total: rows.length, rows: structuredClone(rows.slice((page - 1) * size, page * size)) }
      return Response.json({ code: 200, data: options.list ? await options.list(++reads, page, data) : data })
    }
    if (init?.method === 'GET') {
      const id = Number(url.pathname.split('/').at(-1)), found = rows.find(row => row.id === id) ?? null
      return Response.json({ code: 200, data: options.detail ? await options.detail(id, found) : found })
    }
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
    const body = JSON.parse(init.body) as Record<string, unknown>
    writes.push(body)
    await onPost(body, (row) => { rows.push(row) })
    return Response.json({ code: 200, data: null })
  } })
  return { client, ledger: new JubianLedger({ root }), writes, requests, rows }
}

it('keeps concurrent requests out of each other’s asset receipts', async () => {
  let arrivals = 0
  let release: () => void = () => { throw new Error('Barrier not initialized') }
  const bothPosts = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(async (body, publish) => {
    publish({ id: body.assetName === 'A' ? 101 : 102, scriptId: 2708, assetName: body.assetName,
      assetType: body.assetType, assetUrl: body.url })
    if (++arrivals === 2) release()
    await bothPosts
  })
  const [a, b] = await Promise.all([assetMethod(f.client, f.ledger, request('A', 'key-a')),
    assetMethod(f.client, f.ledger, request('B', 'key-b'))])
  expect(a).toMatchObject({ created_asset_id: 101, new_asset_ids: [101], verified_readback: true })
  expect(b).toMatchObject({ created_asset_id: 102, new_asset_ids: [102], verified_readback: true })
  expect(f.writes).toHaveLength(2)
})

it('does not claim a sole unrelated addition as the requested asset', async () => {
  const f = await fixture(async (_body, publish) => {
    publish({ id: 202, scriptId: 2708, assetName: 'foreign', assetType: 3, assetUrl: 'https://media.example/foreign.png' })
  })
  expect(await assetMethod(f.client, f.ledger, request('mine', 'key-mine')))
    .toMatchObject({ created_asset_id: null, new_asset_ids: [], verified_readback: false, status: 'unconfirmed' })
})

it('retains the first verified asset identity on same-key replay', async () => {
  const f = await fixture(async (body, publish) => {
    publish({ id: 303, scriptId: 2708, assetName: body.assetName, assetType: 3, assetUrl: body.url })
  })
  const args = request('replay', 'key-replay')
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ created_asset_id: 303, replayed: false })
  expect(await assetMethod(f.client, new JubianLedger({ root: f.ledger.root }), args))
    .toMatchObject({ created_asset_id: 303, replayed: true, verified_readback: true, new_asset_ids: [] })
  expect(f.writes).toHaveLength(1)
})

it('refuses an altered project, name or URL under an existing registration key', async () => {
  const f = await fixture(async (body, publish) => {
    publish({ id: 404, scriptId: 2708, assetName: body.assetName, assetType: 3, assetUrl: body.url })
  })
  await assetMethod(f.client, f.ledger, request('original', 'key-changed'))
  await expect(assetMethod(f.client, f.ledger, { ...request('changed', 'key-changed'), script_id: 2709 }))
    .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.writes).toHaveLength(1)
})

const image = (id: number, name = 'mine'): Row => ({ id, scriptId: 2708, assetType: 3,
  assetName: name, assetUrl: `https://media.example/${name}.png` })
const publishImage = async (_body: Row, publish: (row: Row) => void) => { publish(image(501)) }
const args = request('mine', 'mine-key')
const scan = { assetRegistrationScan: { pageSize: 1, pageLimit: 5 } }

it('reads all inventory pages and excludes matching assets present before dispatch', async () => {
  const f = await fixture(publishImage, { initial: [image(1), image(2, 'other')] })
  expect(await assetMethod(f.client, f.ledger, args, scan)).toMatchObject({ status: 'verified', created_asset_id: 501 })
  expect(f.requests.filter(value => value.includes('/list?'))).toHaveLength(5)
  const receipt = JSON.parse(await readFile(assetRegistrationReceiptPath(f.ledger, args.idempotency_key), 'utf8')) as Row
  expect(receipt).toMatchObject({ before_asset_ids: [1, 2], verified_asset: { asset_id: 501 } })
})

it('reports multiple exact new candidates without assigning any created ID', async () => {
  const f = await fixture(async (_body, publish) => { publish(image(501)); publish(image(502)) })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'ambiguous', created_asset_id: null,
    new_asset_ids: [], verified_readback: false, matching_assets: [{ asset_id: 501 }, { asset_id: 502 }] })
})

it.each([
  ['another URL', { assetUrl: 'https://media.example/other.png' }],
  ['another project', { scriptId: 999 }],
  ['another category', { assetType: 1 }],
  ['another name', { assetName: 'other' }],
  ['another ID', { id: 999 }],
  ['a deleted asset', { delFlag: '1' }],
  ['an explicit deletion', { deleted: true }],
] as const)('does not claim a candidate whose detail identifies %s', async (_label, changes) => {
  const f = await fixture(publishImage, { detail: (_id, row) => ({ ...row, ...changes }) })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'unconfirmed', created_asset_id: null,
    verified_readback: false, new_asset_ids: [] })
})

it('accepts equivalent provider ID fields while requiring the exact uploaded URL', async () => {
  const f = await fixture(publishImage, { detail: () => ({ assetId: 501, scriptId: '2708', assetType: 3,
    name: 'mine', url: args.asset_url }) })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', created_asset_id: 501 })
})

it('reads a parent without a top-level URL through the committed generated-image representation', async () => {
  // The parent and material fields are retained by muse-image-material-readback/image-fixture.mjs.
  const f = await fixture(publishImage, { detail: () => ({ id: 501, scriptId: 2708, assetType: 3,
    assetName: 'mine', hsAssetStatus: null }), materials: [{ id: 900, scriptId: 2708, assetId: 501,
    assetUrl: args.asset_url, hsAssetStatus: 'Active', isUsed: 0 }] })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', created_asset_id: 501 })
  expect(f.requests).toContain('GET /prod-api/aigc/material/getGeneratedImageByAssetId?assetId=501')
})

it.each([
  { id: 900, assetId: 999, scriptId: 2708, assetUrl: 'https://media.example/mine.png' },
  { id: 900, assetId: 501, scriptId: 999, assetUrl: 'https://media.example/mine.png' },
  { id: 900, assetId: 501, scriptId: 2708, assetUrl: 'https://media.example/other.png' },
  { id: 900, scriptId: 2708, assetUrl: 'https://media.example/mine.png' },
  'unreadable', null,
])('does not claim a URL-less parent from unrelated or unreadable material %j', async (material) => {
  const f = await fixture(publishImage, { detail: () => ({ id: 501, scriptId: 2708, assetType: 3, assetName: 'mine' }),
    materials: [material] })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'unconfirmed', created_asset_id: null,
    verified_readback: false, new_asset_ids: [] })
})

it('keeps ambiguous URL-less parent materials unconfirmed', async () => {
  const material = { id: 900, assetId: 501, scriptId: 2708, assetUrl: args.asset_url }
  const f = await fixture(publishImage, { detail: () => ({ id: 501, scriptId: 2708, assetType: 3, assetName: 'mine' }),
    materials: [material, { ...material, id: 901 }] })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'unconfirmed', created_asset_id: null })
})

it('accepts the captured single-material URL alias with exact parent identity', async () => {
  const f = await fixture(publishImage, { detail: () => ({ id: 501, scriptId: 2708, assetType: 3, assetName: 'mine',
    assetUrl: null }), materials: { materialId: 900, assetId: '501', materialUrl: args.asset_url } })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', created_asset_id: 501 })
})

it('uses complete project-scoped list membership when the parent omits scriptId', async () => {
  // asset.spec.ts and image-readback-loader.spec.ts retain parent details without scriptId.
  const f = await fixture(publishImage, { detail: () => ({ id: 501, assetType: 3, name: 'mine', isLocal: 1,
    assetUrl: args.asset_url }) })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', created_asset_id: 501 })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', created_asset_id: 501, replayed: true })
  expect(f.writes).toHaveLength(1)
})

it('does not trust a project-less detail after it leaves the project-scoped inventory', async () => {
  const f = await fixture(publishImage, { detail: () => ({ id: 501, assetType: 3, name: 'mine', assetUrl: args.asset_url }) })
  await assetMethod(f.client, f.ledger, args)
  f.rows.splice(0)
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'identity_mismatch', created_asset_id: 501,
    verified_readback: false, replayed: true })
})

it('rejects an explicit cross-project inventory row before sending', async () => {
  const f = await fixture(publishImage, { initial: [{ ...image(1), scriptId: 999 }] })
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.writes).toEqual([])
})

it.each([null, 'unreadable'])('leaves missing or unreadable new detail %s unconfirmed', async (detail) => {
  const f = await fixture(publishImage, { detail: () => detail })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'unconfirmed', created_asset_id: null })
})

it.each([
  { total: '1', rows: [] }, { rows: [] }, { total: -1, rows: [] }, { total: 0 }, null,
  { total: 2, rows: [image(1), image(1)] }, { total: 0, rows: [image(1)] }, { total: 1, rows: [] },
])('refuses an invalid pre-dispatch inventory %j without sending', async (page) => {
  const f = await fixture(publishImage, { list: () => page })
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.writes).toEqual([])
})

it('refuses repeated or changing pages before any registration', async () => {
  for (const changedTotal of [false, true]) {
    const f = await fixture(publishImage, { list: (_read, page) => ({ total: page === 2 && changedTotal ? 3 : 2,
      rows: [image(changedTotal ? page : 1)] }) })
    await expect(assetMethod(f.client, f.ledger, args, scan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(f.writes).toEqual([])
  }
})

it('refuses page-limit exhaustion and pages larger than the configured size', async () => {
  const f = await fixture(publishImage, { initial: [image(1), image(2)] })
  await expect(assetMethod(f.client, f.ledger, args, { assetRegistrationScan: { pageSize: 1, pageLimit: 1 } }))
    .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  const oversized = await fixture(publishImage, { list: () => ({ total: 2, rows: [image(1), image(2)] }) })
  await expect(assetMethod(oversized.client, oversized.ledger, args, scan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.writes).toEqual([])
  expect(oversized.writes).toEqual([])
})

it('reconciles an interrupted response without repeating the registration', async () => {
  const f = await fixture(async (_body, publish) => { publish(image(501)); throw new Error('connection closed') })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', outcome: 'unknown',
    created_asset_id: 501, replayed: false })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', outcome: 'unknown',
    created_asset_id: 501, replayed: true })
  expect(f.writes).toHaveLength(1)
})

it('reconciles later visibility from the recorded before-inventory without a second POST', async () => {
  const f = await fixture(async () => { throw new Error('connection closed') })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'unconfirmed', outcome: 'unknown' })
  f.rows.push(image(501))
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', created_asset_id: 501, replayed: true })
  expect(f.writes).toHaveLength(1)
})

it('retains the original ID when its current asset is missing or changed', async () => {
  const f = await fixture(publishImage)
  await assetMethod(f.client, f.ledger, args)
  f.rows.splice(0)
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'asset_missing', created_asset_id: 501,
    verified_readback: false, replayed: true })
  f.rows.push(image(501, 'renamed'))
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'identity_mismatch', created_asset_id: 501,
    verified_readback: false, replayed: true })
  expect(f.writes).toHaveLength(1)
})

it('does not replace the first verified ID with a later identical asset', async () => {
  const f = await fixture(publishImage)
  await assetMethod(f.client, f.ledger, args)
  f.rows.push(image(502))
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', created_asset_id: 501,
    new_asset_ids: [], matching_assets: [{ asset_id: 501 }] })
})

it('leaves a legacy ledger without identity receipt read-only', async () => {
  const f = await fixture(publishImage)
  await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register', requestSha256: bodyHash({
    scriptId: args.script_id, assetName: args.asset_name, assetType: args.asset_type, isLocal: 1, url: args.asset_url }) })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'receipt_missing', outcome: 'unknown',
    replayed: true, created_asset_id: null })
  expect(f.requests).toEqual([])
})

it('does not adopt an unrelated request recorded under the same key', async () => {
  const f = await fixture(publishImage)
  await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register', requestSha256: 'other' })
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests).toEqual([])
})

it('resumes a prepared receipt after interruption before the first ledger claim', async () => {
  const f = await fixture(publishImage)
  const failure = vi.spyOn(f.ledger, 'beginChecked').mockRejectedValueOnce(new Error('ledger write failed'))
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toThrow('ledger write failed')
  failure.mockRestore()
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'verified', outcome: 'accepted',
    replayed: false, created_asset_id: 501 })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ replayed: true, created_asset_id: 501 })
  expect(f.writes).toHaveLength(1)
})

it('keeps a concurrent same-key caller pending while the original request is in flight', async () => {
  let release: () => void = () => { throw new Error('Barrier not initialized') }
  let entered: () => void = () => { throw new Error('Barrier not initialized') }
  const sent = new Promise<void>((resolve) => { entered = resolve })
  const finished = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(async (_body, publish) => { entered(); await finished; publish(image(501)) })
  const first = assetMethod(f.client, f.ledger, args)
  try {
    await sent
    expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'unconfirmed', replayed: true })
  } finally { release() }
  expect(await first).toMatchObject({ status: 'verified', created_asset_id: 501 })
  expect(f.writes).toHaveLength(1)
})

it.each([
  ['invalid JSON', '{'], ['unsupported version', JSON.stringify({ version: 2 })],
])('refuses %s in a stored receipt before sending', async (_label, content) => {
  const f = await fixture(publishImage)
  await assetMethod(f.client, f.ledger, args)
  await writeFile(assetRegistrationReceiptPath(f.ledger, args.idempotency_key), content)
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.writes).toHaveLength(1)
})

it.each([
  ['key_sha256', 'b'.repeat(64)], ['request_sha256', `sha256:${'b'.repeat(64)}`], ['script_id', 999],
] as const)('refuses a stored receipt whose %s does not match the request', async (field, value) => {
  const f = await fixture(publishImage)
  await assetMethod(f.client, f.ledger, args)
  const path = assetRegistrationReceiptPath(f.ledger, args.idempotency_key)
  const receipt = JSON.parse(await readFile(path, 'utf8')) as Row
  await writeFile(path, JSON.stringify({ ...receipt, [field]: value }))
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.writes).toHaveLength(1)
})

it('refuses a receipt whose verified ID existed before registration', async () => {
  const f = await fixture(publishImage)
  await assetMethod(f.client, f.ledger, args)
  const path = assetRegistrationReceiptPath(f.ledger, args.idempotency_key)
  const receipt = JSON.parse(await readFile(path, 'utf8')) as Row
  await writeFile(path, JSON.stringify({ ...receipt, before_asset_ids: [501] }))
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
})

it('propagates an unreadable receipt instead of treating it as absent', async () => {
  const f = await fixture(publishImage)
  await mkdir(assetRegistrationReceiptPath(f.ledger, args.idempotency_key), { recursive: true })
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ name: 'JubianError', code: 'CONTRACT_CHANGED',
    cause: { code: 'EISDIR' } })
  expect(f.requests).toEqual([])
})

it.each(['bad', 'http://media.example/image.png', 'https://name:secret@media.example/image.png',
  'https://media.example/image.png#fragment', 'https://media.example/\\image.png'])('refuses invalid image URL %s before reads', async (url) => {
  const f = await fixture(publishImage)
  await expect(assetMethod(f.client, f.ledger, { ...args, asset_url: url })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.requests).toEqual([])
})

it.each([{ script_id: 0 }, { asset_type: 4 }, { asset_name: '' }])('refuses invalid direct image registration %j', async (changes) => {
  const f = await fixture(publishImage)
  await expect(registerImageAsset(f.client, f.ledger, { ...args, ...changes }, scan.assetRegistrationScan))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.requests).toEqual([])
})

it('resolves bounded inventory configuration and rejects unsupported values', () => {
  expect(resolveAssetRegistrationScanOptions()).toEqual({ pageSize: 1000, pageLimit: 100 })
  expect(resolveAssetRegistrationScanOptions({ assetRegistrationPageSize: 1, assetRegistrationPageLimit: 2 }))
    .toEqual({ pageSize: 1, pageLimit: 2 })
  for (const value of [0, 1001, 1.5, Number.NaN]) {
    expect(() => resolveAssetRegistrationScanOptions({ assetRegistrationPageSize: value })).toThrow()
  }
  for (const value of [0, 101, 1.5, Number.NaN]) {
    expect(() => resolveAssetRegistrationScanOptions({ assetRegistrationPageLimit: value })).toThrow()
  }
})

function barrier() {
  let release: () => void = () => { throw new Error('Barrier not initialized') }
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

it('lets one same-key caller take over before ledger claim and replays the original caller', async () => {
  const claimStarted = barrier(), resumeClaim = barrier()
  const f = await fixture(publishImage)
  const begin = f.ledger.beginChecked.bind(f.ledger)
  const held = vi.spyOn(f.ledger, 'beginChecked').mockImplementationOnce(async (...values) => {
    claimStarted.release()
    await resumeClaim.promise
    return await begin(...values)
  })
  const original = assetMethod(f.client, f.ledger, args)
  await claimStarted.promise
  let takeover: Record<string, unknown>
  let resumed: Record<string, unknown>
  try {
    takeover = await assetMethod(f.client, new JubianLedger({ root: f.ledger.root }), args)
  } finally {
    resumeClaim.release()
    resumed = await original
    held.mockRestore()
  }
  expect(takeover).toMatchObject({ status: 'verified', created_asset_id: 501, replayed: false })
  expect(resumed).toMatchObject({ status: 'verified', created_asset_id: 501, replayed: true })
  expect(f.writes).toHaveLength(1)
})

it('does not send from a prepared receipt when a durable intent already exists', async () => {
  const f = await fixture(publishImage)
  const failure = vi.spyOn(f.ledger, 'beginChecked').mockRejectedValueOnce(new Error('interrupted before claim'))
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toThrow('interrupted before claim')
  failure.mockRestore()
  await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register', scriptId: args.script_id,
    requestSha256: bodyHash({ scriptId: args.script_id, assetName: args.asset_name, assetType: args.asset_type,
      isLocal: 1, url: args.asset_url }) })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'unconfirmed', outcome: 'unknown',
    created_asset_id: null, replayed: true })
  expect(f.writes).toEqual([])
})

it('reuses a receipt committed while the first caller was reading its initial inventory', async () => {
  const readStarted = barrier(), resumeRead = barrier()
  const f = await fixture(publishImage, { list: async (read, _page, data) => {
    if (read === 1) { readStarted.release(); await resumeRead.promise }
    return data
  } })
  const first = assetMethod(f.client, f.ledger, args)
  await readStarted.promise
  try {
    expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ created_asset_id: 501, replayed: false })
  } finally { resumeRead.release() }
  expect(await first).toMatchObject({ created_asset_id: 501, replayed: true })
  expect(f.writes).toHaveLength(1)
})

it('does not send when a legacy ledger claim appears during inventory inspection', async () => {
  const readStarted = barrier(), resumeRead = barrier()
  const f = await fixture(publishImage, { list: async (_read, _page, data) => {
    readStarted.release(); await resumeRead.promise; return data
  } })
  const pending = assetMethod(f.client, f.ledger, args)
  await readStarted.promise
  try {
    await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register', requestSha256: bodyHash({
      scriptId: args.script_id, assetName: args.asset_name, assetType: args.asset_type, isLocal: 1, url: args.asset_url }) })
  } finally { resumeRead.release() }
  expect(await pending).toMatchObject({ status: 'receipt_missing', replayed: true })
  expect(f.writes).toEqual([])
})

it('keeps the identity another same-key reconciler verified while detail was in flight', async () => {
  const readStarted = barrier(), resumeRead = barrier()
  let detailReads = 0
  const f = await fixture(publishImage, { detail: async (_id, row) => {
    if (++detailReads === 1) { readStarted.release(); await resumeRead.promise }
    return row
  } })
  const first = assetMethod(f.client, f.ledger, args)
  await readStarted.promise
  try {
    expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ created_asset_id: 501, replayed: true })
  } finally { resumeRead.release() }
  expect(await first).toMatchObject({ created_asset_id: 501, replayed: false })
  expect(f.writes).toHaveLength(1)
})

it('does not overwrite the first committed identity with a later in-flight candidate', async () => {
  const readStarted = barrier(), resumeRead = barrier()
  let detailReads = 0
  const f = await fixture(publishImage, { detail: async (_id, row) => {
    if (++detailReads === 1) { readStarted.release(); await resumeRead.promise }
    return row
  } })
  const first = assetMethod(f.client, f.ledger, args)
  await readStarted.promise
  try {
    f.rows.splice(0, f.rows.length, image(502))
    expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ created_asset_id: 502, replayed: true })
  } finally { resumeRead.release() }
  expect(await first).toMatchObject({ created_asset_id: 502 })
  expect(f.writes).toHaveLength(1)
})

it('reports lost receipt evidence without claiming the post-send candidate', async () => {
  const f = await fixture(publishImage, { detail: async (_id, row) => {
    await rm(assetRegistrationReceiptPath(f.ledger, args.idempotency_key))
    return row
  } })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ status: 'unconfirmed', created_asset_id: null,
    reconciliation_error: { name: 'JubianError', code: 'CONTRACT_CHANGED' } })
  expect(f.writes).toHaveLength(1)
})

it('leaves a post-dispatch receipt read failure unconfirmed without another registration', async () => {
  const f = await fixture(publishImage, { detail: async (_id, row) => {
    const path = assetRegistrationReceiptPath(f.ledger, args.idempotency_key)
    await rm(path)
    await mkdir(path)
    return row
  } })
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ outcome: 'accepted', status: 'unconfirmed',
    verified_readback: false, created_asset_id: null, reconciliation_error: { name: 'JubianError', code: 'CONTRACT_CHANGED' } })
  expect(f.writes).toHaveLength(1)
})

it('reports an unavailable receipt directory as a typed failure before dispatch', async () => {
  const f = await fixture(publishImage, { list: async (_read, _page, data) => {
    await writeFile(join(f.ledger.root, 'asset-registration-receipts'), 'blocks the directory')
    return data
  } })
  await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ name: 'JubianError', code: 'CONTRACT_CHANGED',
    cause: expect.any(Error) })
  expect(f.writes).toEqual([])
})

it('reports a receipt write failure as typed evidence and keeps a post-send write failure unconfirmed', async () => {
  const f = await fixture(publishImage)
  const originalWrite = AtomicWrite.writeFileAtomic
  let writes = 0
  const failure = vi.spyOn(AtomicWrite, 'writeFileAtomic').mockImplementation(async (...values) => {
    if (++writes === 2) throw Object.assign(new Error('receipt disk failure'), { code: 'EIO' })
    await originalWrite(...values)
  })
  try {
    expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ outcome: 'accepted', status: 'unconfirmed',
      created_asset_id: null, verified_readback: false, reconciliation_error: { name: 'JubianError', code: 'CONTRACT_CHANGED' } })
  } finally { failure.mockRestore() }
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ replayed: true, created_asset_id: 501, status: 'verified' })
  expect(f.writes).toHaveLength(1)
})

it('does not dispatch when receipt writer coordination fails', async () => {
  const f = await fixture(publishImage)
  const failure = vi.spyOn(AtomicWrite, 'withFileLock').mockRejectedValueOnce(new Error('lock unavailable'))
  try {
    await expect(assetMethod(f.client, f.ledger, args)).rejects.toMatchObject({ name: 'JubianError', code: 'CONTRACT_CHANGED',
      cause: expect.any(Error) })
  } finally { failure.mockRestore() }
  expect(f.writes).toEqual([])
})

it('does not turn an unexpected readback defect into a successful registration', async () => {
  const f = await fixture(publishImage)
  const requestAsset = f.client.request.bind(f.client), defect = new TypeError('unexpected readback defect')
  const failure = vi.spyOn(f.client, 'request').mockImplementation(async (value) => {
    if (value.path === '/aigc/asset/501') throw defect
    return await requestAsset(value)
  })
  try { await expect(assetMethod(f.client, f.ledger, args)).rejects.toBe(defect) }
  finally { failure.mockRestore() }
  expect(await assetMethod(f.client, f.ledger, args)).toMatchObject({ replayed: true, created_asset_id: 501 })
  expect(f.writes).toHaveLength(1)
})
