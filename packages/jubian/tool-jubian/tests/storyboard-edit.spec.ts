import { appendFile, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { JubianRequest, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { storyboardMethod } from '../src/methods.ts'
import { storyboardEditMethod } from '../src/storyboard-edit.ts'

const modelId = 'doubao-seedance-2-0-260128'
const config = { platformId: 'YU_DIAN', modelId, standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p',
  genNum: 1, prompt: '@[阿舟](lead)走进房间', seed: 123 }
const catalogue = [{ id: 11, modelId, platformId: 'YU_DIAN', genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 },
    { id: 92, ratio: '9:16', resolution: '1080p', genNum: 1 }] }]
let root: string
let ledger: JubianLedger
let boards: Record<string, unknown>[]
let calls: { method: string; path: string; body?: Record<string, unknown> }[]
let onPut: ((body: Record<string, unknown>) => Promise<void> | void) | undefined
let client: JubianClient
let episodes: ((page: number) => unknown) | undefined
let beforeRequest: ((path: string, method: string) => Promise<void>) | undefined
let boardResponse: unknown
let ambiguousAcknowledgement: boolean
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-edit-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  boards = [1, 2, 3].map(id => ({ id, scriptId: 2708, episodeId: 11, isGenerate: 1,
    storyboardName: `board ${id}`, sortOrder: id, modelConfig: JSON.stringify(config),
    storyboardMaterialList: [{ id: 42, assetId: 'official-a', materialAssetId: 77,
      materialKey: 'lead', fileName: '阿舟', sortOrder: 1 }], other: 'keep' }))
  calls = []; onPut = undefined
  episodes = undefined; beforeRequest = undefined; boardResponse = undefined
  ambiguousAcknowledgement = false
  client = new JubianClient({ credential: async () => 'token', fetch: async (url, init) => {
    const path = (url instanceof Request ? url.url : url.toString()).replace('https://web.jubianai.net/prod-api', '')
    const method = String(init?.method)
    await beforeRequest?.(path, method)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ method, path, ...(body ? { body } : {}) })
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path.startsWith('/model/charge/')) return answer(catalogue)
    if (path.startsWith('/aigc/episode/list?')) return answer(episodes === undefined ? { rows: [
      { id: 11, scriptId: 2708, episodeCount: 1 }, { id: 12, scriptId: 2708, episodeCount: 2 },
    ], total: 2 } : episodes(Number(new URL(path, 'https://test.invalid').searchParams.get('pageNum'))))
    if (method === 'GET' && path.startsWith('/aigc/storyboard/')) {
      return answer(boardResponse ?? boards.find(board => board.id === Number(path.split('/').pop())))
    }
    if (method === 'PUT' && path === '/aigc/storyboard' && body) {
      await onPut?.(body)
      boards = boards.map(board => board.id === body.id ? { ...body, isGenerate: 1 } : board)
      if (ambiguousAcknowledgement) return new Response('[]')
      return answer(null)
    }
    throw new Error(`unexpected ${method} ${path}`)
  } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const preview = (changes: Record<string, unknown>, extra = {}) => storyboardMethod(client, ledger, {
  method: 'edit_preview', project_dir: root, script_id: 2708, storyboard_id: 1, changes, ...extra,
})
const apply = (plan: Record<string, unknown>, extra = {}) => storyboardMethod(client, ledger, {
  method: 'edit_apply', project_dir: root, script_id: 2708, preview_path: String(plan.preview_path),
  idempotency_key: String(plan.fingerprint), ...extra,
})
const writes = () => calls.filter(call => call.method !== 'GET')

/** Rewrite the actual frozen preview to exercise validation of persisted JSON. */
async function rewrite(
  plan: Record<string, unknown>, transform: (value: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const path = String(plan.preview_path)
  const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, JSON.stringify(transform(stored)))
}

it.each([
  { sort_order: 'first' }, { sort_order: 0.5 }, { sort_order: -1 }, { duration: 'long' },
  { genNum: 0 }, { name: 3 }, { name: ' ' }, {},
])('refuses unsupported field values before provider reads: %j', async (changes) => {
  await expect(preview(changes)).rejects.toThrow()
  expect(calls).toEqual([])
})

