/** Exact-target inspection, stale protection and replay of storyboard deletion. */
import { appendFile, mkdtemp, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { JubianRequest, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { storyboardMethod } from '../src/methods.ts'
import { deletionInspectionReason, storyboardDeleteMethod } from '../src/storyboard-delete.ts'
import { bodyHash } from '../src/write.ts'

let root: string
let client: JubianClient
let ledger: JubianLedger
let boards: Record<string, unknown>[]
let linked: Record<string, unknown>[]
let linkedEnvelope: Record<string, unknown> | undefined
let deletes: string[]
let interrupted: boolean
let beforeRequest: ((path: string, method: string) => Promise<void>) | undefined
let boardOverride: ((id: number) => unknown) | undefined
let tasksOverride: unknown
let retainDeleted: boolean
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-delete-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  boards = [1, 2].map(id => ({ id, scriptId: 2708, episodeId: null, episodeCount: 2,
    storyboardName: `旧测试${id}`, isGenerate: 1,
    modelConfig: JSON.stringify({ prompt: '测试内容', duration: 8.7 }), storyboardMaterialList: [] }))
  linked = []; linkedEnvelope = undefined; deletes = []; interrupted = false
  beforeRequest = undefined; boardOverride = undefined; tasksOverride = undefined; retainDeleted = false
  client = new JubianClient({ credential: async () => 'mock-token', fetch: async (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url.toString()).pathname.replace('/prod-api', '')
    await beforeRequest?.(path, String(init?.method))
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path.startsWith('/aigc/storyboard/byStoryboard/')) return answer(tasksOverride ?? linkedEnvelope ?? linked)
    if (init?.method === 'GET') {
      const id = Number(path.split('/').pop())
      return answer(boardOverride === undefined ? boards.find(board => board.id === id) ?? null : boardOverride(id))
    }
    if (init?.method === 'DELETE') {
      deletes.push(path)
      if (!retainDeleted) boards = boards.filter(board => board.id !== Number(path.split('/').pop()))
      if (interrupted) throw new Error('response lost after server deletion')
      return answer(null)
    }
    throw new Error(`Unexpected request ${String(init?.method)} ${path}`)
  } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const preview = (extra = {}) => storyboardMethod(client, ledger, {
  method: 'delete_preview', script_id: 2708, project_dir: root, storyboard_ids: [1, 2],
  delete_reason: '删除这两张旧测试卡', authorization_basis: '用户要求清理这两张旧测试卡', ...extra,
})
const apply = (plan: Record<string, unknown>, extra = {}) => storyboardMethod(client, ledger, {
  method: 'delete_apply', script_id: 2708, project_dir: root, preview_path: String(plan.preview_path),
  idempotency_key: String(plan.fingerprint), checked_storyboard_ids: [1, 2], ...extra,
})

it.each([null, false, [], 'delete_apply', {}, { method: 'get' }])('leaves non-deletion inspection input untouched: %j', (value) => {
  expect(deletionInspectionReason(value)).toBeUndefined()
})

it.each([
  { method: 'delete_apply' }, { method: 'delete_apply', preview_path: 9, checked_storyboard_ids: [1] },
  { method: 'delete_apply', preview_path: 'preview', checked_storyboard_ids: 'all' },
  { method: 'delete_apply', preview_path: 'preview', checked_storyboard_ids: [] },
])('requires an explicit reviewed deletion preview: %j', async (args) => {
  expect(deletionInspectionReason(args)).toContain('删除检查')
  expect(deletes).toEqual([])
})

it.each([undefined, [], [0], [1, 1], [1, 2, 3]].map(value => ({ value })))('refuses invalid exact target sets before transport: %j', async ({ value }) => {
  await expect(storyboardDeleteMethod(client, ledger, {
    method: 'delete_preview', script_id: 2708, project_dir: root, ...(value === undefined ? {} : { storyboard_ids: value }),
    delete_reason: 'authorized', authorization_basis: 'user requested',
  }, { maxItems: 2, concurrency: 1 })).rejects.toThrow()
  expect(deletes).toEqual([])
})

it('refuses malformed authorization and unsupported deletion methods before mutation', async () => {
  await expect(preview({ delete_reason: ' ' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(storyboardMethod(client, ledger, { method: 'delete_apply', script_id: 2708, project_dir: root }))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(storyboardDeleteMethod(client, ledger, { method: 'get', script_id: 2708, project_dir: root },
    { maxItems: 2, concurrency: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(deletes).toEqual([])
})

it.each([false, [], 'unreadable'])('refuses non-record provider cards: %j', async (value) => {
  boardOverride = () => value
  await expect(preview()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(deletes).toEqual([])
})

it('refuses an absent card and a mismatched returned card identity', async () => {
  boards = []
  await expect(preview()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  boardOverride = () => ({ id: 99, scriptId: 2708 })
  await expect(preview()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
})

it.each([
  {}, { rows: 'unreadable', total: 0 }, { rows: [null], total: 1 },
  { rows: [], total: '0' }, { rows: [], total: 0.5 }, { rows: [], total: 1 },
])('refuses incomplete or unreadable linked task envelopes: %j', async (value) => {
  tasksOverride = value
  await expect(preview()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(deletes).toEqual([])
})

it.each([
  { modelConfig: '{bad json', storyboardMaterialList: '{bad json', material_count: null },
  { modelConfig: null, storyboardMaterialList: null, material_count: 0 },
  { modelConfig: [], storyboardMaterialList: undefined, material_count: 0 },
  { modelConfig: true, storyboardMaterialList: [1, 2], material_count: 2 },
])('inspects old card data without discarding its unreadable fields: %j', async ({ modelConfig, storyboardMaterialList, material_count }) => {
  boards = [1, 2].map(id => ({ id, scriptId: 2708, modelConfig, storyboardMaterialList }))
  const plan = await preview()
  expect(plan).toMatchObject({ targets: [
    { name: null, episode_id: null, duration: null, prompt: null, material_count },
    { name: null, episode_id: null, duration: null, prompt: null, material_count },
  ] })
  expect(await apply(plan)).toMatchObject({ status: 'deleted' })
})

it.each(['resultVideoUrl', 'videoUrl', 'tosVideoUrl'])('requires media authorization when an inspected card has %s', async (field) => {
  boards[0]![field] = 'https://media.example/result.mp4'
  const plan = await preview()
  expect(plan.requires_generated_authorization).toBe(true)
  await expect(apply(plan)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it.each([
  { version: 2 }, { operation: 'storyboard_edit' }, { include_generated_media: 'all' }, { targets: {} },
  { targets: [null] }, { targets: [] }, { delete_reason: 8 }, { authorization_basis: false },
])('refuses corrupted persisted deletion preview fields: %j', async (change) => {
  const plan = await preview()
  await writeFile(String(plan.preview_path), JSON.stringify({ ...plan, ...change }))
  await expect(apply(plan)).rejects.toThrow()
  expect(deletes).toEqual([])
})

it.each([
  { snapshot_hash: 7 }, { tasks: 'unreadable' }, { active_generation: null }, { has_generated_media: null },
  { tasks: [false] }, { storyboard_id: 0 },
])('refuses corrupted persisted inspected targets: %j', async (change) => {
  const plan = await preview()
  const targets = plan.targets as Record<string, unknown>[]
  await writeFile(String(plan.preview_path), JSON.stringify({ ...plan, targets: [{ ...targets[0], ...change }, targets[1]] }))
  await expect(apply(plan)).rejects.toThrow()
  expect(deletes).toEqual([])
})

it('refuses reordered or fingerprint-tampered deletion previews', async () => {
  const plan = await preview()
  const targets = plan.targets as Record<string, unknown>[]
  await writeFile(String(plan.preview_path), JSON.stringify({ ...plan, targets: [...targets].reverse() }))
  await expect(apply(plan)).rejects.toThrow('ordered')
  await writeFile(String(plan.preview_path), JSON.stringify({ ...plan, fingerprint: 'tampered' }))
  await expect(apply(plan)).rejects.toThrow('fingerprint')
})

it.each(['project', 'key'] as const)('refuses a valid preview whose %s differs from the invocation', async (field) => {
  const plan = await preview()
  const { fingerprint: _fingerprint, preview_path: _path, paid_requests: _paid, status: _status,
    requires_generated_authorization: _generated, next: _next, ...unsigned } = plan
  const changed = field === 'project' ? { ...unsigned, script_id: 999 } : { ...unsigned, delete_reason: 'another approved scope' }
  const fingerprint = stableSha256(changed)
  const path = field === 'project' ? join(root, 'video_tasks', `${fingerprint}.storyboard-delete.prepared.json`) : String(plan.preview_path)
  await writeFile(path, JSON.stringify({ ...changed, fingerprint }))
  await expect(apply(plan, { preview_path: path, ...(field === 'project' ? { idempotency_key: fingerprint } : {}) }))
    .rejects.toThrow('mismatch')
  expect(deletes).toEqual([])
})

/** Record a reviewed deletion intent without claiming that a provider response was received. */
async function recordPlan(plan: Record<string, unknown>): Promise<void> {
  const key = String(plan.fingerprint)
  const target = (plan.targets as Record<string, unknown>[])[0]!
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_remove', scriptId: 2708, requestSha256: `sha256:${key}` })
  await ledger.begin({ idempotencyKey: `${key}:1`, method: 'storyboard_remove', scriptId: 2708,
    requestSha256: bodyHash({ storyboard_id: 1, script_id: 2708, snapshot_hash: target.snapshot_hash }) })
}

/** A replaceable client implementation that delegates transport until its readback fault is enabled. */
class ReadbackFailureClient extends JubianClient {
  private enabled: boolean
  constructor(private readonly delegate: JubianClient, afterDelete: boolean) {
    super({ credential: async () => 'unused-delegate-token' })
    this.enabled = !afterDelete
  }
  override async request(request: JubianRequest): Promise<JubianResponse> {
    if (this.enabled && request.method === 'GET' && request.path === '/aigc/storyboard/1') throw new Error('replacement dependency stopped')
    const response = await this.delegate.request(request)
    if (request.method === 'DELETE') this.enabled = true
    return response
  }
}

it('replays unsettled attempts as readback only and reports cards that are still present', async () => {
  const plan = await preview()
  await recordPlan(plan)
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [
    { storyboard_id: 1, status: 'still_present', response_status: 'unknown', verified_readback: false },
    { storyboard_id: 2, status: 'not_attempted', verified_readback: false },
  ] })
  expect(deletes).toEqual([])
})

it.each(['transport', 'replacement-dependency'] as const)('preserves replay identity when %s prevents readback', async (failure) => {
  const plan = await preview()
  await recordPlan(plan)
  if (failure === 'transport') {
    beforeRequest = async () => { throw new Error('offline') }
  } else {
    client = new ReadbackFailureClient(client, false)
  }
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [
    { storyboard_id: 1, status: 'unknown', response_status: 'unknown', verified_readback: false,
      error: failure === 'transport' ? 'NETWORK_ERROR' : 'READBACK_FAILED' },
    { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toEqual([])
})

it('reconciles another ledger instance winning the plan claim during preflight', async () => {
  const plan = await preview()
  const other = new JubianLedger({ root: join(root, 'ledger') })
  let reads = 0
  beforeRequest = async (path) => {
    if (!path.includes('/byStoryboard/') || ++reads !== 2) return
    const key = String(plan.fingerprint)
    await other.begin({ idempotencyKey: key, method: 'storyboard_remove', scriptId: 2708, requestSha256: `sha256:${key}` })
  }
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [
    { storyboard_id: 1, status: 'not_attempted' }, { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toEqual([])
})

it.each(['accepted', 'unsettled'] as const)('stops the batch when another writer has an %s target claim', async (outcome) => {
  const plan = await preview()
  let reads = 0
  beforeRequest = async (path) => {
    if (!path.includes('/byStoryboard/') || ++reads !== 3) return
    const key = String(plan.fingerprint)
    const target = (plan.targets as Record<string, unknown>[])[0]!
    await ledger.begin({ idempotencyKey: `${key}:1`, method: 'storyboard_remove', scriptId: 2708,
      requestSha256: bodyHash({ storyboard_id: 1, script_id: 2708, snapshot_hash: target.snapshot_hash }) })
    if (outcome === 'accepted') await ledger.settle(`${key}:1`, {
      httpStatus: 200, applicationCode: 200, responseSha256: 'sha256:other-response', outcome: 'accepted',
    })
  }
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
    { storyboard_id: 1, status: 'still_present', response_status: outcome === 'accepted' ? 'accepted' : 'unknown' },
    { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toEqual([])
})

it('stops if a card changes after batch preflight but before its deletion inspection', async () => {
  const plan = await preview()
  let reads = 0
  beforeRequest = async (path, method) => {
    if (method === 'GET' && path === '/aigc/storyboard/1' && ++reads === 2) boards[0]!.storyboardName = 'new accepted content'
  }
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
    { storyboard_id: 1, status: 'stale', verified_readback: false }, { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toEqual([])
})

it('reports an accepted deletion separately when its card remains visible on readback', async () => {
  const plan = await preview()
  retainDeleted = true
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
    { storyboard_id: 1, status: 'still_present', response_status: 'accepted', verified_readback: false },
    { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toEqual(['/aigc/storyboard/1'])
})

it.each(['transport', 'ledger-io'] as const)('retains an unknown target claim when %s interrupts the write phase', async (failure) => {
  const plan = await preview()
  let reads = 0
  beforeRequest = async (path, method) => {
    if (failure === 'transport' && method === 'GET' && path === '/aigc/storyboard/1' && ++reads === 2) throw new Error('offline during final inspection')
    if (failure !== 'ledger-io' || !path.includes('/byStoryboard/') || ++reads !== 3) return
    const files = await readdir(join(root, 'ledger'))
    await appendFile(join(root, 'ledger', files.find(file => file.endsWith('.ndjson'))!), 'invalid ledger JSON\n')
  }
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
    { storyboard_id: 1, status: 'still_present', response_status: 'unknown', verified_readback: false,
      error: failure === 'transport' ? 'NETWORK_ERROR' : 'REQUEST_OR_READBACK_FAILED' },
    { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toEqual([])
})

it.each(['transport', 'replacement-dependency'] as const)('never repeats deletion when %s prevents its readback', async (failure) => {
  const plan = await preview()
  const original = client
  if (failure !== 'transport') client = new ReadbackFailureClient(client, true)
  let removed = false
  beforeRequest = async (path, method) => {
    if (method === 'DELETE') {
      removed = true
    } else if (removed && failure === 'transport' && path === '/aigc/storyboard/1') throw new Error('offline during readback')
  }
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
    { storyboard_id: 1, status: 'unknown', verified_readback: false,
      error: failure === 'transport' ? 'NETWORK_ERROR' : 'READBACK_FAILED' },
    { storyboard_id: 2, status: 'not_attempted' },
  ] })
  beforeRequest = undefined
  client = original
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [
    { storyboard_id: 1, status: 'deleted', verified_readback: true }, { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toEqual(['/aigc/storyboard/1'])
})

it('inspects malformed old cards then removes only the reviewed identities', async () => {
  const plan = await preview()
  expect(plan).toMatchObject({ operation: 'storyboard_delete', targets: [
    { storyboard_id: 1, episode_id: null, duration: 8.7, prompt: '测试内容' },
    { storyboard_id: 2, episode_id: null },
  ] })
  expect(deletes).toEqual([])
  expect(await apply(plan)).toMatchObject({ status: 'deleted', paid_requests: 0,
    items: [{ storyboard_id: 1, status: 'deleted' }, { storyboard_id: 2, status: 'deleted' }] })
  expect(deletes).toEqual(['/aigc/storyboard/1', '/aigc/storyboard/2'])
  expect(await apply(plan)).toMatchObject({ replayed: true })
  expect(deletes).toHaveLength(2)
})
it('requires the inspection result to name every target before deletion', async () => {
  const plan = await preview()
  await expect(apply(plan, { checked_storyboard_ids: [1] })).rejects.toThrow(/检查|inspect/)
  expect(deletes).toEqual([])
})
it('preflights the whole batch and sends nothing when any target changed', async () => {
  const plan = await preview()
  boards[1] = { ...boards[1], modelConfig: JSON.stringify({ prompt: '正式镜头', duration: 12 }) }
  await expect(apply(plan)).rejects.toThrow(/Stale|变更/)
  expect(deletes).toEqual([])
})
it('refuses a different project, duplicate targets and missing authorization', async () => {
  await expect(preview({ storyboard_ids: [1, 1] })).rejects.toThrow()
  boards[1] = { ...boards[1], scriptId: 999 }
  await expect(preview()).rejects.toThrow()
  await expect(preview({ authorization_basis: '' })).rejects.toThrow()
  expect(deletes).toEqual([])
})
it('reports linked outputs and requires explicit authorization for their removal', async () => {
  linked = [{ id: 77, status: 'completed', videoUrl: 'https://media.example/77.mp4' }]
  const plan = await preview()
  expect(plan).toMatchObject({ requires_generated_authorization: true })
  await expect(apply(plan)).rejects.toThrow(/生成|generated/)
  const authorized = await preview({ include_generated_media: true })
  expect(await apply(authorized)).toMatchObject({ status: 'deleted' })
})
it('refuses active generation even when completed media removal is authorized', async () => {
  linked = [{ id: 77, status: 'running' }]
  const plan = await preview({ include_generated_media: true })
  await expect(apply(plan)).rejects.toThrow(/运行|active/)
  expect(deletes).toEqual([])
})
it('reconciles a lost delete response and never resends the original plan', async () => {
  const plan = await preview()
  interrupted = true
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
    { storyboard_id: 1, status: 'deleted', response_status: 'unknown' },
    { storyboard_id: 2, status: 'not_attempted' },
  ] })
  interrupted = false
  expect(await apply(plan)).toMatchObject({ replayed: true, items: [
    { storyboard_id: 1, status: 'deleted' }, { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toHaveLength(1)
})

it('refuses a partial linked-task page before authorizing any deletion', async () => {
  linkedEnvelope = { rows: [{ id: 77, status: 'completed' }], total: 2 }
  await expect(preview({ include_generated_media: true })).rejects.toThrow(/complete|incomplete/i)
  expect(deletes).toEqual([])
})

it('accepts a linked-task envelope only when its count establishes a complete list', async () => {
  linkedEnvelope = { list: [{ id: 77, status: 'completed' }], total: 1 }
  expect(await preview({ include_generated_media: true })).toMatchObject({ targets: [
    { storyboard_id: 1, tasks: [{ id: 77 }], active_generation: false },
    { storyboard_id: 2, tasks: [{ id: 77 }], active_generation: false },
  ] })
  linkedEnvelope = { list: [{ id: 77, status: 'completed' }] }
  await expect(preview({ include_generated_media: true })).rejects.toThrow(/complete|incomplete/i)
})

it('rejects an outside preview path before parsing its contents', async () => {
  const plan = await preview()
  const outside = join(root, 'outside-preview.json')
  await writeFile(outside, 'private-data-is-not-a-deletion-preview')
  await expect(apply(plan, { preview_path: outside })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(deletes).toEqual([])
})

it('refuses a preview source reached through a directory junction', async () => {
  const plan = await preview()
  const directory = join(root, 'video_tasks')
  const archive = join(root, 'preview-archive')
  await rename(directory, archive)
  await symlink(archive, directory, 'junction')
  try {
    await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(deletes).toEqual([])
  } finally { await unlink(directory) }
})

it.each([
  { method: 'storyboard_save' as const, scriptId: 2708 },
  { method: 'storyboard_remove' as const, scriptId: 999 },
  { method: 'storyboard_remove' as const, scriptId: 2708 },
])('rejects a foreign target claim during deletion replay: %j', async (claim) => {
  const plan = await preview()
  const key = String(plan.fingerprint)
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_remove', scriptId: 2708, requestSha256: `sha256:${key}` })
  await ledger.begin({ idempotencyKey: `${key}:1`, ...claim, requestSha256: 'sha256:foreign' })
  await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(deletes).toEqual([])
})

it('reports readback separately from the lost response during replay', async () => {
  const plan = await preview()
  interrupted = true
  await apply(plan)
  interrupted = false
  expect(await apply(plan)).toMatchObject({ replayed: true, items: [
    { storyboard_id: 1, status: 'deleted', response_status: 'unknown', verified_readback: true },
    { storyboard_id: 2, status: 'not_attempted', verified_readback: false },
  ] })
  expect(deletes).toHaveLength(1)
})
