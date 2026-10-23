import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterReferenceQaGenerationPreparation } from '../src/character-reference-qa-bridge.ts'
import { videoMethod } from '../src/methods.ts'
import type { MethodArgs } from '../src/methods.ts'

const CATALOGUE = [{
  id: 66,
  standardId: 66,
  modelId: 'gpt-image-2',
  platformId: 'KU_AI',
  unitPrice: 0.12,
  unit: '张',
  genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }],
}]
const MATERIAL_URI = 'https://private.example.test/managed/reference.png'
const PROJECT_ID = 91_101
const OTHER_PROJECT_ID = 91_102
const CHARACTER_ID = 'fixture_supporting_character'
const CHARACTER_NAME = '示例角色甲'
const CATALOG_ID = 'character:synthetic-fixture:character-support-001'
const IMAGE_SHA = '1'.repeat(64)
const PROVIDER_ASSET_ID = 70_001

const binding = {
  authorization_id: 'qa-synthetic-one-shot',
  authorization_version: 1,
  character_id: CHARACTER_ID,
  catalog_asset_id: CATALOG_ID,
  image_sha256: IMAGE_SHA,
  managed_reference_id: 'managed-reference-1',
} as const

const baseArgs = {
  method: 'image_generate',
  script_id: PROJECT_ID,
  idempotency_key: 'managed-generation-1',
  asset_name: CHARACTER_NAME,
  asset_type: 1,
  prompt: '真人写实人物设定图。',
  character_reference: binding,
} satisfies MethodArgs

interface StubOptions {
  readonly applicationCode?: number
  readonly throwOnWrite?: boolean
  readonly assetStatus?: string | null
  readonly generatedImage?: unknown
}

function stubClient(events: string[], options: StubOptions = {}) {
  const calls: Array<{ method: string; body?: Record<string, unknown> }> = []
  const client = new JubianClient({
    credential: async () => 'token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(init?.method)
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined
      calls.push({ method, ...(body === undefined ? {} : { body }) })
      if (method === 'GET') {
        const catalogue = String(url).includes('getSelectList')
        events.push(catalogue ? 'catalogue' : 'readback')
        const data = catalogue ? CATALOGUE : String(url).includes('getGeneratedImageByAssetId')
          ? options.generatedImage
          : { id: PROVIDER_ASSET_ID, hsAssetStatus: options.assetStatus ?? null }
        return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
      }
      events.push('provider-write')
      if (options.throwOnWrite) throw new Error('synthetic transport interruption')
      return new Response(JSON.stringify({
        code: options.applicationCode ?? 200,
        data: PROVIDER_ASSET_ID,
      }), { status: 200 })
    },
  })
  return { calls, client }
}

function preparation(events: string[], recovery?: CharacterReferenceQaGenerationPreparation['preDispatchRecovery']) {
  const beforeReserve = vi.fn(async () => { events.push('before-reserve') })
  const settleAccepted = vi.fn((_receipt: unknown) => { events.push('settle-accepted') })
  const settleUnknown = vi.fn((_receipt?: unknown) => { events.push('settle-unknown') })
  const reconcileRecorded = vi.fn(async (_outcome: 'accepted' | 'unknown', _receipt: unknown) => {})
  const value: CharacterReferenceQaGenerationPreparation = {
    authorizationEnvironment: 'isolated_qa',
    authorizationId: binding.authorization_id,
    authorizationVersion: binding.authorization_version,
    managedReferenceId: binding.managed_reference_id,
    materialUri: MATERIAL_URI,
    scriptId: PROJECT_ID,
    characterId: binding.character_id,
    characterName: CHARACTER_NAME,
    roleClass: 'important_support',
    catalogAssetId: binding.catalog_asset_id,
    imageSha256: binding.image_sha256,
    ...(recovery === undefined ? {} : { preDispatchRecovery: recovery }),
    beforeReserve,
    settleAccepted,
    settleUnknown,
    reconcileRecorded,
  }
  return { beforeReserve, settleAccepted, settleUnknown, reconcileRecorded, value }
}