it('edits ordering without requesting an episode or model catalogue and refuses unsupported methods', async () => {
  const plan = await preview({ sort_order: 0 })
  const result = await apply(plan)
  expect(result).toMatchObject({ status: 'applied' })

  expect(writes()[0]?.body?.sortOrder).toBe(0)
  expect(calls.some(call => call.path.includes('/episode/') || call.path.includes('/model/'))).toBe(false)
  await expect(storyboardEditMethod(client, ledger, { method: 'get' }, { maxItems: 3, concurrency: 1 })).rejects.toThrow('Unknown')
})

it.each([null, '', undefined, { prompt: '' }].map(value => ({ value })))('edits legacy cards with empty configuration: %j', async ({ value }) => {
  boards[0] = { id: 1, scriptId: 2708, modelConfig: value, storyboardMaterialList: [] }
  const plan = await preview({ name: 'legacy edited' })
  expect(plan).toMatchObject({ targets: [{ before: { episode_id: null, name: null } }] })
  const result = await apply(plan)
  expect(result).toMatchObject({ status: 'applied' })
  if (value === undefined) expect(result).toMatchInlineSnapshot(`
    {
      "items": [
        {
          "status": "applied",
          "storyboard_id": 1,
          "verified_readback": true,
        },
      ],
      "next": "卡片原地保存，不生成。needs_reselect 表示保留的素材与新提示词标记不匹配，先 select_assets 再 prepare_video。unknown 先 get 对账，保留原 key。",
      "paid_requests": 0,
      "replayed": false,
      "status": "applied",
    }
  `)
})

it.each([null, '', undefined, JSON.stringify([])].map(value => ({ value })))('edits cards with an empty materials source: %j', async ({ value }) => {
  boards[0]!.storyboardMaterialList = value
  const plan = await preview({ prompt: 'plain prompt' })
  expect(await apply(plan)).toMatchObject({ status: 'applied' })
})

it.each([
  { modelConfig: '{bad' }, { modelConfig: '[]' }, { modelConfig: [] },
  { storyboardMaterialList: '{bad' }, { storyboardMaterialList: '{}' }, { storyboardMaterialList: false },
  { storyboardMaterialList: [false] },
])('refuses unreadable live card fields without a write: %j', async (change) => {
  boards[0] = { ...boards[0], ...change }
  await expect(preview({ name: 'edited' })).rejects.toThrow()
  expect(writes()).toEqual([])
})

it('deduplicates repeated prompt markers and retains an unkeyed material as a reselection requirement', async () => {
  boards[0]!.storyboardMaterialList = [{ assetId: 7 }]
  const plan = await preview({ prompt: '@[阿舟](lead) @[阿舟](lead)' })
  expect(plan).toMatchObject({ targets: [{ selected_keys: [null], prompt_keys: ['lead'], selection_status: 'needs_reselect' }] })
  expect(await apply(plan)).toMatchObject({ status: 'needs_reselect' })
})

it.each([false, [], { id: 99, scriptId: 2708 }, { id: 1, scriptId: 999 }])('refuses unreadable or foreign card identity: %j', async (value) => {
  boardResponse = value
  await expect(preview({ name: 'edited' })).rejects.toThrow()
  expect(writes()).toEqual([])
})

it.each([
  {}, { rows: false }, { rows: [], total: '0' }, { rows: [], total: -1 }, { rows: [], total: 0.5 },
  { rows: [{ id: 11 }, { id: 11 }], total: 2 }, { rows: [{ id: 11, scriptId: 999 }], total: 1 },
  { rows: [{ id: 11 }], total: 0 }, { rows: [{ id: 11 }], total: 2 },
])('refuses incomplete or foreign episode pages before saving: %j', async (value) => {
  episodes = () => value
  await expect(preview({ episode_id: 11 })).rejects.toThrow()
  expect(writes()).toEqual([])
})

it('accepts a complete uncounted episode array and refuses a requested episode absent from it', async () => {
  episodes = () => [{ id: 11 }]
  expect(await preview({ episode_id: 11 })).toMatchObject({ status: 'ready' })
  await expect(preview({ episode_id: 12 })).rejects.toThrow('absent')
  expect(writes()).toEqual([])
})

