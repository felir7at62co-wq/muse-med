import { describe, expect, it } from 'vitest'
import {
  buildNativeVideoPreview, childrenOf, classifyExistingNativeMatches, classifyNewNativeCandidates,
  isRelatedTaskCandidate, nativeModelSignature, nativeObservablePrompt, nativeResultUrls,
  normalizedPrompt, readBackIdentity, resolveVideoModel, validateVideoDuration, stableJson, stableSha256,
  subjectIdentitySignature, submissionSemantics, taskIdOf, taskSemanticFields, taskStatusOf,
  terminalOutcome, validateNativeVideoPreview, validatedVideoMaterials, wireText,
  responseRecords, storyboardMaterials,
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
  it('reads task records without inventing records from absent data', () => {
    expect(responseRecords(null)).toEqual([])
    expect(responseRecords('unavailable')).toEqual([])
    expect(responseRecords({ id: 1 })).toEqual([{ id: 1 }])
    expect(responseRecords({ rows: [{ id: 1 }] })).toEqual([{ id: 1 }])
    expect(() => responseRecords({ rows: null })).toThrow()
    expect(() => responseRecords([null])).toThrow()
    expect(() => responseRecords([[]])).toThrow()
  })

  it('rejects unreadable serialized storyboard fields', () => {
    expect(() => storyboardMaterials({ storyboardMaterialList: '{' })).toThrow()
    expect(() => storyboardMaterials({ storyboardMaterialList: {} })).toThrow('no readable')
    expect(() => normalizedPrompt(null)).toThrow()
    expect(storyboardMaterials({ storyboardMaterialList: JSON.stringify(MATERIALS) })).toMatchObject({ serialized: true })
    expect(wireText(Number.NaN)).toBeNull()
    expect(wireText(Infinity)).toBeNull()
    expect(stableJson(null)).toBe('null')
    expect(stableJson(false)).toBe('false')
  })

  it('ignores unreadable scalar task fields while retaining valid fallback fields', () => {
    expect(taskIdOf({ id: '', taskId: null, aigcVideoTaskId: 42 })).toBe('42')
    expect(taskIdOf({ id: {}, taskId: false })).toBe('false')
    expect(taskSemanticFields({ subTaskList: [null], modelConfig: '{', storyboardMaterialList: [null, {},
      { assetUrl: URL_LEAD }], imageUrls: null })).toEqual({ storyboardId: null, prompt: null, imageUrls: [URL_LEAD] })
    expect(taskSemanticFields({ subTaskList: ['unreadable'], modelConfig: [], imageUrls: 'unreadable' }))
      .toEqual({ storyboardId: null, prompt: null, imageUrls: null })
    expect(taskSemanticFields({ imageUrls: [URL_LEAD, null, 12] }).imageUrls).toEqual([URL_LEAD, '12'])
    expect(taskStatusOf({ taskStatus: 1 }, { status: '  FAILED  ' })).toBe('failed')
    expect(nativeResultUrls([null, false, { data: { rows: [{ resultUrl: [URL_LEAD, URL_LEAD, null, 'http://bad/a'] }] } }]))
      .toEqual([URL_LEAD])
  })

  it('accepts padded decimal storyboard identifiers and rejects unreadable identifiers', () => {
    expect(buildNativeVideoPreview({ storyboard: { ...STORYBOARD, id: ' 0916953 ', scriptId: ' 02708 ' },
      assets: ASSETS, models: CATALOGUE, createdAt: 'now' }))
      .toMatchObject({ scriptId: 2708, storyboardId: 916953 })
    expect(() => buildNativeVideoPreview({ storyboard: { ...STORYBOARD, id: 'not-an-id' },
      assets: ASSETS, models: CATALOGUE, createdAt: 'now' })).toThrow()
  })

  it.each(['http://media.example/lead.jpg', 'https://user:password@media.example/lead.jpg'])
  ('rejects an unsafe material URL %s', (url) => {
    expect(() => buildNativeVideoPreview({ storyboard: { ...STORYBOARD,
      storyboardMaterialList: [{ ...MATERIALS[0], materialUrl: url }, MATERIALS[1]] },
    assets: [{ ...ASSETS[0]!, assetUrl: url }, ASSETS[1]!], models: CATALOGUE, createdAt: 'now' })).toThrow()
  })

  it('freezes uploaded voice references without treating them as character image assets', () => {
    const audio = { materialType: 'audio', materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/voice.wav',
      materialKey: 'voice-lead', fileName: '陆沉舟声线', sortOrder: 1, audioDuration: 2 }
    const storyboard = { ...STORYBOARD, storyboardMaterialList: [...MATERIALS, audio],
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, prompt: `${PROMPT} 陆沉舟声音参照 @[陆沉舟声线](voice-lead)` }) }
    const preview = buildNativeVideoPreview({ storyboard, assets: ASSETS, models: CATALOGUE, createdAt: 'now' })
    expect(preview.assetSummary.count).toBe(2)
    expect((preview.payload.storyboardMaterialList as Record<string, unknown>[]).at(-1)).toEqual(audio)
    expect(validateNativeVideoPreview(preview)).toEqual(preview)
    const changed = buildNativeVideoPreview({ storyboard: { ...storyboard,
      storyboardMaterialList: [...MATERIALS, { ...audio, materialUrl: `${audio.materialUrl}?version=2` }] },
    assets: ASSETS, models: CATALOGUE, createdAt: 'now' })
    expect(changed.idempotencyKey).not.toBe(preview.idempotencyKey)
    expect(() => buildNativeVideoPreview({ storyboard: { ...storyboard,
      storyboardMaterialList: [...MATERIALS, { ...audio, audioDuration: 16 }] },
    assets: ASSETS, models: CATALOGUE, createdAt: 'now' })).toThrow('15')
  })

  it('requires audio source readback to claim a video submitted with voice references', () => {
    const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/voice.wav'
    const expectation = { ...EXPECTATION, expectedAudioUrls: [url] }
    const candidate = { taskId: '335343', task: { id: 335343, scriptId: 2708, storyboardId: 916953 },
      children: [{ ...CHILD, audioMaterials: [{ audioUrl: url }] }] }
    expect(classifyNewNativeCandidates([candidate], expectation).status).toBe('matched')
    expect(classifyExistingNativeMatches([candidate], expectation).status).toBe('matched')
    expect(classifyExistingNativeMatches([{ ...candidate, children: [CHILD] }], expectation).status)
      .toBe('reconcile_conflict')
    expect(classifyNewNativeCandidates([{ ...candidate,
      children: [{ ...CHILD, audioMaterials: [{ audioUrl: `${url}?different=1` }] }] }], expectation).status)
      .toBe('reconcile_conflict')
  })

  it.each([['doubao-seedance-2-0-260128', 3], ['doubao-seedance-2-5-260628', 10]])
  ('refuses excess audio references for %s before producing a preview', (modelId, limit) => {
    const audio = Array.from({ length: limit + 1 }, (_, index) => ({ materialType: 'audio',
      materialUrl: `https://jubian-aigc.tos-cn-beijing.volces.com/prod/voice-${index}.wav`,
      materialKey: `voice-${index}`, fileName: `voice-${index}`, sortOrder: index + 1, audioDuration: 2 }))
    const storyboard = { ...STORYBOARD, storyboardMaterialList: [...MATERIALS, ...audio],
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, modelId,
        prompt: `${PROMPT} ${audio.map(item => `@[${item.fileName}](${item.materialKey})`).join(' ')}` }) }
    expect(() => validatedVideoMaterials(storyboard, ASSETS)).toThrow(`at most ${limit}`)
  })

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
  it.each([null, '{', [], { prompt: null }, { prompt: '' }, { prompt: '   ' },
    { modelConfig: null }, { modelConfig: 12 }, { modelConfig: '{' }])
  ('refuses an unreadable observable prompt %j', (config) => {
    expect(() => nativeObservablePrompt(config)).toThrow()
  })

  it('reads nested prompts and the alternate video-standard selector', () => {
    expect(nativeObservablePrompt({ modelConfig: JSON.stringify({ prompt: ` ${PROMPT} ` }) })).toBe(PROMPT)
    expect(nativeModelSignature({ ...MODEL_CONFIG, videoStandardId: '', modelVideoStandardId: 91 }))
      .toEqual(nativeModelSignature(MODEL_CONFIG))
    expect(() => nativeModelSignature('{')).toThrow()
    expect(() => nativeModelSignature({ ...MODEL_CONFIG, ratio: {} })).toThrow()
  })

  it.each([{ assetId: '' }, { materialName: '' }, { materialName: null, fileName: null },
    { imageUrl: 'http://bad/image.jpg' }])('rejects incomplete child identity %j', (overrides) => {
    expect(() => subjectIdentitySignature([{ assetId: 'a', materialName: 'lead', imageUrl: URL_LEAD, ...overrides }])).toThrow()
  })

  it('refuses an audio-only child identity and accepts numeric identity values', () => {
    expect(() => subjectIdentitySignature([{ materialType: 'audio' }])).toThrow()
    expect(() => subjectIdentitySignature(null)).toThrow()
    expect(subjectIdentitySignature([{ assetId: 17, assetName: 'lead', materialUrl: URL_LEAD }]))
      .toEqual([{ assetId: '17', materialName: 'lead', imageUrl: URL_LEAD }])
  })

  it.each([{ genTypes: null }, { videoStandards: null }, { platformId: '' },
    { genTypes: [{ id: 7, type: 3 }], videoStandards: [{ id: 91, ratio: '', resolution: '720p' }] }])
  ('refuses a malformed matching catalogue row %j', (overrides) => {
    expect(() => resolveVideoModel([{ ...CATALOGUE[0], ...overrides }], MODEL_CONFIG)).toThrow()
  })

  it('resolves a single selector with missing platform intent and alternate standard id', () => {
    expect(resolveVideoModel([{ ...CATALOGUE[0], id: undefined, standardId: 11, genNum: undefined,
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p' }] }], { ...MODEL_CONFIG, platformId: undefined }))
      .toMatchObject({ standardId: 11, platformId: 'YU_DIAN', genNum: 1 })
  })
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
    for (const duration of [1, 2, 3, 31, 2.5, NaN, Infinity, '30', null]) {
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
  it.each([{ asset_status: 'pending' }, { isUsed: 0 }])
  ('requires confirmed and selected source assets before building a preview %j', (overrides) => {
    expect(() => buildNativeVideoPreview({ storyboard: STORYBOARD, models: CATALOGUE, createdAt: 'now',
      assets: [{ ...ASSETS[0]!, ...overrides }, ASSETS[1]!] })).toThrow()
  })

  it('rejects a nonofficial asset in the standalone material reader', () => {
    expect(() => validatedVideoMaterials(STORYBOARD, [{ ...ASSETS[0]!, official: false }, ASSETS[1]!])).toThrow()
  })

  it('requires nonblank trusted identity and display name in preview summaries', () => {
    for (const material of [{ ...MATERIALS[0]!, assetId: '' }, { ...MATERIALS[0]!, fileName: '' },
      { ...MATERIALS[0]!, fileName: undefined, assetName: undefined }]) {
      const storyboard = { ...STORYBOARD, storyboardMaterialList: [material, MATERIALS[1]!] }
      expect(() => buildNativeVideoPreview({ storyboard, models: CATALOGUE, createdAt: 'now',
        assets: [{ ...ASSETS[0]!, hsAssetId: undefined }, ASSETS[1]!] })).toThrow()
    }
  })

  it('requires the original parent identifier in ordered preview metadata', () => {
    const material = { ...MATERIALS[0]!, materialAssetId: undefined, assetId: 81285 }
    expect(() => buildNativeVideoPreview({ storyboard: { ...STORYBOARD, storyboardMaterialList: [material, MATERIALS[1]!] },
      models: CATALOGUE, createdAt: 'now', assets: ASSETS })).toThrow()
  })

  it('accepts the storyboard alias and material name alias when the provider supplies them', () => {
    const material: Record<string, unknown> = { ...MATERIALS[0]!, assetName: 'lead' }
    delete material.fileName
    const storyboard: Record<string, unknown> = { ...STORYBOARD, storyboardId: STORYBOARD.id,
      storyboardMaterialList: [material, MATERIALS[1]!] }
    delete storyboard.id
    expect(buildNativeVideoPreview({ storyboard, models: CATALOGUE, assets: ASSETS, createdAt: 'now' }))
      .toMatchObject({ storyboardId: STORYBOARD.id, assetSummary: { orderedAssets: [
        expect.objectContaining({ materialName: 'lead' }), expect.any(Object)] } })
  })
  it.each([{ hsAssetStatus: 'inactive' }, { delFlag: '1' }, { deleted: 1 }, { resultStatus: 'failed' },
    { taskStatus: 'disabled' }, { assetStatus: 'unverified' }, { isUsed: 0 }, { assetUrl: null, url: null },
    { id: null }, { id: 81286 }])('rejects a parent asset that is unusable %j', (overrides) => {
    expect(() => validatedVideoMaterials(STORYBOARD, [{ ...ASSETS[0]!, ...overrides }, ASSETS[1]!])).toThrow()
  })

  it.each([{ materialType: null }, { materialType: 'video' }, { materialKey: '' }])
  ('rejects unusable image material fields %j', (overrides) => {
    expect(() => validatedVideoMaterials({ ...STORYBOARD,
      storyboardMaterialList: [{ ...MATERIALS[0]!, ...overrides }, MATERIALS[1]!] }, ASSETS)).toThrow()
  })

  it('retains trusted material identity when the parent has no translated identity', () => {
    const asset = { ...ASSETS[0]!, id: undefined, assetId: 81285, assetUrl: undefined, url: URL_LEAD,
      hsAssetId: undefined, hsAssetStatus: undefined, isUsed: undefined, resultStatus: '', taskStatus: null,
      assetStatus: 'succeeded' }
    expect(validatedVideoMaterials(STORYBOARD, [asset, ASSETS[1]!]).materials[0]).toMatchObject({ assetId: 'asset-lead' })
  })

  it.each([{ modelConfig: null }, { modelConfig: { ...MODEL_CONFIG, prompt: null } }])
  ('rejects a storyboard without saved prompt settings %j', (overrides) => {
    expect(() => validatedVideoMaterials({ ...STORYBOARD, ...overrides }, ASSETS)).toThrow()
  })

  it('rejects duplicated image and audio marker keys and misplaced audio prompt markers', () => {
    const audio = { materialType: 'audio', materialUrl: 'https://media.example/voice.wav', materialKey: 'lead',
      fileName: 'voice', sortOrder: 1, audioDuration: 2 }
    expect(() => validatedVideoMaterials({ ...STORYBOARD, storyboardMaterialList: [...MATERIALS, audio] }, ASSETS)).toThrow()
    expect(() => validatedVideoMaterials({ ...STORYBOARD,
      storyboardMaterialList: [...MATERIALS, { ...audio, materialKey: 'voice' }] }, ASSETS)).toThrow()
  })

  it.each([{ status: 'submitted' }, { storyboardId: 1 }, { scriptId: 1 }, { idempotencyKey: null },
    { idempotencyKey: 'broken' }, { assetSummary: { count: 2, orderedAssets: null } },
    { assetSummary: { count: 1, orderedAssets: PREVIEW.assetSummary.orderedAssets } }])
  ('rejects invalid durable preview metadata %j', (overrides) => {
    expect(() => validateNativeVideoPreview({ ...PREVIEW, ...overrides })).toThrow()
  })

  it('rejects invalid re-fingerprinted model settings in a preview', () => {
    for (const config of [null, { ...MODEL_CONFIG, genNum: 2 }, { ...MODEL_CONFIG, standardId: null },
      { ...MODEL_CONFIG, platformId: '' }]) {
      const payload = { ...PREVIEW.payload, modelConfig: config }
      expect(() => validateNativeVideoPreview({ ...PREVIEW, payload,
        idempotencyKey: stableSha256(submissionSemantics(payload)) })).toThrow()
    }
    expect(() => validateNativeVideoPreview({ ...PREVIEW,
      extra: [{ nested: { 'private-key': 'secret' } }] })).toThrow()
  })
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

  it.each([
    { version: 2 }, { estimatedSubmissions: 0 }, { createdAt: null }, { nextAction: null },
  ])('rejects incomplete preview metadata %j', (overrides) => {
    expect(() => validateNativeVideoPreview({ ...PREVIEW, ...overrides })).toThrow()
  })

  it.each([{ materialAssetId: null }, { materialKey: null }, { imageUrl: null }])
  ('rejects incomplete ordered material metadata %j', (overrides) => {
    const orderedAssets = PREVIEW.assetSummary.orderedAssets.map((asset, index) => index === 0 ? { ...asset, ...overrides } : asset)
    expect(() => validateNativeVideoPreview({ ...PREVIEW, assetSummary: { count: 2, orderedAssets } })).toThrow()
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

  it('coalesces repeated task ids and rejects candidate child ambiguity', () => {
    expect(classifyNewNativeCandidates([related, related], EXPECTATION).status).toBe('matched')
    expect(classifyNewNativeCandidates([{ ...related, children: [CHILD, CHILD] }], EXPECTATION).status)
      .toBe('reconcile_conflict')
    expect(classifyExistingNativeMatches([{ ...related, children: [] }], EXPECTATION).status).toBe('reconcile_conflict')
    expect(classifyExistingNativeMatches([{ ...related, children: [CHILD, CHILD] }], EXPECTATION).status)
      .toBe('reconcile_conflict')
    expect(classifyExistingNativeMatches([], EXPECTATION).status).toBe('none')
  })

  it('waits for an unresolved new child before claiming an otherwise exact task', () => {
    const pending = { ...related, taskId: '335344', children: [] }
    expect(classifyNewNativeCandidates([related, pending], EXPECTATION).status).toBe('none')
  })

  it.each([{ modelConfig: null }, { modelConfig: { ...MODEL_CONFIG, prompt: '' } },
    { modelConfig: { ...MODEL_CONFIG, prompt: 'different' } }, { modelConfig: { ...MODEL_CONFIG, resolution: '480p' } }])
  ('refuses incomplete or mismatching child model evidence %j', (overrides) => {
    const candidate = { ...related, children: [{ ...CHILD, ...overrides }] }
    expect(classifyNewNativeCandidates([candidate], EXPECTATION).status).toBe('reconcile_conflict')
    expect(classifyExistingNativeMatches([candidate], EXPECTATION).status)
      .toBe(overrides.modelConfig === null || overrides.modelConfig.prompt === '' ? 'reconcile_conflict' : 'none')
  })

  it('reports ambiguity between identity loss and another undecidable task', () => {
    const lost = { ...related, children: [{ ...CHILD, imageMaterials: [] }] }
    const secondLost = { ...lost, taskId: '335344' }
    const mismatch = { ...related, taskId: '335345', children: [{ ...CHILD, modelConfig: null }] }
    expect(classifyNewNativeCandidates([lost, secondLost], EXPECTATION).status).toBe('reconcile_conflict')
    expect(classifyNewNativeCandidates([lost, mismatch], EXPECTATION).status).toBe('reconcile_conflict')
    expect(readBackIdentity({ imageMaterials: [] }, EXPECTATION.expectedIdentity).status).toBe('subject_identity_lost')
    expect(readBackIdentity({ imageMaterials: [...MATERIALS].reverse() }, EXPECTATION.expectedIdentity).status)
      .toBe('subject_identity_lost')
  })

  it('keeps a settled mismatching identity a conflict when no exact task exists', () => {
    const candidate = { ...related, children: [{ ...CHILD, imageMaterials: [...MATERIALS].reverse() }] }
    expect(classifyNewNativeCandidates([candidate], EXPECTATION).status).toBe('reconcile_conflict')
    expect(classifyExistingNativeMatches([candidate], EXPECTATION).status).toBe('none')
  })

  it('allows related storyboard-less task details only in the expected episode', () => {
    const candidate = { ...related, task: { id: 335343, scriptId: 2708, episode_id: 46737 } }
    expect(classifyNewNativeCandidates([candidate], EXPECTATION).status).toBe('matched')
    expect(classifyNewNativeCandidates([{ ...candidate, task: { ...candidate.task, episode_id: 1 } }], EXPECTATION).status)
      .toBe('none')
  })

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
    expect(classifyExistingNativeMatches([{ ...related, children: [processedChild({ image_urls: [] })] }],
      { ...EXPECTATION, expectedModel: [] })).toEqual({ status: 'reconcile_conflict' })
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
