import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { modelMethod } from '../src/model-settings.ts'
import { bodyHash, writeUnderLedger } from '../src/write.ts'

const modelId = 'doubao-seedance-2-0-260128'
const config = { platformId: 'YU_DIAN', modelId, standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
  prompt: 'keep prompt', materialList: [{ assetId: 'official-a', materialAssetId: 42, sortOrder: 1 }], seed: 123 }
const catalogue = [{ id: 11, modelId, platformId: 'YU_DIAN', genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 },
    { id: 92, ratio: '9:16', resolution: '1080p', genNum: 1 }] }]
let root: string
let ledger: JubianLedger
let boards: Record<string, unknown>[]
let models: unknown
let calls: { method: string; path: string; body?: Record<string, unknown> }[]
let onRead: ((id: number) => void) | undefined
let onPut: ((body: Record<string, unknown>) => void) | undefined
let client: JubianClient
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-model-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  boards = [1, 2].map(id => ({ id, scriptId: 2708, episodeId: id + 10, isGenerate: 1,
    storyboardName: `board ${id}`, modelConfig: JSON.stringify(config),
    storyboardMaterialList: [{ assetId: 'official-a', materialAssetId: 42 }], other: 'keep' }))
  calls = []; models = structuredClone(catalogue); onRead = undefined; onPut = undefined
  client = new JubianClient({ credential: async () => 'token', fetch: async (url, init) => {
    const path = (url instanceof Request ? url.url : url.toString()).replace('https://web.jubianai.net/prod-api', '')
    const method = String(init?.method)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ method, path, ...(body ? { body } : {}) })
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path.startsWith('/model/charge/')) return answer(models)
    if (path.startsWith('/aigc/storyboard/list?')) return answer({ rows: boards, total: boards.length })
    if (method === 'GET' && path.startsWith('/aigc/storyboard/')) {
      const id = Number(path.split('/').pop()); onRead?.(id)
      return answer(boards.find(board => board.id === id))
    }
    if (method === 'PUT' && path === '/aigc/storyboard' && body) {
      onPut?.(body)
      boards = boards.map(board => board.id === body.id ? { ...body, isGenerate: 1 } : board)
      return answer(null)
    }
    throw new Error(`unexpected ${method} ${path}`)
  } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const preview = (extra = {}) => modelMethod(client, ledger, { method: 'preview', project_dir: root,
  script_id: 2708, scope: 'project', changes: { resolution: '1080p' }, ...extra })
const apply = (plan: Record<string, unknown>) => modelMethod(client, ledger, { method: 'apply', project_dir: root,
  script_id: 2708, preview_path: String(plan.preview_path), idempotency_key: String(plan.fingerprint) })
const puts = () => calls.filter(call => call.method === 'PUT')