it('checks total consistency across pages and stops at the fixed forty-page limit', async () => {
  const pageRows = (page: number) => Array.from({ length: 100 }, (_item, offset) => ({ id: (page - 1) * 100 + offset + 1 }))
  episodes = page => ({ list: pageRows(page), total: page === 1 ? 200 : 201 })
  await expect(preview({ episode_id: 11 })).rejects.toThrow('total drift')
  episodes = page => ({ rows: pageRows(page) })
  await expect(preview({ episode_id: 11 })).rejects.toThrow('40 pages')
  episodes = page => pageRows(page)
  await expect(preview({ episode_id: 11 })).rejects.toThrow('40 pages')
  episodes = page => ({ rows: pageRows(page), total: 200 })
  expect(await preview({ episode_id: 199 })).toMatchObject({ status: 'ready' })
})

it('reselects the model platform when a changed model leaves the prior platform unspecified', async () => {
  boards[0]!.modelConfig = JSON.stringify({ ...config, modelId: 'old-model', platformId: 'old-platform' })
  expect(await preview({ modelId })).toMatchObject({ targets: [{ after: { modelId, platformId: 'YU_DIAN' } }] })
})

it.each([
  { version: 2 }, { operation: 'delete' }, { targets: {} }, { edits: {} }, { edits: [] },
  { edits: [{ storyboard_id: 1, changes: { name: 'edited' }, extra: true }] },
  { edits: [{ storyboard_id: 1, changes: { name: 'edited' } }, { storyboard_id: 1, changes: { name: 'edited' } }] },
])('refuses tampered preview metadata before a write: %j', async (change) => {
  const plan = await preview({ name: 'edited' })
  await rewrite(plan, stored => ({ ...stored, ...change }))
  await expect(apply(plan)).rejects.toThrow()
  expect(writes()).toEqual([])
})

it.each([
  { before_hash: 9 }, { before_hash: 'invalid' }, { expected_hash: 9 }, { expected_hash: 'invalid' },
  { request_hash: 9 }, { request_hash: 'invalid' }, { prompt_keys: false }, { selected_keys: false },
  { selection_status: 'auto' }, { prompt_keys: [3] }, { before: false }, { after: [] },
])('refuses corrupted inspected edit targets: %j', async (change) => {
  const plan = await preview({ name: 'edited' })
  await rewrite(plan, (stored) => {
    const targets = stored.targets as Record<string, unknown>[]
    return { ...stored, targets: [{ ...targets[0], ...change }] }
  })
  await expect(apply(plan)).rejects.toThrow()
  expect(writes()).toEqual([])
})

it('refuses oversized persisted edit sets under the resolved deployment bound', async () => {
  const plan = await preview({ name: 'edited' })
  await rewrite(plan, stored => ({ ...stored, edits: [1, 2].map(storyboard_id => ({ storyboard_id, changes: { name: 'edited' } })) }))
  await expect(storyboardEditMethod(client, ledger, { method: 'edit_apply', script_id: 2708, project_dir: root,
    preview_path: String(plan.preview_path), idempotency_key: String(plan.fingerprint),
  }, { maxItems: 1, concurrency: 1 })).rejects.toThrow('1..1')
})

it.each(['target-id', 'extra-field', 'fingerprint'] as const)('refuses a %s mismatch in an otherwise readable prepared plan', async (change) => {
  const plan = await preview({ name: 'edited' })
  await rewrite(plan, (stored) => {
    if (change === 'fingerprint') return { ...stored, fingerprint: 'bad' }
    const { fingerprint: _fingerprint, ...unsigned } = stored
    if (change === 'extra-field') return { ...stored, unknown: 'field' }
    const targets = unsigned.targets as Record<string, unknown>[]
    const modified = { ...unsigned, targets: [{ ...targets[0], storyboard_id: 2 }] }
    return { ...modified, fingerprint: stableSha256(modified) }
  })
  await expect(apply(plan)).rejects.toThrow('fingerprint')
  expect(writes()).toEqual([])
})

/** A replacement transport provider that rejects only the requested readback phase. */
class ReadbackFailureClient extends JubianClient {
  private enabled: boolean
  constructor(private readonly delegate: JubianClient, afterPut: boolean) {
    super({ credential: async () => 'unused-delegate-token' })
    this.enabled = !afterPut
  }
  override async request(request: JubianRequest): Promise<JubianResponse> {
    if (this.enabled && request.method === 'GET' && request.path === '/aigc/storyboard/1') throw new Error('replacement dependency stopped')
    const response = await this.delegate.request(request)
    if (request.method === 'PUT') this.enabled = true
    return response
  }
}

