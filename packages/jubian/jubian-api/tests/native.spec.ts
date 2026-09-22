import { describe, expect, it } from 'vitest'
import {
  buildNativeVideoPreview, childrenOf, classifyExistingNativeMatches, classifyNewNativeCandidates,
  isRelatedTaskCandidate, nativeModelSignature, nativeObservablePrompt, nativeResultUrls,
  normalizedPrompt, readBackIdentity, resolveVideoModel, validateVideoDuration, stableJson, stableSha256,
  subjectIdentitySignature, submissionSemantics, taskIdOf, taskSemanticFields, taskStatusOf,
  terminalOutcome, validateNativeVideoPreview, validatedVideoMaterials, wireText,
} from '../src/native.ts'

const URL_LEAD = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
const URL_GUEST = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/guest.jpg'
const PROMPT = '雨夜街头 @[陆沉舟](lead) 与 @[苏晚](guest)'

const MODEL_CONFIG = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
  materialList: [], backupModelList: [], prompt: PROMPT }

const MATERIALS = [
  { assetId: 'asset-lead', materialAssetId: 81285, fileName: '陆沉舟｜西装', materialKey: 'lead',
    materialType: 'image', materialUrl: URL_LEAD, sortOrder: 1 },
  { assetId: 'asset-guest', materialAssetId: 83670, fileName: '苏晚｜风衣', materialKey: 'guest',
    materialType: 'image', materialUrl: URL_GUEST, sortOrder: 2 },
]

const STORYBOARD = { id: 916953, scriptId: 2708, isGenerate: 0, storyboardName: '第1集-分镜1',
  modelConfig: JSON.stringify(MODEL_CONFIG), storyboardMaterialList: MATERIALS }

const ASSETS = [
  { id: 81285, scriptId: 2708, assetUrl: URL_LEAD, hsAssetId: 'asset-lead', hsAssetStatus: 'Active', isUsed: 1,
    official: true, asset_status: 'confirmed' },
  { id: 83670, scriptId: 2708, assetUrl: URL_GUEST, hsAssetId: 'asset-guest', hsAssetStatus: 'Active', isUsed: 1,
    official: true, asset_status: 'confirmed' },
]

const CATALOGUE = [{ id: 11, standardId: 11, modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN',
  duration: 8, genNum: 1, genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] },
{ id: 12, modelId: 'doubao-seedance-2-0-mini-260128', platformId: 'YU_DIAN', genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 92, ratio: '9:16', resolution: '720p', genNum: 1 }] }]

const CHILD = { id: 972949, aigcVideoTaskId: 335343, storyboardId: 916953, taskStatus: 'succeeded',
  imageMaterials: MATERIALS, modelConfig: JSON.stringify(MODEL_CONFIG) }

const PREVIEW = buildNativeVideoPreview({ storyboard: STORYBOARD, assets: ASSETS, models: CATALOGUE,
  createdAt: '2026-09-20T10:00:00.000Z' })

const EXPECTATION = { scriptId: 2708, storyboardId: 916953, episodeId: 46737,
  expectedIdentity: subjectIdentitySignature(MATERIALS),
  expectedModel: nativeModelSignature(JSON.stringify(MODEL_CONFIG)),
  expectedPrompt: normalizedPrompt(PROMPT), beforeTaskIds: [] as string[] }