let root: string
let ledger: JubianLedger

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-character-reference-generation-'))
  ledger = new JubianLedger({ root })
  await writeFile(join(root, 'authorization.json'), JSON.stringify({
    version: 1,
    projects: { [PROJECT_ID]: { limit: '2.00', unit: 'CNY' } },
  }))
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('managed character-reference image generation', () => {
  it.each([
    { status: 'active', assetStatus: 'Active', next: '生成图已就绪' },
    { status: 'generated', assetStatus: null, next: '生成图已就绪' },
    { status: 'failed', assetStatus: 'Failed', next: '一次性授权不允许重投' },
    { status: 'timeout', assetStatus: 'Pending', next: '只读查询新资产' },
  ])('reports managed $status readback without promoting the candidate', async ({ status, assetStatus, next }) => {
    const events: string[] = []
    const { client, calls } = stubClient(events, { assetStatus, generatedImage: [{
      id: 701, assetId: PROVIDER_ASSET_ID, hsAssetStatus: 'Active', isUsed: 0,
      assetUrl: 'https://fixture.invalid/new-candidate.png',
    }] })
    const managed = preparation(events)
    const result = await videoMethod(client, ledger, baseArgs, { characterReferenceGeneration: managed.value,
      image: { activeTimeoutMs: 0, now: () => 0 } })
    expect(result).toMatchObject({ asset_status: status, character_reference: { publish_allowed: false, formal_bind_allowed: false } })
    expect(result.next).toContain(next)
    expect(result.next).toContain('不得 confirm_casting')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(managed.settleAccepted).toHaveBeenCalledOnce()
  })

  it.each([
    { resultMsg: '最多输入2张图', expected: '最多2张参考图' },
    { resultMsg: 'request was rejected by the safety system', expected: '内容审核拒绝' },
    { resultMsg: '用户额度不足', expected: '供应商额度不足' },
    { resultMsg: 'other failure', expected: '供应商报告生成失败' },
  ])('retains a taskless provider failure as a managed failure: $resultMsg', async ({ resultMsg, expected }) => {
    const events: string[] = []
    const { client } = stubClient(events, { generatedImage: [{
      assetId: PROVIDER_ASSET_ID, resultStatus: 'failed', resultMsg,
    }] })
    const result = await videoMethod(client, ledger, baseArgs, { characterReferenceGeneration: preparation(events).value,
      image: { activeTimeoutMs: 0, now: () => 0 } })
    expect(result).toMatchObject({ asset_status: 'failed' })
    expect(result.readback_error).toContain('任务未提供')
    expect(result.readback_error).toContain(expected)
  })
  it('honors cancellation during managed authorization before reserving or dispatching', async () => {
    const events: string[] = []
    const { calls, client } = stubClient(events)
    const managed = preparation(events)
    const controller = new AbortController()
    managed.beforeReserve.mockImplementationOnce(async () => {
      controller.abort(new Error('managed reference cancelled'))
    })
    await expect(videoMethod(client, ledger, baseArgs, {
      characterReferenceGeneration: managed.value,
      signal: controller.signal,
      deferImageReadback: true,
    })).rejects.toThrow('managed reference cancelled')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
    expect(await ledger.find(baseArgs.idempotency_key)).toBeUndefined()
  })

  it('resumes one proven pre-dispatch abort under the original key and never sends it twice', async () => {
    const firstEvents: string[] = []
    const firstClient = stubClient(firstEvents, { throwOnWrite: true }).client
    const first = preparation(firstEvents)
    await expect(videoMethod(firstClient, ledger, baseArgs, {
      characterReferenceGeneration: first.value,
      deferImageReadback: true,
    })).rejects.toThrow('Jubian request failed')
    const recorded = await ledger.find(baseArgs.idempotency_key)
    expect(recorded).toMatchObject({ method: 'image_generate', outcome: 'unknown',
      http_status: null, application_code: null, response_sha256: null })
    if (recorded === undefined) throw new Error('Missing synthetic generation record')
    const recovery = { actor: 'qa-operator', guardEvidenceSha256: '2'.repeat(64),
      reconciliationEvidenceSha256: '3'.repeat(64) }
    await ledger.preDispatchAbort({ recordId: recorded.record_id,
      idempotencyKey: recorded.idempotency_key, method: 'image_generate',
      requestSha256: recorded.request_sha256, ...recovery })

    const recoveredEvents: string[] = []
    const { calls, client } = stubClient(recoveredEvents)
    const recovered = preparation(recoveredEvents, recovery)
    const result = await videoMethod(client, ledger, baseArgs, {
      characterReferenceGeneration: recovered.value,
      deferImageReadback: true,
    })
    expect(result).toMatchObject({ replayed: false, outcome: 'accepted',
      identity_reference: { status: 'explicit', url: null } })
    expect(recoveredEvents).toEqual(['catalogue', 'before-reserve', 'provider-write', 'settle-accepted'])
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(await ledger.find(baseArgs.idempotency_key)).toMatchObject({ outcome: 'accepted' })

    const replayEvents: string[] = []
    const replayClient = stubClient(replayEvents).client
    const replay = preparation(replayEvents, recovery)
    expect(await videoMethod(replayClient, ledger, baseArgs, {
      characterReferenceGeneration: replay.value,
      deferImageReadback: true,
    })).toMatchObject({ replayed: true, outcome: 'accepted' })
    expect(replayEvents).toEqual(['catalogue'])
    expect(replay.beforeReserve).not.toHaveBeenCalled()
  })

  it('does not consume recovery or send when the rebuilt image body differs', async () => {
    const firstEvents: string[] = []
    const firstClient = stubClient(firstEvents, { throwOnWrite: true }).client
    await expect(videoMethod(firstClient, ledger, baseArgs, {
      characterReferenceGeneration: preparation(firstEvents).value,
      deferImageReadback: true,
    })).rejects.toThrow('Jubian request failed')
    const recorded = await ledger.find(baseArgs.idempotency_key)
    if (recorded === undefined) throw new Error('Missing synthetic generation record')
    const recovery = { actor: 'qa-operator', guardEvidenceSha256: '4'.repeat(64),
      reconciliationEvidenceSha256: '5'.repeat(64) }
    await ledger.preDispatchAbort({ recordId: recorded.record_id,
      idempotencyKey: recorded.idempotency_key, method: 'image_generate',
      requestSha256: recorded.request_sha256, ...recovery })
    const events: string[] = []
    const { calls, client } = stubClient(events)
    const prepared = preparation(events, recovery)
    await expect(videoMethod(client, ledger, { ...baseArgs, prompt: 'A different image request.' }, {
      characterReferenceGeneration: prepared.value,
      deferImageReadback: true,
    })).rejects.toThrow('differs from the recorded intent')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
    expect(prepared.beforeReserve).not.toHaveBeenCalled()
    expect(await ledger.find(baseArgs.idempotency_key)).toMatchObject({ outcome: 'not_sent' })
  })

  it('rejects model-supplied authorization when the Host preparation is unavailable', async () => {
    const events: string[] = []
    const { calls, client } = stubClient(events)
    await expect(videoMethod(client, ledger, baseArgs)).rejects.toThrow(
      'Managed character-reference authorization is unavailable',
    )
    expect(calls).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it('rejects caller reference URLs before reading the catalogue or consuming authorization', async () => {
    const events: string[] = []
    const { calls, client } = stubClient(events)
    const managed = preparation(events)
    await expect(videoMethod(client, ledger, {
      ...baseArgs,
      references: ['https://caller.example.test/untrusted.png'],
    }, { characterReferenceGeneration: managed.value })).rejects.toThrow(
      'Managed character-reference generation does not accept caller URLs',
    )
    expect(calls).toEqual([])
    expect(events).toEqual([])
    expect(managed.settleAccepted).not.toHaveBeenCalled()
    expect(managed.settleUnknown).not.toHaveBeenCalled()
  })

  it.each([
    ['authorization ID', { character_reference: { ...binding, authorization_id: 'qa-other' } }],
    ['authorization version', { character_reference: { ...binding, authorization_version: 2 } }],
    ['project', { script_id: OTHER_PROJECT_ID }],
    ['character', { character_reference: { ...binding, character_id: 'char_other' } }],
    ['Catalog asset', { character_reference: { ...binding, catalog_asset_id: 'character:other' } }],
    ['image digest', { character_reference: { ...binding, image_sha256: '0'.repeat(64) } }],
    ['managed upload', { character_reference: { ...binding, managed_reference_id: 'managed-reference-other' } }],
  ] satisfies ReadonlyArray<readonly [string, Partial<MethodArgs>]>)
  ('rejects a mismatched $0 identity before provider or ledger access', async (_name, override) => {
    const events: string[] = []
    const { calls, client } = stubClient(events)
    const managed = preparation(events)
    await expect(videoMethod(client, ledger, { ...baseArgs, ...override }, {
      characterReferenceGeneration: managed.value,
    })).rejects.toThrow('Managed character-reference identity conflicts with Host evidence')
    expect(calls).toEqual([])
    expect(events).toEqual([])
    expect(await ledger.records()).toEqual([])
  })

  it.each([
    ['existing parent asset', { parent_asset_id: 77 }],
    ['scene asset type', { asset_type: 2 }],
    ['scene asset category', { asset_type: 2, asset_category: '场景' as const }],
  ] satisfies ReadonlyArray<readonly [string, Partial<MethodArgs>]>)(
    'rejects a managed-reference $0 before catalogue, ledger, or provider work',
    async (_name, override) => {
      const events: string[] = []
      const { calls, client } = stubClient(events)
      const managed = preparation(events)
      await expect(videoMethod(client, ledger, { ...baseArgs, ...override }, {
        characterReferenceGeneration: managed.value,
      })).rejects.toThrow(/Managed character-reference/u)
      expect(calls).toEqual([])
      expect(events).toEqual([])
      expect(await ledger.records()).toEqual([])
      expect(managed.settleAccepted).not.toHaveBeenCalled()
      expect(managed.settleUnknown).not.toHaveBeenCalled()
    },
  )

  it('uses the Host-verified character name even if the model omits or misnames it', async () => {
    for (const assetName of [undefined, 'Other Character']) {
      const events: string[] = []
      const { calls, client } = stubClient(events)
      const managed = preparation(events)
      const request: MethodArgs = {
        ...baseArgs,
        idempotency_key: `managed-name-${assetName ?? 'omitted'}`,
      }
      if (assetName === undefined) delete request.asset_name
      else request.asset_name = assetName
      const result = await videoMethod(client, ledger, request,
        { characterReferenceGeneration: managed.value, deferImageReadback: true })
      expect(result).toMatchObject({ outcome: 'accepted', replayed: false })
      expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({
        assetName: `${CHARACTER_NAME}-参考候选-qa-synth`,
      })
      expect(JSON.stringify(calls)).not.toContain('Other Character')
    }
  })

  it('keeps the authorized character name when an episode is supplied', async () => {
    const events: string[] = []
    const { calls, client } = stubClient(events)
    const managed = preparation(events)
    const result = await videoMethod(client, ledger, {
      ...baseArgs, episode: '1', asset_category: '角色',
    }, { characterReferenceGeneration: managed.value, deferImageReadback: true })

    expect(result).toMatchObject({ outcome: 'accepted', replayed: false })
    expect(events).toEqual(['catalogue', 'before-reserve', 'provider-write', 'settle-accepted'])
    const writes = calls.filter(call => call.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.body).toMatchObject({ assetName: `${CHARACTER_NAME}-参考候选-qa-synth` })
    expect(JSON.stringify(writes[0]?.body)).not.toContain('EP01')
  })

  it('injects only the Host URI, authorizes before the provider write, and settles accepted', async () => {
    const events: string[] = []
    const { calls, client } = stubClient(events)
    const managed = preparation(events)
    const result = await videoMethod(client, ledger, baseArgs, {
      characterReferenceGeneration: managed.value,
      deferImageReadback: true,
    })

    expect(events).toEqual(['catalogue', 'before-reserve', 'provider-write', 'settle-accepted'])
    const write = calls.find(call => call.method === 'POST')
    expect(write).toBeDefined()
    expect(JSON.parse(String(write?.body?.modelConfig))).toMatchObject({
      materialList: [{ materialUrl: MATERIAL_URI, materialType: 'image', sortOrder: 1 }],
    })
    expect(write?.body).toMatchObject({ assetName: `${CHARACTER_NAME}-参考候选-qa-synth` })
    expect(managed.settleAccepted).toHaveBeenCalledOnce()
    const acceptedReceipt = managed.settleAccepted.mock.calls[0]?.[0]
    expect(acceptedReceipt).toMatchObject({ outcome: 'accepted' })
    if (acceptedReceipt === null || typeof acceptedReceipt !== 'object') {
      throw new Error('Missing synthetic accepted receipt')
    }
    expect('response_sha256' in acceptedReceipt && typeof acceptedReceipt.response_sha256).toBe('string')
    expect(managed.settleUnknown).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      outcome: 'accepted',
      character_reference: {
        authorization_id: binding.authorization_id,
        authorization_version: binding.authorization_version,
        managed_reference_id: binding.managed_reference_id,
        script_id: PROJECT_ID,
        character_id: binding.character_id,
        role_class: 'important_support',
        catalog_asset_id: binding.catalog_asset_id,
        image_sha256: binding.image_sha256,
        catalog_status: 'pending_review',
        qa_only: true,
        project_private_only: false,
        publish_allowed: false,
        formal_bind_allowed: false,
        cross_project_reuse_allowed: false,
      },
    })
    expect(result.next).toContain('不得 confirm_casting、正式绑定、发布或跨项目复用')
    expect(result.next).toContain('隔离 QA')
    expect(JSON.stringify(result)).not.toContain(MATERIAL_URI)
  })

  it('labels a normal Muse user grant as project-private rather than isolated QA', async () => {
    const events: string[] = []
    const { client } = stubClient(events)
    const managed = preparation(events)
    const result = await videoMethod(client, ledger, baseArgs, {
      characterReferenceGeneration: { ...managed.value, authorizationEnvironment: 'project_private' },
      deferImageReadback: true,
    })

    expect(result).toMatchObject({ character_reference: {
      qa_only: false,
      project_private_only: true,
      publish_allowed: false,
      formal_bind_allowed: false,
      cross_project_reuse_allowed: false,
    } })
    expect(result.next).toContain('项目私有一次性参考')
    expect(result.next).not.toContain('隔离 QA')
  })

  it('settles an indeterminate provider response as unknown without leaking the Host URI', async () => {
    const events: string[] = []
    const { client } = stubClient(events)
    vi.spyOn(client, 'request').mockImplementation(async (request) => {
      if (request.method === 'GET') {
        events.push('catalogue')
        return { transport: { http_status: 200, application_code: 200 },
          response_sha256: 'sha256:catalogue', envelope_layout: 'object-data', data: CATALOGUE }
      }
      events.push('provider-write')
      return { transport: { http_status: 200, application_code: null },
        response_sha256: 'sha256:indeterminate', envelope_layout: 'object-no-code', data: PROVIDER_ASSET_ID }
    })
    const managed = preparation(events)
    const result = await videoMethod(client, ledger, baseArgs, {
      characterReferenceGeneration: managed.value,
      deferImageReadback: true,
    })

    expect(events).toEqual(['catalogue', 'before-reserve', 'provider-write', 'settle-unknown'])
    expect(result).toMatchObject({ outcome: 'unknown', character_reference: {
      managed_reference_id: binding.managed_reference_id,
    } })
    expect(managed.settleAccepted).not.toHaveBeenCalled()
    expect(managed.settleUnknown).toHaveBeenCalledWith({
      outcome: 'unknown',
      response_sha256: 'sha256:indeterminate',
    })
    expect(JSON.stringify(result)).not.toContain(MATERIAL_URI)
    expect((await ledger.find(baseArgs.idempotency_key))?.outcome).toBe('unknown')
  })

  it('settles a transport interruption as unknown and returns a redacted error', async () => {
    const events: string[] = []
    const { client } = stubClient(events, { throwOnWrite: true })
    const managed = preparation(events)
    let message = ''
    try {
      await videoMethod(client, ledger, baseArgs, { characterReferenceGeneration: managed.value })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toBe('Jubian request failed')
    expect(message).not.toContain(MATERIAL_URI)
    expect(events).toEqual(['catalogue', 'before-reserve', 'provider-write', 'settle-unknown'])
    expect(managed.settleAccepted).not.toHaveBeenCalled()
    expect(managed.settleUnknown).toHaveBeenCalledWith()
    expect((await ledger.find(baseArgs.idempotency_key))?.outcome).toBe('unknown')
  })

  it('reconciles an accepted ledger replay without a second provider write', async () => {
    const events: string[] = []
    const { calls, client } = stubClient(events)
    const first = preparation(events)
    first.settleAccepted.mockImplementationOnce(() => { throw new Error('synthetic QA settlement interruption') })

    await expect(videoMethod(client, ledger, baseArgs, {
      characterReferenceGeneration: first.value,
      deferImageReadback: true,
    })).rejects.toThrow('synthetic QA settlement interruption')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect((await ledger.find(baseArgs.idempotency_key))?.outcome).toBe('accepted')

    const replay = preparation(events)
    const result = await videoMethod(client, ledger, baseArgs, {
      characterReferenceGeneration: replay.value,
      deferImageReadback: true,
    })

    expect(result).toMatchObject({ replayed: true, outcome: 'accepted' })
    expect(replay.beforeReserve).not.toHaveBeenCalled()
    expect(replay.settleAccepted).not.toHaveBeenCalled()
    expect(replay.settleUnknown).not.toHaveBeenCalled()
    expect(replay.reconcileRecorded).toHaveBeenCalledOnce()
    expect(replay.reconcileRecorded.mock.calls[0]?.[0]).toBe('accepted')
    const replayReceipt = replay.reconcileRecorded.mock.calls[0]?.[1]
    expect(replayReceipt).toMatchObject({ outcome: 'accepted' })
    if (replayReceipt === null || typeof replayReceipt !== 'object') {
      throw new Error('Missing synthetic replay receipt')
    }
    expect('response_sha256' in replayReceipt && typeof replayReceipt.response_sha256).toBe('string')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })
})