it.each(['method', 'project', 'hash'] as const)('refuses a foreign %s plan claim', async (field) => {
  const plan = await preview({ name: 'edited' })
  const key = String(plan.fingerprint)
  await ledger.begin({ idempotencyKey: key, method: field === 'method' ? 'storyboard_remove' : 'storyboard_save',
    scriptId: field === 'project' ? 999 : 2708, requestSha256: field === 'hash' ? 'sha256:foreign' : `sha256:${key}` })
  await expect(apply(plan)).rejects.toThrow('different write')
  expect(writes()).toEqual([])
})

it.each(['project', 'key'] as const)('refuses a readable plan with a different invocation %s', async (field) => {
  const plan = await preview({ name: 'edited' })
  const original = JSON.parse(await readFile(String(plan.preview_path), 'utf8')) as Record<string, unknown>
  const { fingerprint: _fingerprint, ...unsigned } = original
  const changed = { ...unsigned, script_id: 999 }
  const fingerprint = stableSha256(changed)
  const path = field === 'project' ? join(root, 'video_tasks', `${fingerprint}.storyboard-edit.prepared.json`) : String(plan.preview_path)
  await writeFile(path, JSON.stringify({ ...changed, fingerprint }))
  await expect(apply(plan, { preview_path: path, ...(field === 'project' ? { idempotency_key: fingerprint } : {}) }))
    .rejects.toThrow('project/path/key')
  expect(writes()).toEqual([])
})

it.each(['unchanged', 'needs_reselect'] as const)('replays a verified %s save without another write', async (selection) => {
  const plan = await preview(selection === 'unchanged' ? { name: 'edited' } : { prompt: '@[青衣](other)入场' })
  await apply(plan)
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [{
    status: selection === 'unchanged' ? 'applied' : 'needs_reselect', verified_readback: true,
  }] })
  expect(writes()).toHaveLength(1)
})

it.each(['transport', 'replacement-dependency'] as const)('retains the original edit key when %s prevents replay readback', async (fault) => {
  const plan = await preview({ name: 'edited' })
  await apply(plan)
  if (fault === 'transport') beforeRequest = async () => { throw new Error('offline') }
  else client = new ReadbackFailureClient(client, false)
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [{
    status: 'unknown', verified_readback: false, error: fault === 'transport' ? 'NETWORK_ERROR' : 'READBACK_FAILED',
  }] })
  expect(writes()).toHaveLength(1)
})

it('reconciles a second ledger instance claiming the plan while live preflight is pending', async () => {
  const plan = await preview({ name: 'edited' })
  const other = new JubianLedger({ root: join(root, 'ledger') })
  beforeRequest = async (path) => {
    if (path !== '/aigc/storyboard/1') return
    const key = String(plan.fingerprint)
    await other.begin({ idempotencyKey: key, method: 'storyboard_save', scriptId: 2708, requestSha256: `sha256:${key}` })
  }
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [{ status: 'not_attempted', verified_readback: false }] })
  expect(writes()).toEqual([])
})

it('retains the target identity if another writer already recorded its intent', async () => {
  const plan = await preview({ name: 'edited' })
  let reads = 0
  beforeRequest = async (path) => {
    if (path !== '/aigc/storyboard/1' || ++reads !== 2) return
    const target = (plan.targets as Record<string, unknown>[])[0]!
    await ledger.begin({ idempotencyKey: `${String(plan.fingerprint)}:1`, method: 'storyboard_save', scriptId: 2708,
      requestSha256: String(target.request_hash) })
  }
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [{ status: 'unknown', verified_readback: false }] })
  expect(writes()).toEqual([])
})

it('treats a bare response without a provider success code as an unknown save', async () => {
  const plan = await preview({ name: 'edited' })
  ambiguousAcknowledgement = true
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [{ status: 'unknown', verified_readback: false }] })
  ambiguousAcknowledgement = false
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [{ status: 'applied', verified_readback: true }] })
  expect(writes()).toHaveLength(1)
})