describe('canonical hashing and wire reading', () => {
  it('hashes key order independently', () => {
    expect(stableJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe('{"a":[{"x":1,"y":2}],"b":1}')
    expect(stableSha256({ a: 1, b: 2 })).toBe(stableSha256({ b: 2, a: 1 }))
    expect(stableSha256('x')).toHaveLength(64)
  })

  it('drops only server-owned audit fields from the fingerprinted semantics', () => {
    expect(submissionSemantics({ id: 1, createTime: 'x', nested: { updateBy: 'y', keep: 2 } }))
      .toEqual({ id: 1, nested: { keep: 2 } })
  })

  it('never stringifies an object into a wire scalar', () => {
    expect(wireText('a')).toBe('a')
    expect(wireText(12)).toBe('12')
    expect(wireText(true)).toBe('true')
    expect(wireText({ a: 1 })).toBeNull()
    expect(wireText(null)).toBeNull()
    expect(taskIdOf({ taskId: 12 })).toBe('12')
    expect(taskIdOf({ id: { nested: true } })).toBeNull()
  })

  it('reads the semantic fields of a task in either provider shape', () => {
    expect(taskSemanticFields({ storyboardId: 916953, prompt: PROMPT, imageUrls: [URL_LEAD] }))
      .toEqual({ storyboardId: 916953, prompt: PROMPT, imageUrls: [URL_LEAD] })
    expect(taskSemanticFields({ subTaskList: [{ storyboardId: 916953, prompt: PROMPT }],
      storyboardMaterialList: JSON.stringify([{ materialUrl: URL_LEAD }]) }))
      .toEqual({ storyboardId: 916953, prompt: PROMPT, imageUrls: [URL_LEAD] })
    expect(taskSemanticFields({ modelConfig: JSON.stringify({ prompt: PROMPT }) }).prompt).toBe(PROMPT)
  })

  it('classifies task status without inventing a fourth state', () => {
    expect(taskStatusOf({ taskStatus: 'Succeeded' })).toBe('succeeded')
    expect(taskStatusOf({}, { status: 'failed' })).toBe('failed')
    expect(taskStatusOf({})).toBe('')
    expect(terminalOutcome('succeeded')).toBe('succeeded')
    expect(terminalOutcome('no_all_failed')).toBe('failed')
    expect(terminalOutcome('running')).toBe('pending')
  })
})

describe('model and identity readers', () => {
  it('refreshes selectors without changing exact live intent or duration', () => {
    expect(resolveVideoModel(CATALOGUE, { ...MODEL_CONFIG, standardId: 999, modelGenerationTypeId: 999,
      videoStandardId: 999, duration: 12, resolution: '720P' })).toEqual({
      platformId: 'YU_DIAN', modelId: MODEL_CONFIG.modelId, standardId: 11, genType: 3,
      modelGenerationTypeId: 7, videoStandardId: 91, ratio: '9:16', resolution: '720p', duration: 12, genNum: 1 })
  })

  it('refuses missing models, ambiguous platforms and duplicate matching standards', () => {
    expect(() => resolveVideoModel([CATALOGUE[1]], MODEL_CONFIG)).toThrow('No catalogue row matches video settings')
    expect(() => resolveVideoModel({ rows: [] }, MODEL_CONFIG)).toThrow()
    const other = { ...CATALOGUE[0]!, platformId: 'FANG_ZHOU', id: 61 }
    expect(() => resolveVideoModel([CATALOGUE[0], other], { ...MODEL_CONFIG, platformId: undefined }))
      .toThrow('Video settings match multiple catalogue selectors')
    expect(resolveVideoModel([CATALOGUE[0], other], MODEL_CONFIG).platformId).toBe('YU_DIAN')
    expect(() => resolveVideoModel([{ ...CATALOGUE[0]!, videoStandards: [
      ...CATALOGUE[0]!.videoStandards, { ...CATALOGUE[0]!.videoStandards[0]!, id: 92 },
    ] }], MODEL_CONFIG)).toThrow()
  })

  it('rejects foreign model ids on matching generation and video-standard rows', () => {
    const row = CATALOGUE[0]!
    expect(() => resolveVideoModel([{ ...row,
      genTypes: [{ ...row.genTypes[0]!, modelId: 'foreign-model' }] }], MODEL_CONFIG)).toThrow()
    expect(() => resolveVideoModel([{ ...row,
      videoStandards: [{ ...row.videoStandards[0]!, modelId: 'foreign-model' }] }], MODEL_CONFIG)).toThrow()
    expect(resolveVideoModel([{ ...row,
      genTypes: [{ ...row.genTypes[0]!, modelId: MODEL_CONFIG.modelId }],
      videoStandards: [{ ...row.videoStandards[0]!, modelId: MODEL_CONFIG.modelId }] }], MODEL_CONFIG))
      .toMatchObject({ modelGenerationTypeId: 7, videoStandardId: 91 })
  })

  it('requires duration evidence for the exact model and integer numeric bounds', () => {
    expect(validateVideoDuration(MODEL_CONFIG.modelId, 15)).toBe(15)
    expect(() => validateVideoDuration(MODEL_CONFIG.modelId, 16)).toThrow()
    expect(validateVideoDuration('doubao-seedance-2-5-260628', 30)).toBe(30)
    for (const duration of [1, 31, 2.5, NaN, Infinity, '30', null]) {
      expect(() => validateVideoDuration('doubao-seedance-2-5-260628', duration)).toThrow('Duration must be an integer')
    }
    expect(() => validateVideoDuration('doubao-seedance-2-5-unknown', 8)).toThrow('No verified duration capability')
    expect(() => resolveVideoModel(CATALOGUE, { ...MODEL_CONFIG, genNum: 2 })).toThrow()
    expect(() => resolveVideoModel(CATALOGUE, { ...MODEL_CONFIG, genType: 4 })).toThrow()
  })

  it('reads a model signature only when every field is present', () => {
    expect(nativeModelSignature(JSON.stringify(MODEL_CONFIG))).toHaveLength(10)
    expect(() => nativeModelSignature(JSON.stringify({ ...MODEL_CONFIG, videoStandardId: undefined }))).toThrow()
    expect(nativeObservablePrompt(JSON.stringify({ prompt: `  ${PROMPT}\n ` }))).toBe(PROMPT)
  })

  it('reads the ordered identity and refuses a child that lost a field', () => {
    expect(subjectIdentitySignature(MATERIALS)).toEqual([
      { assetId: 'asset-lead', materialName: '陆沉舟｜西装', imageUrl: URL_LEAD },
      { assetId: 'asset-guest', materialName: '苏晚｜风衣', imageUrl: URL_GUEST },
    ])
    expect(() => subjectIdentitySignature([{ assetId: 'a', materialName: 'n' }])).toThrow()
    expect(() => subjectIdentitySignature([])).toThrow()
    expect(readBackIdentity(CHILD, EXPECTATION.expectedIdentity)).toEqual({ status: 'ok' })
    expect(readBackIdentity({ ...CHILD, imageMaterials: MATERIALS.slice(0, 1) }, EXPECTATION.expectedIdentity).status)
      .toBe('subject_identity_lost')
  })

  it('collects distinct result URLs and filters children by storyboard', () => {
    expect(nativeResultUrls([{ taskStatus: 'succeeded' },
      { resultList: [{ tosVideoUrl: 'https://a/x.mp4,https://a/y.mp4' }] },
      { resultList: [{ tosVideoUrl: 'https://a/x.mp4' }] }]))
      .toEqual(['https://a/x.mp4', 'https://a/y.mp4'])
    expect(childrenOf([{ storyboardId: 916953 }, { storyboardId: 1 }], 916953)).toHaveLength(1)
  })
})

describe('preview construction and validation', () => {
  it('prepares and validates the live 2.5 480p 30-second setting without downgrading it', () => {
    const modelId = 'doubao-seedance-2-5-260628'
    const models = [...CATALOGUE, { id: 61, platformId: 'FANG_ZHOU', modelId,
      genTypes: [{ id: 71, type: 3 }, { id: 72, type: 4 }],
      videoStandards: [{ id: 338, ratio: '9:16', resolution: '480p' }] }]
    const preview = buildNativeVideoPreview({ storyboard: { ...STORYBOARD,
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, modelId, platformId: 'FANG_ZHOU',
        resolution: '480P', duration: 30, genType: 4 }) }, assets: ASSETS, models, createdAt: 'now' })
    expect(JSON.parse(String(preview.payload.modelConfig))).toMatchObject({
      modelId, platformId: 'FANG_ZHOU', standardId: 61, modelGenerationTypeId: 72, genType: 4,
      videoStandardId: 338, resolution: '480p', duration: 30, genNum: 1 })
    expect(validateNativeVideoPreview(preview)).toEqual(preview)
    const payload = { ...preview.payload, modelConfig: JSON.stringify({
      ...JSON.parse(String(preview.payload.modelConfig)), duration: 31 }) }
    expect(() => validateNativeVideoPreview({ ...preview, payload,
      idempotencyKey: stableSha256(submissionSemantics(payload)) })).toThrow()
  })

  it('builds one PUT body with the live model selectors and a deterministic fingerprint', () => {
    expect(PREVIEW.operation).toBe('prepare_storyboard_native_video')
    expect(PREVIEW.payload.isGenerate).toBe(1)
    expect(PREVIEW.estimatedSubmissions).toBe(1)
    expect(PREVIEW.nextAction).toBe('核对 preview 的项目、主体、配置、预计费用与已有任务；在用户已授权范围内调用 submit_video，超出范围先取得授权。prepare 本身不 PUT、不创建任务、不收费。')
    expect(PREVIEW.assetSummary.orderedAssets[0]).toEqual({ assetId: 'asset-lead', materialAssetId: 81285,
      materialKey: 'lead', materialName: '陆沉舟｜西装', imageUrl: URL_LEAD })
    const config = JSON.parse(String(PREVIEW.payload.modelConfig)) as Record<string, unknown>
    expect(config).toMatchObject({ modelId: 'doubao-seedance-2-0-260128', genType: 3, videoStandardId: 91,
      ratio: '9:16', resolution: '720p', genNum: 1 })
    expect(config.materialList).toHaveLength(2)
    expect(PREVIEW.idempotencyKey).toHaveLength(64)
    expect(validateNativeVideoPreview(PREVIEW)).toEqual(PREVIEW)
    const again = buildNativeVideoPreview({ storyboard: STORYBOARD, assets: ASSETS, models: CATALOGUE,
      createdAt: '2026-09-21T10:00:00.000Z' })
    expect(again.idempotencyKey).toBe(PREVIEW.idempotencyKey)
  })

  it('refuses a payload whose settings, duration or assets break the contract', () => {
    const broken = (overrides: Record<string, unknown>) => ({ ...STORYBOARD,
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, ...overrides }) })
    expect(() => buildNativeVideoPreview({ storyboard: broken({ ratio: '16:9' }), assets: ASSETS,
      models: CATALOGUE, createdAt: 'now' })).toThrow()
    expect(() => buildNativeVideoPreview({ storyboard: broken({ resolution: '1080p' }), assets: ASSETS,
      models: CATALOGUE, createdAt: 'now' })).toThrow()
    expect(() => buildNativeVideoPreview({ storyboard: broken({ genNum: 2 }), assets: ASSETS,
      models: CATALOGUE, createdAt: 'now' })).toThrow()
    expect(() => buildNativeVideoPreview({ storyboard: broken({ duration: 1 }), assets: ASSETS,
      models: CATALOGUE, createdAt: 'now' })).toThrow()
    expect(() => buildNativeVideoPreview({ storyboard: broken({ duration: 16 }), assets: ASSETS,
      models: CATALOGUE, createdAt: 'now' })).toThrow()
    expect(() => buildNativeVideoPreview({ storyboard: STORYBOARD, assets: [ASSETS[0]!],
      models: CATALOGUE, createdAt: 'now' })).toThrow()
    expect(() => buildNativeVideoPreview({ storyboard: STORYBOARD,
      assets: [{ ...ASSETS[0]!, official: false }, ASSETS[1]!], models: CATALOGUE, createdAt: 'now' })).toThrow()
  })

  it('refuses a payload whose material identity or prompt order disagrees', () => {
    const reordered = { ...STORYBOARD, storyboardMaterialList: [MATERIALS[1]!, MATERIALS[0]!] }
    expect(() => buildNativeVideoPreview({ storyboard: reordered, assets: [ASSETS[1]!, ASSETS[0]!],
      models: CATALOGUE, createdAt: 'now' })).toThrow()
    // A local upload has no generated material id, so its usability rests
    // entirely on the trusted hsAssetId the subject row carries.
    const localWithoutTrust = { ...ASSETS[0]!, hsAssetId: '', isLocal: 1 }
    expect(() => buildNativeVideoPreview({ storyboard: STORYBOARD,
      assets: [localWithoutTrust, ASSETS[1]!], models: CATALOGUE, createdAt: 'now' })).toThrow()
  })

  it('rejects a tampered preview, a foreign operation and any embedded secret', () => {
    const tampered = { ...PREVIEW, idempotencyKey: 'f'.repeat(64) }
    expect(() => validateNativeVideoPreview(tampered)).toThrow()
    expect(() => validateNativeVideoPreview({ ...PREVIEW, operation: 'prepare_video_task' })).toThrow()
    expect(() => validateNativeVideoPreview({ ...PREVIEW, payload: { ...PREVIEW.payload, isGenerate: 0 } })).toThrow()
    expect(() => validateNativeVideoPreview({ ...PREVIEW, apiKey: 'x' })).toThrow()
    expect(() => validateNativeVideoPreview({ ...PREVIEW, payload: { ...PREVIEW.payload, token: 'x' } })).toThrow()
    const swapped = { ...PREVIEW, assetSummary: { count: 2,
      orderedAssets: [PREVIEW.assetSummary.orderedAssets[1], PREVIEW.assetSummary.orderedAssets[0]] } }
    expect(() => validateNativeVideoPreview(swapped)).toThrow()
  })

  it('validates the ordered materials of a live storyboard directly', () => {
    const { materials, prompt, config } = validatedVideoMaterials(STORYBOARD, ASSETS)
    expect(materials[1]).toMatchObject({ assetId: 'asset-guest', official: true, asset_status: 'confirmed' })
    expect(prompt).toBe(PROMPT)
    expect(config.ratio).toBe('9:16')
    expect(() => validatedVideoMaterials(STORYBOARD, [{ ...ASSETS[0]!, scriptId: 1 }, ASSETS[1]!])).toThrow()
    expect(() => validatedVideoMaterials({
      ...STORYBOARD,
      storyboardMaterialList: [{ ...MATERIALS[0]!, materialUrl: 'https://other/x.jpg' }, MATERIALS[1]!],
    }, ASSETS)).toThrow()
  })
})

