/** Character regeneration reuses the adopted image, not an arbitrary generated candidate. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { videoMethod } from '../src/methods.ts'
import type { MethodArgs } from '../src/methods.ts'
import { createImageReferenceResolver, resolveImageReferenceScanOptions } from '../src/image-continuity.ts'

const catalogue = [{ id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI', unitPrice: 0.12, unit: '张',
  videoStandards: [{ id: 362, ratio: '16:9', resolution: '1K', width: 2048, height: 1152 }] }]
const adopted = { id: 501, assetId: 77, assetName: '演员甲', assetUrl: 'https://media.example.test/adopted.png',
  assetType: 1, isUsed: 1, hsAssetStatus: 'Active' }
const request = { method: 'image_generate', script_id: 2708, asset_name: '演员甲（冬装）', asset_type: 1,
  parent_asset_id: 77, prompt: '真人写实，保留同一人的面孔，改穿冬装。', idempotency_key: 'winter' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jubian-image-continuity-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  await writeFile(join(root, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '1000', unit: 'CNY', estimates: { image_generate: '1' } } } }))
  const ledger = new JubianLedger({ root })
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const state = { materials: [structuredClone(adopted)], assets: [
    { id: 77, scriptId: 2708, assetType: 1, assetName: '演员甲', delFlag: '0' },
    { id: 78, scriptId: 2708, assetType: 1, assetName: '演员乙', delFlag: '0' },
  ], incomplete: false }
  const client = new JubianClient({ credential: async () => 'fixture-token', fetch: async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : input.toString())
    const endpoint = address.pathname.match(/\/(?:aigc|model)\/.*$/u)?.[0] ?? address.pathname
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ method, path: endpoint + address.search, ...(body === undefined ? {} : { body }) })
    let data: unknown
    if (endpoint.endsWith('getSelectList')) data = catalogue
    else if (endpoint === '/aigc/asset/list') data = { rows: state.assets, total: state.assets.length }
    else if (endpoint === '/aigc/material/list') {
      const page = Number(address.searchParams.get('pageNum'))
      const size = Number(address.searchParams.get('pageSize'))
      data = { rows: state.materials.slice((page - 1) * size, page * size),
        total: state.materials.length + Number(state.incomplete) }
    } else if (endpoint === '/aigc/asset' && ['POST', 'PUT'].includes(method)) data = Number(body?.id ?? 88)
    else if (/\/aigc\/asset\/\d+$/u.test(endpoint)) data = {
      id: Number(endpoint.split('/').at(-1)), assetType: 1, hsAssetStatus: 'Active' }
    else if (endpoint.endsWith('getGeneratedImageByAssetId')) data = [{ id: 600,
      assetId: Number(address.searchParams.get('assetId')), assetUrl: 'https://media.example.test/new-candidate.png',
      isUsed: 0, hsAssetStatus: 'Active' }]
    else throw new Error(`Unexpected fixture request ${method} ${address.pathname}`)
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  return { client, ledger, calls, state }
}

function paid(calls: { method: string; path: string; body?: Record<string, unknown> }[]) {
  return calls.filter(call => call.path === '/aigc/asset' && ['POST', 'PUT'].includes(call.method))
}

function references(calls: ReturnType<typeof paid>) {
  return calls.map(call => (JSON.parse(String(call.body?.modelConfig)) as { materialList: unknown }).materialList)
}

it('inherits the unique adopted image when regenerating a character without references', async () => {
  const { client, ledger, calls } = await fixture()
  const before = structuredClone(request)
  const result = await videoMethod(client, ledger, request, { signal: new AbortController().signal })
  expect(references(paid(calls))).toEqual([[{ materialUrl: adopted.assetUrl, materialType: 'image', sortOrder: 1 }]])
  expect(result.identity_reference).toMatchObject({ status: 'inherited', asset_id: 77, material_id: 501, url: adopted.assetUrl })
  expect(request).toEqual(before)
  expect(calls.filter(call => call.path.includes('/confirm/'))).toEqual([])
})

it.each([{ refs: [] }, { refs: ['https://media.example.test/explicit.png'] }])('preserves explicit reference intent $refs', async ({ refs }) => {
  const { client, ledger, calls } = await fixture()
  const result = await videoMethod(client, ledger, { ...request, references: refs })
  expect(references(paid(calls))).toEqual([refs.map((materialUrl, index) => ({ materialUrl, materialType: 'image', sortOrder: index + 1 }))])
  expect(result.identity_reference).toMatchObject({ status: refs.length ? 'explicit' : 'explicit_none', material_id: null })
  expect(calls.filter(call => call.path.includes('/list?'))).toEqual([])
})

it.each([2, 3])('does not add an automatic character reference to category %i', async (assetType) => {
  const { client, ledger, calls } = await fixture()
  const result = await videoMethod(client, ledger, { ...request, asset_type: assetType })
  expect(references(paid(calls))).toEqual([[]])
  expect(result.identity_reference).toMatchObject({ status: 'not_applicable' })
  expect(calls.filter(call => call.path.includes('/list?'))).toEqual([])
})

it('keeps first-time character creation unanchored and reports the missing reference', async () => {
  const { client, ledger, calls } = await fixture()
  const { parent_asset_id: _parent, ...args } = request
  const result = await videoMethod(client, ledger, args)
  expect(references(paid(calls))).toEqual([[]])
  expect(result.identity_reference).toMatchObject({ status: 'missing', asset_id: null, material_id: null })
  expect(calls.filter(call => call.path.includes('/list?'))).toEqual([])
})

it.each(['none', 'inactive', 'unselected', 'foreign-parent', 'no-status'] as const)('does not invent an adopted reference for %s material', async (stateName) => {
  const { client, ledger, calls, state } = await fixture()
  if (stateName === 'none') state.materials = []
  if (stateName === 'inactive') state.materials[0]!.hsAssetStatus = 'Submitted'
  if (stateName === 'unselected') state.materials[0]!.isUsed = 0
  if (stateName === 'foreign-parent') state.materials[0]!.assetId = 78
  if (stateName === 'no-status') delete (state.materials[0] as Partial<typeof adopted>).hsAssetStatus
  const result = await videoMethod(client, ledger, request)
  expect(references(paid(calls))).toEqual([[]])
  expect(result.identity_reference).toMatchObject({ status: 'missing', asset_id: 77, material_id: null })
})

it('refuses ambiguous adopted images before a paid write or ledger intent', async () => {
  const { client, ledger, calls, state } = await fixture()
  state.materials.push({ ...adopted, id: 502 })
  await expect(videoMethod(client, ledger, request)).rejects.toThrow(/adopted|采用/u)
  expect(paid(calls)).toEqual([])
  expect(await ledger.records()).toEqual([])
})

it.each(['foreign-project', 'wrong-category', 'deleted-parent', 'missing-parent', 'insecure-url', 'incomplete-page'] as const)
('does not submit with unsafe inheritance evidence: %s', async (fault) => {
  const { client, ledger, calls, state } = await fixture()
  if (fault === 'foreign-project') state.assets[0]!.scriptId = 999
  if (fault === 'wrong-category') state.assets[0]!.assetType = 2
  if (fault === 'deleted-parent') state.assets[0]!.delFlag = '1'
  if (fault === 'missing-parent') state.assets = []
  if (fault === 'insecure-url') state.materials[0]!.assetUrl = 'http://media.example.test/unsafe.png'
  if (fault === 'incomplete-page') state.incomplete = true
  await expect(videoMethod(client, ledger, request)).rejects.toThrow()
  expect(paid(calls)).toEqual([])
  expect(await ledger.records()).toEqual([])
})

it('finds the adopted image beyond the first material page', async () => {
  const { client, ledger, calls, state } = await fixture()
  state.materials = Array.from({ length: 1000 }, (_, i) => ({ ...adopted, id: i + 1000, assetId: 78 }))
  state.materials.push(adopted)
  const result = await videoMethod(client, ledger, request)
  expect(result.identity_reference).toMatchObject({ status: 'inherited', material_id: 501 })
  expect(calls.filter(call => call.path.includes('/material/list?'))).toHaveLength(2)
})

it('replays unchanged references without payment and refuses changed adoption for the same key', async () => {
  const { client, ledger, calls, state } = await fixture()
  await videoMethod(client, ledger, request)
  expect(await videoMethod(client, ledger, request)).toMatchObject({ replayed: true, identity_reference: { status: 'unknown' } })
  state.materials[0] = { ...adopted, id: 502, assetUrl: 'https://media.example.test/replaced.png' }
  await expect(videoMethod(client, ledger, request)).rejects.toThrow(/different image request/u)
  expect(paid(calls)).toHaveLength(1)
  expect(await ledger.records()).toHaveLength(1)
})

it('resolves every batch reference before payment and keeps that resolution for the fresh send', async () => {
  const { client, ledger, calls } = await fixture()
  const args: MethodArgs = { method: 'image_generate_batch', script_id: 2708, items: [request] }
  const result = await videoMethod(client, ledger, args)
  expect(references(paid(calls))).toEqual([[{ materialUrl: adopted.assetUrl, materialType: 'image', sortOrder: 1 }]])
  expect(calls.filter(call => call.path.includes('/material/list?'))).toHaveLength(1)
  expect(result.results).toMatchObject([{ identity_reference: { status: 'inherited', material_id: 501 } }])
})

it('refuses the whole batch before payment when a later character has ambiguous references', async () => {
  const { client, ledger, calls, state } = await fixture()
  state.materials.push({ ...adopted, id: 502, assetId: 78 }, { ...adopted, id: 503, assetId: 78 })
  await expect(videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708, items: [request,
    { ...request, asset_name: '演员乙', parent_asset_id: 78, idempotency_key: 'second' }] })).rejects.toThrow()
  expect(paid(calls)).toEqual([])
  expect(await ledger.records()).toEqual([])
})

it('refuses a later recorded key with changed adoption before any fresh batch item is reserved', async () => {
  const { client, ledger, calls, state } = await fixture()
  let elapsed = 0
  const deps = { image: { activeTimeoutMs: 100, pollIntervalMs: 100,
    now: () => elapsed, sleep: async (ms: number) => { elapsed += ms } } }
  state.materials.push({ ...adopted, id: 502, assetId: 78 })
  await videoMethod(client, ledger, request, deps)
  const records = await ledger.records()
  const writes = paid(calls).length
  state.materials[0] = { ...adopted, id: 503, assetUrl: 'https://media.example.test/changed-adoption.png' }
  await expect(videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708, items: [
    { ...request, parent_asset_id: 78, asset_name: '演员乙', idempotency_key: 'fresh-first' }, request,
  ] }, deps)).rejects.toThrow(/different image request/u)
  expect(paid(calls)).toHaveLength(writes)
  expect(await ledger.find('fresh-first')).toBeUndefined()
  expect(await ledger.records()).toEqual(records)
})

it.each(['method', 'project'] as const)('checks a later recorded key %s before any fresh batch reservation', async (mismatch) => {
  const { client, ledger, calls } = await fixture()
  const { parent_asset_id: _parent, ...fresh } = request
  await ledger.begin({ idempotencyKey: request.idempotency_key,
    method: mismatch === 'method' ? 'asset_register' : 'image_generate',
    scriptId: mismatch === 'project' ? 999 : 2708, requestSha256: 'sha256:' + 'a'.repeat(64) })
  const records = await ledger.records()
  await expect(videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708, items: [
    { ...fresh, asset_name: '新角色', idempotency_key: 'fresh-first' }, request,
  ] })).rejects.toThrow(/different image request/u)
  expect(paid(calls)).toEqual([])
  expect(await ledger.find('fresh-first')).toBeUndefined()
  expect(await ledger.records()).toEqual(records)
})

it('allows an unchanged recorded item beside a fresh batch item without paying for it again', async () => {
  const { client, ledger, calls, state } = await fixture()
  state.materials.push({ ...adopted, id: 502, assetId: 78 })
  let elapsed = 0
  const deps = { image: { activeTimeoutMs: 100, pollIntervalMs: 100,
    now: () => elapsed, sleep: async (ms: number) => { elapsed += ms } } }
  await videoMethod(client, ledger, request, deps)
  const result = await videoMethod(client, ledger, { method: 'image_generate_batch', script_id: 2708, items: [
    { ...request, parent_asset_id: 78, asset_name: '演员乙', idempotency_key: 'fresh-first' }, request,
  ] }, deps)
  expect(result.results).toMatchObject([{ replayed: false, outcome: 'accepted' },
    { replayed: true, identity_reference: { status: 'unknown' } }])
  expect(paid(calls)).toHaveLength(2)
  expect(await ledger.records()).toHaveLength(2)
})

it.each(['', 'not-a-url', 'https://user@example.test/face.png', 'https://:pass@example.test/face.png',
  'https://media.example.test/face.png#section', 'https://media.example.test/face image.png'])
('refuses an unusable adopted URL before payment: %s', async (url) => {
  const { client, ledger, calls, state } = await fixture()
  state.materials[0]!.assetUrl = url
  await expect(videoMethod(client, ledger, request)).rejects.toThrow(/HTTPS/u)
  expect(paid(calls)).toEqual([])
  expect(await ledger.records()).toEqual([])
})

it('does not use missing adopted URL metadata as a reference', async () => {
  const { client, ledger, calls, state } = await fixture()
  delete (state.materials[0] as Partial<typeof adopted>).assetUrl
  await expect(videoMethod(client, ledger, request)).rejects.toThrow(/HTTPS/u)
  expect(paid(calls)).toEqual([])
})

it('accepts explicit bounded pagination settings', () => {
  expect(resolveImageReferenceScanOptions()).toEqual({ pageSize: 1000, pageLimit: 100 })
  expect(resolveImageReferenceScanOptions({ imageReferencePageSize: 20, imageReferencePageLimit: 5 }))
    .toEqual({ pageSize: 20, pageLimit: 5 })
})

it.each([
  { imageReferencePageSize: 0.5 }, { imageReferencePageSize: 0 }, { imageReferencePageSize: 1001 },
  { imageReferencePageLimit: 0.5 }, { imageReferencePageLimit: 0 }, { imageReferencePageLimit: 101 },
])('refuses invalid acquisition bounds %j', (config) => {
  expect(() => resolveImageReferenceScanOptions(config)).toThrow(/imageReference/u)
})

it.each(['image_generate', 'image_generate_batch'])('rejects an already-aborted %s before any read or write', async (method) => {
  const { client, ledger, calls } = await fixture()
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled'))
  await expect(videoMethod(client, ledger, method === 'image_generate' ? request
    : { method, script_id: 2708, items: [request] }, { signal: controller.signal })).rejects.toThrow('caller cancelled')
  expect(calls).toEqual([])
  expect(await ledger.records()).toEqual([])
})

it('checks cancellation before its first inventory page', async () => {
  const { client, calls } = await fixture()
  const controller = new AbortController()
  controller.abort(new Error('inventory cancelled'))
  const resolve = createImageReferenceResolver(client, resolveImageReferenceScanOptions(), controller.signal)
  await expect(resolve({ scriptId: 2708, assetType: 1, parentAssetId: 77 })).rejects.toThrow('inventory cancelled')
  expect(calls).toEqual([])
})