it.each(['content', 'member-order', 'ledger-io'] as const)('stops before PUT when %s changes after plan preflight', async (change) => {
  const plan = await preview({ name: 'edited' })
  let reads = 0
  beforeRequest = async (path) => {
    if (path !== '/aigc/storyboard/1' || ++reads !== 2) return
    if (change === 'content') boards[0]!.storyboardName = 'new content'
    else if (change === 'member-order') boards[0] = Object.fromEntries(Object.entries(boards[0]!).reverse())
    else {
      const files = await readdir(join(root, 'ledger'))
      await appendFile(join(root, 'ledger', files.find(file => file.endsWith('.ndjson'))!), 'invalid ledger JSON\n')
    }
  }
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [{ status: 'stale', verified_readback: false,
    ...(change === 'content' ? {} : { error: change === 'member-order' ? 'CONTRACT_CHANGED' : 'REQUEST_OR_READBACK_FAILED' }),
  }] })
  expect(writes()).toEqual([])
})

it('keeps an accepted write unknown when its replacement provider fails during readback', async () => {
  const plan = await preview({ name: 'edited' })
  const original = client
  client = new ReadbackFailureClient(client, true)
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [{ status: 'unknown', error: 'REQUEST_OR_READBACK_FAILED' }] })
  client = original
  expect(await apply(plan)).toMatchObject({ status: 'replayed', items: [{ status: 'applied', verified_readback: true }] })
  expect(writes()).toHaveLength(1)
})