describe('task claiming', () => {
  const related = { taskId: '335343', task: { id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1,
    taskStatus: 'succeeded' }, children: [CHILD] }

  it('claims the one new task whose child repeats the whole identity', () => {
    expect(classifyNewNativeCandidates([related], EXPECTATION)).toMatchObject({ status: 'matched',
      taskId: '335343' })
    expect(classifyExistingNativeMatches([related], EXPECTATION)).toMatchObject({ status: 'matched' })
  })

  it('ignores a task that already existed before the PUT', () => {
    expect(classifyNewNativeCandidates([related], { ...EXPECTATION, beforeTaskIds: ['335343'] }))
      .toEqual({ status: 'none' })
  })

  it('reports a child that lost its identity as terminal instead of a retry signal', () => {
    expect(classifyNewNativeCandidates([{ ...related, children: [{ ...CHILD, imageMaterials: [{ assetId: 'a' }] }] }],
      EXPECTATION)).toMatchObject({ status: 'subject_identity_lost', taskId: '335343' })
    expect(classifyExistingNativeMatches([{ ...related, children: [{ ...CHILD, imageMaterials: [{ assetId: 'a' }] }] }],
      EXPECTATION)).toEqual({ status: 'reconcile_conflict' })
  })

  it('waits while a new task has no child yet', () => {
    expect(classifyNewNativeCandidates([{ ...related, children: [] }], EXPECTATION)).toEqual({ status: 'none' })
  })

  it('refuses to pick between two exact candidates', () => {
    const second = { ...related, taskId: '335344', task: { ...related.task, id: 335344 } }
    expect(classifyNewNativeCandidates([related, second], EXPECTATION)).toEqual({ status: 'reconcile_conflict' })
    expect(classifyExistingNativeMatches([related, second], EXPECTATION)).toEqual({ status: 'reconcile_conflict' })
  })

  it('treats an exact candidate next to a still-running mismatch as a conflict', () => {
    const otherChild = { ...CHILD, imageMaterials: MATERIALS.map(material => ({ ...material, materialName: 'other' })) }
    const other = { ...related, taskId: '335345',
      task: { ...related.task, id: 335345, taskStatus: 'running' }, children: [otherChild] }
    expect(classifyNewNativeCandidates([related, other], EXPECTATION)).toEqual({ status: 'reconcile_conflict' })
    // A settled mismatch cannot converge any more, so the one exact candidate still wins.
    const settled = { ...other, task: { ...other.task, taskStatus: 'succeeded' } }
    expect(classifyNewNativeCandidates([related, settled], EXPECTATION)).toMatchObject({ status: 'matched' })
  })

  /** What the provider leaves on a result once it has run: its own fields, no materials. */
  const processedChild = (overrides: Record<string, unknown> = {}) => ({ id: 972949, aigcVideoTaskId: 335343,
    storyboardId: 916953, taskStatus: 'succeeded', image_urls: [URL_LEAD, URL_GUEST],
    modelId: 'doubao-seedance-2-0-260128', standardId: 11, resolution: '720p', ...overrides })

  it('drops a processed child whose image sequence contradicts this submission', () => {
    // A different ordered image list proves the child belongs to another submission, which
    // is a decision rather than the unreadable evidence a conflict is for.
    expect(classifyExistingNativeMatches([{ ...related,
      children: [processedChild({ image_urls: ['https://other.test/x.jpg'] })] }], EXPECTATION))
      .toEqual({ status: 'none' })
  })

  it('drops a processed child whose recorded model contradicts this submission', () => {
    // The live case: same materials re-run under a newer model. The URLs agree, so only the
    // recorded model proves this child is the older submission rather than this one.
    expect(classifyExistingNativeMatches([{ ...related,
      children: [processedChild({ modelId: 'doubao-seedance-2-5-260628', resolution: '480p' })] }], EXPECTATION))
      .toEqual({ status: 'none' })
  })

  it('keeps a processed child a conflict while its evidence cannot contradict this submission', () => {
    // Agreeing evidence still cannot prove the child is this submission, and a child that
    // states nothing at all is exactly as undecidable as before.
    expect(classifyExistingNativeMatches([{ ...related, children: [processedChild()] }], EXPECTATION))
      .toEqual({ status: 'reconcile_conflict' })
    expect(classifyExistingNativeMatches([{ ...related, children: [{ id: 972949, aigcVideoTaskId: 335343,
      storyboardId: 916953, taskStatus: 'succeeded' }] }], EXPECTATION)).toEqual({ status: 'reconcile_conflict' })
  })

  it('ignores storyboard-less history from a different episode', () => {
    const oldEpisode = { ...related, taskId: '444610',
      task: { id: 444610, scriptId: 2708, episodeId: 46735, taskType: 1 }, children: [] }
    expect(classifyExistingNativeMatches([oldEpisode], EXPECTATION)).toEqual({ status: 'none' })
  })

  it('only considers tasks of the same project and storyboard', () => {
    expect(isRelatedTaskCandidate({ scriptId: 1, storyboardId: 916953 }, 2708, 916953)).toBe(false)
    expect(isRelatedTaskCandidate({ taskType: 10 }, 2708, 916953)).toBe(false)
    expect(isRelatedTaskCandidate({ storyboardId: 1 }, 2708, 916953)).toBe(false)
    expect(isRelatedTaskCandidate({}, 2708, 916953)).toBe(true)
    const foreign = { ...related, task: { ...related.task, storyboardId: 5 } }
    expect(classifyNewNativeCandidates([foreign], EXPECTATION)).toEqual({ status: 'none' })
  })
})