describe('scoped model settings', () => {
  it('rejects an idempotency key owned by another method before preparing a body', async () => {
    await ledger.begin({ idempotencyKey: 'foreign-key', method: 'storyboard_save', requestSha256: 'sha256:foreign' })
    let prepared = false
    let sent = false
    await expect(writeUnderLedger(ledger, 'foreign-key', 'storyboard_model_settings', () => {
      prepared = true
      return {}
    }, async () => {
      sent = true
      throw new Error('must not send')
    })).rejects.toThrow()
    expect({ prepared, sent }).toEqual({ prepared: false, sent: false })
  })

  it('does not send when ledger begin reports an existing claim after body preparation', async () => {
    let sent = false
    const result = await writeUnderLedger(ledger, 'racing-key', 'storyboard_model_settings', async () => {
      await ledger.begin({ idempotencyKey: 'racing-key', method: 'storyboard_model_settings', requestSha256: bodyHash({}) })
      return {}
    }, async () => {
      sent = true
      return { transport: { http_status: 200, application_code: 200 }, response_sha256: null, data: null }
    })
    expect(result.replayed).toBe(true)
    expect(sent).toBe(false)
  })

  it('previews every target without PUT, then saves only model keys with generation disabled', async () => {
    const before = structuredClone(boards)
    const plan = await preview()
    expect(puts()).toEqual([])
    expect(JSON.parse(await readFile(String(plan.preview_path), 'utf8'))).toMatchObject({ fingerprint: plan.fingerprint })
    expect(plan.targets).toHaveLength(2)
    expect(await apply(plan)).toMatchObject({ status: 'applied', paid_requests: 0 })
    expect(puts()).toHaveLength(2)
    for (const [index, call] of puts().entries()) {
      expect(call.body).toMatchObject({ ...before[index], isGenerate: 0,
        modelConfig: expect.any(String) as unknown })
      expect(JSON.parse(String(call.body?.modelConfig))).toEqual({ ...config, resolution: '1080p', videoStandardId: 92 })
    }
    expect(await apply(plan)).toMatchObject({ replayed: true })
    expect(puts()).toHaveLength(2)
  })

  it('applies exact Seedance 2.5 9:16/480p/30s selectors through the tool', async () => {
    const replacement = 'doubao-seedance-2-5-260628'
    models = [...catalogue, { id: 338, modelId: replacement, platformId: 'FANG_ZHOU',
      genTypes: [{ id: 71, type: 3 }],
      videoStandards: [{ id: 72, ratio: '9:16', resolution: '480P', genNum: 1 }] }]
    const plan = await preview({ changes: { modelId: replacement, platformId: 'FANG_ZHOU', ratio: '9:16',
      resolution: '480p', genType: 3, duration: 30, genNum: 1 } })
    expect(plan.targets).toEqual([1, 2].map(storyboard_id => expect.objectContaining({ storyboard_id,
      after: { platformId: 'FANG_ZHOU', modelId: replacement, standardId: 338, genType: 3,
        modelGenerationTypeId: 71, videoStandardId: 72, duration: 30, ratio: '9:16', resolution: '480P', genNum: 1 } }) as unknown))
    expect(await apply(plan)).toMatchObject({ status: 'applied' })
    expect(JSON.parse(String(puts()[0]?.body?.modelConfig))).toMatchObject({ modelId: replacement,
      platformId: 'FANG_ZHOU', duration: 30, resolution: '480P', videoStandardId: 72, prompt: 'keep prompt' })
  })

  it('rejects an unknown exact model through the tool without a PUT', async () => {
    await expect(preview({ changes: { modelId: 'unknown-revision' } })).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('ignores provider-owned audit field changes during readback', async () => {
    const plan = await preview()
    onPut = (body) => {
      body.updateTime = '2026-09-21T00:00:01Z'; body.updateBy = 'provider'
      body.createTime = '2026-09-01T00:00:00Z'; body.createBy = 'provider'
    }
    expect(await apply(plan)).toMatchObject({ status: 'applied' })
  })

  it('rejects a foreign batch claim instead of treating it as this plan replay', async () => {
    const plan = await preview()
    await ledger.begin({ idempotencyKey: String(plan.fingerprint), method: 'storyboard_model_settings', requestSha256: 'sha256:foreign' })
    await expect(apply(plan)).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('rejects a foreign target claim during replay reconciliation', async () => {
    const plan = await preview()
    const key = String(plan.fingerprint)
    await ledger.begin({ idempotencyKey: key, method: 'storyboard_model_settings', requestSha256: `sha256:${key}` })
    await ledger.begin({ idempotencyKey: `${key}:1`, method: 'storyboard_save', requestSha256: 'sha256:foreign' })
    await expect(apply(plan)).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('does not carry an old platform across an explicit model change', async () => {
    const replacement = 'doubao-seedance-2-5-260628'
    models = [...catalogue, { ...catalogue[0], id: 12, modelId: replacement, platformId: 'OTHER' }]
    const plan = await preview({ changes: { modelId: replacement } })
    expect(plan.targets).toEqual([1, 2].map(storyboard_id => expect.objectContaining({ storyboard_id,
      after: expect.objectContaining({ modelId: replacement, platformId: 'OTHER', standardId: 12 }) as unknown }) as unknown))
    expect(await apply(plan)).toMatchObject({ status: 'applied' })
  })

  it('fails a model change with ambiguous platforms without selecting a default', async () => {
    const replacement = 'doubao-seedance-2-5-260628'
    models = [...catalogue, { ...catalogue[0], id: 12, modelId: replacement, platformId: 'OTHER' },
      { ...catalogue[0], id: 13, modelId: replacement, platformId: 'THIRD' }]
    await expect(preview({ changes: { modelId: replacement } })).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('rejects a target from another project even for an explicit storyboard scope', async () => {
    boards[0] = { ...boards[0], scriptId: 9 }
    await expect(preview({ scope: 'storyboards', storyboard_ids: [1] })).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('selects exact remote episode IDs rather than episode names or counts', async () => {
    const plan = await preview({ scope: 'episodes', episode_ids: [12] })
    expect(plan.targets).toEqual([expect.objectContaining({ storyboard_id: 2, episode_id: 12 })])
  })

  it.each([
    { scope: 'storyboards', storyboard_ids: ['1/../../bad'] },
    { scope: 'episodes', episode_ids: [0] },
    { scope: 'storyboards', storyboard_ids: [1, 1] },
    { scope: 'project', storyboard_ids: [1] },
    { changes: { prompt: 'replace' } },
    { changes: {} },
    { script_id: 9 },
  ])('rejects invalid request before writes: %j', async (extra) => {
    await expect(preview(extra)).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('validates all targets and current membership before the first write', async () => {
    const plan = await preview()
    boards[1] = { ...boards[1], modelConfig: JSON.stringify({ ...config, duration: 7 }) }
    await expect(apply(plan)).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('refuses changed project membership', async () => {
    const plan = await preview()
    boards.push({ ...boards[0], id: 3 })
    await expect(apply(plan)).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('refuses changed catalogue selectors before writes', async () => {
    const plan = await preview()
    models = [{ ...catalogue[0], id: 99 }]
    await expect(apply(plan)).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('stops after timeout and never sends the same plan again', async () => {
    const plan = await preview()
    onPut = () => { throw new Error('timeout') }
    expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
      expect.objectContaining({ storyboard_id: 1, status: 'unknown' }),
      expect.objectContaining({ storyboard_id: 2, status: 'not_attempted' }),
    ] })
    expect(await apply(plan)).toMatchObject({ replayed: true })
    expect(puts()).toHaveLength(1)
  })

  it('rereads each target immediately before write and stops on drift', async () => {
    const plan = await preview()
    onPut = () => { boards[1] = { ...boards[1], other: 'concurrent edit' } }
    expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
      expect.objectContaining({ status: 'applied' }), expect.objectContaining({ status: 'stale' }),
    ] })
    expect(puts()).toHaveLength(1)
  })

  it('checks preserved ordered assets after save', async () => {
    const plan = await preview()
    onPut = (body) => { body.storyboardMaterialList = [] }
    // The wiped material list still fails each target that saved it. What changed
    // is that the batch keeps going: two PUTs happen instead of one, because a plan
    // is claimed once and never resumes, so stopping early would strand the rest.
    expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
      expect.objectContaining({ status: 'readback_mismatch' }), expect.objectContaining({ status: 'readback_mismatch' }),
    ] })
    expect(puts()).toHaveLength(2)
  })

  it('accepts a save whose only change is the provider rebuilding material rows', async () => {
    const plan = await preview()
    // What the provider does on save: each material row comes back with a new surrogate id
    // and fresh audit columns, while every field that carries meaning keeps its value.
    // Counting those churned fields made every successful write read back as a mismatch.
    onPut = (body) => {
      const rows = body.storyboardMaterialList as Record<string, unknown>[]
      body.storyboardMaterialList = rows.map((row, index) => ({ ...row, id: 900000 + index,
        createTime: '2026-09-22 16:00:00', updateTime: '2026-09-22 16:00:00' }))
    }
    expect(await apply(plan)).toMatchObject({ status: 'applied', items: [
      expect.objectContaining({ status: 'applied' }), expect.objectContaining({ status: 'applied' }),
    ] })
    expect(puts()).toHaveLength(2)
  })

  it('still fails a save that changes what a material row means', async () => {
    const plan = await preview()
    // Same shape as the provider's rebuild, but the row now names a different asset:
    // normalization must not swallow a real change to the ordered subject identity.
    onPut = (body) => {
      const rows = body.storyboardMaterialList as Record<string, unknown>[]
      body.storyboardMaterialList = rows.map(row => ({ ...row, materialAssetId: 99, id: 900001 }))
    }
    expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
      expect.objectContaining({ status: 'readback_mismatch' }), expect.objectContaining({ status: 'readback_mismatch' }),
    ] })
  })

  it('claims concurrent application of the same plan only once', async () => {
    const plan = await preview()
    const results = await Promise.all([apply(plan), apply(plan)])
    expect(results.map(result => result.replayed).sort()).toEqual([false, true])
    expect(puts()).toHaveLength(2)
  })

  it('claims the batch once across two ledger objects sharing the same root', async () => {
    const plan = await preview()
    const second = new JubianLedger({ root: join(root, 'ledger') })
    const results = await Promise.all([apply(plan), modelMethod(client, second, { method: 'apply', project_dir: root,
      script_id: 2708, preview_path: String(plan.preview_path), idempotency_key: String(plan.fingerprint) })])
    expect(puts()).toHaveLength(2)
    expect(results.filter(result => result.replayed)).toHaveLength(1)
    expect(results.find(result => result.replayed)?.status).toBe('replayed')
  })

  it('reconciles saved targets on replay without sending another PUT', async () => {
    const plan = await preview()
    await apply(plan)
    const replay = await apply(plan)
    expect(replay).toMatchObject({ items: [expect.objectContaining({ status: 'applied' }),
      expect.objectContaining({ status: 'applied' })] })
    boards[0] = { ...boards[0], storyboardMaterialList: [] }
    expect(await apply(plan)).toMatchObject({ items: [expect.objectContaining({ status: 'readback_mismatch' }),
      expect.objectContaining({ status: 'applied' })] })
    expect(puts()).toHaveLength(2)
  })

  it('rejects a tampered plan and a mismatched fingerprint', async () => {
    const plan = await preview()
    await expect(apply({ ...plan, fingerprint: 'bad' })).rejects.toThrow()
    const file = JSON.parse(await readFile(String(plan.preview_path), 'utf8')) as Record<string, unknown>
    file.targets = [{ storyboard_id: '../bad' }]
    await writeFile(String(plan.preview_path), JSON.stringify(file))
    await expect(apply(plan)).rejects.toThrow()
    expect(puts()).toEqual([])
  })
})