describe('storyboard editing in place', () => {
  it('rejects an outside preview path before reading or parsing it', async () => {
    const plan = await preview({ name: 'edited' })
    const outside = join(root, 'outside-preview.json')
    await writeFile(outside, 'private-data-is-not-an-edit-preview')
    await expect(apply(plan, { preview_path: outside })).rejects.toThrow(/path\/key mismatch/)
    expect(writes()).toEqual([])
  })

  it('refuses an edit preview reached through a directory junction', async () => {
    const plan = await preview({ name: 'edited' })
    const directory = join(root, 'video_tasks')
    const archive = join(root, 'preview-archive')
    await rename(directory, archive)
    await symlink(archive, directory, 'junction')
    try {
      await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
      expect(writes()).toEqual([])
    } finally { await unlink(directory) }
  })

  it('previews changed content and saves the existing identity without generating', async () => {
    const original = structuredClone(boards[0])
    const plan = await preview({ prompt: '@[阿舟](lead)停在门口', name: 'EP01-P1', duration: 9 })
    expect(writes()).toEqual([])
    expect(plan).toMatchObject({ operation: 'storyboard_edit', targets: [
      { storyboard_id: 1, before: { name: 'board 1', duration: 8 }, after: { name: 'EP01-P1', duration: 9 } },
    ] })
    expect(await apply(plan)).toMatchObject({ status: 'applied', paid_requests: 0,
      items: [{ storyboard_id: 1, status: 'applied', verified_readback: true }] })
    expect(writes()).toHaveLength(1)
    expect(writes()[0]?.body).toEqual({ ...original, storyboardName: 'EP01-P1', isGenerate: 0,
      modelConfig: JSON.stringify({ ...config, prompt: '@[阿舟](lead)停在门口', duration: 9 }) })
    expect(JSON.parse(String(writes()[0]?.body?.modelConfig))).toEqual({ ...config,
      prompt: '@[阿舟](lead)停在门口', duration: 9 })
  })

  it('repairs the explicit episode binding and malformed duration without inferring from episodeCount', async () => {
    boards[0] = { ...boards[0], episodeId: null, episodeCount: 2,
      modelConfig: JSON.stringify({ ...config, duration: 8.7 }) }
    const plan = await preview({ episode_id: 12, duration: 9 })
    expect(await apply(plan)).toMatchObject({ status: 'applied' })
    expect(writes()[0]?.body).toMatchObject({ id: 1, scriptId: 2708, episodeId: 12, episodeCount: 2, isGenerate: 0 })
    expect(JSON.parse(String(writes()[0]?.body?.modelConfig))).toMatchObject({ duration: 9 })
  })

  it('requires reselection when content changes named marker identity', async () => {
    const plan = await preview({ prompt: '@[青衣](other)走进房间' })
    expect(plan).toMatchObject({ targets: [{ selection_status: 'needs_reselect' }] })
    const result = await apply(plan)
    expect(result).toMatchObject({ status: 'needs_reselect', items: [
      { storyboard_id: 1, status: 'needs_reselect', verified_readback: true },
    ] })
    expect(writes()[0]?.body?.storyboardMaterialList).toEqual(boards[0]?.storyboardMaterialList)
  })

  it('requires reselection when a marker keeps its key but names another subject', async () => {
    const plan = await preview({ prompt: '@[青衣](lead)走进房间' })
    expect(plan).toMatchObject({ targets: [{ selection_status: 'needs_reselect', prompt_keys: ['lead'], selected_keys: ['lead'] }] })
    expect(await apply(plan)).toMatchObject({ status: 'needs_reselect', items: [{ verified_readback: true }] })
  })

  it('rejects stale card data before any PUT', async () => {
    const plan = await preview({ name: 'edited' })
    boards[0] = { ...boards[0], other: 'concurrent edit' }
    await expect(apply(plan)).rejects.toThrow(/Stale/)
    expect(writes()).toEqual([])
  })

  it('never sends a claimed edit again after unknown transport result', async () => {
    const plan = await preview({ name: 'edited' })
    onPut = () => { throw new Error('timeout') }
    expect(await apply(plan)).toMatchObject({ status: 'partial', items: [{ status: 'unknown' }] })
    expect(await apply(plan)).toMatchObject({ replayed: true })
    expect(writes()).toHaveLength(1)
  })

  it('reports a readback mismatch when the provider drops selected materials', async () => {
    const plan = await preview({ name: 'edited' })
    onPut = (body) => { body.storyboardMaterialList = [] }
    expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
      { status: 'readback_mismatch', verified_readback: false },
    ] })
  })

  it('accepts audit churn while verifying selected material identity and order', async () => {
    const plan = await preview({ name: 'edited' })
    onPut = (body) => {
      body.updateTime = 'today'
      const materials = body.storyboardMaterialList as Record<string, unknown>[]
      body.storyboardMaterialList = materials.map(row => ({ ...row, id: 999, updateTime: 'today' }))
    }
    expect(await apply(plan)).toMatchObject({ status: 'applied', items: [{ verified_readback: true }] })
  })

  it('validates a whole batch and uses configured bounded PUT concurrency', async ({ task }) => {
    const startedAt = performance.now()
    const plan = await storyboardMethod(client, ledger, { method: 'edit_batch_preview', project_dir: root,
      script_id: 2708, edits: [1, 2, 3].map(storyboard_id => ({ storyboard_id, changes: { name: `edited ${storyboard_id}` } })),
    }, { storyboardBatch: { concurrency: 2, maxItems: 3 } })
    const bothEntered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let active = 0; let maximum = 0; let entrants = 0
    onPut = async () => {
      const entrant = ++entrants
      active++; maximum = Math.max(maximum, active)
      try {
        if (entrant <= 2) {
          if (entrant === 2) bothEntered.resolve(undefined)
          await release.promise
        }
      } finally { active-- }
    }
    const deadline = Promise.withResolvers<never>()
    const timeout = setTimeout(() => {
      deadline.reject(new Error('Two PUTs did not enter concurrently within the test budget'))
    }, Math.max(1, (task.timeout - (performance.now() - startedAt)) / 2))
    const operation = storyboardMethod(client, ledger, { method: 'edit_apply', project_dir: root, script_id: 2708,
      preview_path: String(plan.preview_path), idempotency_key: String(plan.fingerprint),
    }, { storyboardBatch: { concurrency: 2, maxItems: 3 } })
    try {
      await Promise.race([bothEntered.promise, deadline.promise,
        operation.then(() => { throw new Error('Batch finished before two PUTs entered concurrently') })])
      expect(active).toBe(2)
      expect(writes()).toHaveLength(2)
      release.resolve(undefined)
      expect(await operation).toMatchObject({ status: 'applied' })
      expect(maximum).toBe(2)
      expect(active).toBe(0)
      expect(writes()).toHaveLength(3)
    } finally {
      clearTimeout(timeout)
      release.resolve(undefined)
      await Promise.allSettled([operation])
    }
  })

  it.each([{ id: 2 }, { isGenerate: 1 }, { storyboardMaterialList: [] }, { prompt: '' }, { duration: 8.5 }])(
    'rejects unsupported or malformed edits before network reads: %j', async (changes) => {
      await expect(preview(changes)).rejects.toThrow()
      expect(calls).toEqual([])
    },
  )
})
