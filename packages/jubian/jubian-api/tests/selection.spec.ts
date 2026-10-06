import { describe, expect, it } from 'vitest'
import { buildSubjectSelection, selectionState, trustedSubjectId, trustedSubjectKey,
  verifySubjectSelection } from '../src/selection.ts'

const PROMPT = '雨夜街头 @[陆沉舟](lead) 与 @[苏晚](guest)'
const URL_LEAD = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
const URL_GUEST = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/guest.jpg'

const STORYBOARD = {
  id: 916953,
  scriptId: 2708,
  // What the provider stores on every storyboard it holds, generated or not.
  isGenerate: 1,
  storyboardName: '第1集-分镜1',
  createTime: '2026-09-01 10:00:00',
  modelConfig: JSON.stringify({ prompt: PROMPT, ratio: '9:16', resolution: '720p', genNum: 1, duration: 8 }),
  storyboardMaterialList: [],
}

const ROWS = [
  { id: 1, assetId: 81285, scriptId: 2708, hsAssetId: 'asset-lead', assetUrl: URL_LEAD, assetName: '陆沉舟｜西装',
    hsAssetStatus: 'Active', isUsed: 1 },
  { id: 2, assetId: 83670, scriptId: 2708, hsAssetId: 'asset-guest', assetUrl: URL_GUEST, assetName: '苏晚｜风衣',
    hsAssetStatus: 'Active', isUsed: '1' },
]
const PARENTS = [
  { id: 81285, scriptId: 2708, assetUrl: URL_LEAD, delFlag: 0 },
  { id: 83670, scriptId: 2708, assetUrl: URL_GUEST, delFlag: 0 },
]

const SELECTIONS = [{ material_key: 'lead', asset_id: 81285 }, { material_key: 'guest', asset_id: 83670 }]

const oneSubject = () => ({ storyboard: { ...STORYBOARD, modelConfig: { prompt: '@[陆沉舟](lead)' } },
  selections: [SELECTIONS[0]!], subjectRows: [ROWS[0]!], parentAssets: [PARENTS[0]!] })

describe('subject selection planning', () => {
  it('preserves uploaded audio while replacing the ordered character image selections', () => {
    const audio = { materialType: 'audio', materialKey: 'voice-lead', materialUrl: 'https://x/voice.wav',
      fileName: '陆沉舟声线', sortOrder: 1 }
    const plan = buildSubjectSelection({ storyboard: { ...STORYBOARD, storyboardMaterialList: [audio],
      modelConfig: JSON.stringify({ prompt: `${PROMPT} 声音 @[陆沉舟声线](voice-lead)` }) },
    selections: SELECTIONS, subjectRows: ROWS, parentAssets: PARENTS })
    expect((plan.payload.storyboardMaterialList as Record<string, unknown>[]).at(-1)).toEqual(audio)
    expect(plan.after.orderedMaterials.map(material => material.materialKey)).toEqual(['lead', 'guest', 'voice-lead'])
    expect(verifySubjectSelection({ ...plan.payload }, plan.after).matches).toBe(true)
  })

  it('binds the trusted hsAssetId, the official URL and one-based order', () => {
    const plan = buildSubjectSelection({ storyboard: STORYBOARD, selections: SELECTIONS,
      subjectRows: ROWS, parentAssets: PARENTS })
    expect(plan.status).toBe('ready')
    expect(plan.paidRequests).toBe(0)
    expect(plan.payload.isGenerate).toBe(0)
    expect(plan.payload.storyboardMaterialList).toEqual([
      { assetId: 'asset-lead', materialAssetId: 81285, fileName: '陆沉舟｜西装', materialKey: 'lead',
        materialType: 'image', materialUrl: URL_LEAD, sortOrder: 1 },
      { assetId: 'asset-guest', materialAssetId: 83670, fileName: '苏晚｜风衣', materialKey: 'guest',
        materialType: 'image', materialUrl: URL_GUEST, sortOrder: 2 },
    ])
    expect(plan.after.orderedMaterials.map(material => material.materialKey)).toEqual(['lead', 'guest'])
  })

  it('refuses a selection order that disagrees with the prompt', () => {
    expect(() => buildSubjectSelection({ storyboard: STORYBOARD,
      selections: [SELECTIONS[1]!, SELECTIONS[0]!], subjectRows: ROWS, parentAssets: PARENTS })).toThrow()
  })

  it('refuses a row that is not confirmed for use, not active, or missing its trusted id', () => {
    const cases = [
      { ...ROWS[0]!, isUsed: 0 },
      { ...ROWS[0]!, hsAssetStatus: 'Inactive' },
      { ...ROWS[0]!, hsAssetId: '' },
    ]
    for (const broken of cases) {
      expect(() => buildSubjectSelection({ storyboard: STORYBOARD, selections: [SELECTIONS[0]!],
        subjectRows: [broken], parentAssets: [PARENTS[0]!] })).toThrow()
    }
  })

  it('refuses a row whose official URL disagrees with the parent asset', () => {
    expect(() => buildSubjectSelection({ storyboard: STORYBOARD, selections: [SELECTIONS[0]!],
      subjectRows: [ROWS[0]!], parentAssets: [{ id: 81285, scriptId: 2708, assetUrl: URL_GUEST }] })).toThrow()
  })

  it('refuses two parents that share one trusted identity', () => {
    expect(() => buildSubjectSelection({ storyboard: STORYBOARD, selections: SELECTIONS,
      subjectRows: [ROWS[0]!, { ...ROWS[1]!, hsAssetId: 'asset-lead' }], parentAssets: PARENTS })).toThrow()
  })

  it('refuses a selection that resolves to no unique subject row', () => {
    expect(() => buildSubjectSelection({ storyboard: STORYBOARD, selections: [SELECTIONS[0]!],
      subjectRows: [], parentAssets: [PARENTS[0]!] })).toThrow()
    expect(() => buildSubjectSelection({ storyboard: STORYBOARD, selections: [SELECTIONS[0]!],
      subjectRows: [ROWS[0]!, { ...ROWS[0]!, id: 9 }], parentAssets: [PARENTS[0]!] })).toThrow()
  })

  it('reports an already saved selection as a no-op instead of a second write', () => {
    const first = buildSubjectSelection({ storyboard: STORYBOARD, selections: SELECTIONS,
      subjectRows: ROWS, parentAssets: PARENTS })
    const saved = { ...STORYBOARD, storyboardMaterialList: first.payload.storyboardMaterialList }
    const second = buildSubjectSelection({ storyboard: saved, selections: SELECTIONS,
      subjectRows: ROWS, parentAssets: PARENTS })
    expect(second.status).toBe('already_applied')
    expect(second.nextAction).toBeNull()
  })

  it('verifies the saved snapshot against the plan and notices a changed order', () => {
    const plan = buildSubjectSelection({ storyboard: STORYBOARD, selections: SELECTIONS,
      subjectRows: ROWS, parentAssets: PARENTS })
    const saved = { ...STORYBOARD, storyboardMaterialList: plan.payload.storyboardMaterialList }
    expect(verifySubjectSelection(saved, plan.after)).toMatchObject({ matches: true, is_generate: 1 })
    const reversed = { ...saved, storyboardMaterialList: [...plan.payload.storyboardMaterialList as unknown[]].reverse() }
    expect(verifySubjectSelection(reversed, plan.after).matches).toBe(false)
  })

  it('keeps provider-owned material fields out of the compared state but inside the payload', () => {
    const existing = [{ materialKey: 'lead', assetId: 'stale', materialUrl: 'https://stale/x.jpg',
      materialAssetId: 1, materialType: 'image', sortOrder: 1, id: 55, createTime: '2026-01-01' },
    { materialKey: 'guest', assetId: 'asset-guest', materialUrl: URL_GUEST, materialAssetId: 83670,
      materialType: 'image', sortOrder: 2, id: 56 }]
    const plan = buildSubjectSelection({ storyboard: { ...STORYBOARD, storyboardMaterialList: existing },
      selections: SELECTIONS, subjectRows: ROWS, parentAssets: PARENTS })
    expect(plan.before.orderedMaterialsSha256).not.toBe(plan.after.orderedMaterialsSha256)
    expect(plan.after.orderedMaterials[0]).toEqual({ assetId: 'asset-lead', materialKey: 'lead',
      assetName: '陆沉舟｜西装', sortOrder: 1 })
    const payload = plan.payload.storyboardMaterialList as Record<string, unknown>[]
    expect(payload[0]).toMatchObject({ id: 55 })
    expect(payload[1]).toMatchObject({ id: 56 })
  })

  it('round-trips a serialized material list as JSON', () => {
    const serialized = JSON.stringify([{ materialKey: 'lead', assetId: 'asset-lead', materialUrl: URL_LEAD,
      materialAssetId: 81285, materialType: 'image', sortOrder: 1 }, { materialKey: 'guest',
      assetId: 'asset-guest', materialUrl: URL_GUEST, materialAssetId: 83670, materialType: 'image', sortOrder: 2 }])
    const plan = buildSubjectSelection({ storyboard: { ...STORYBOARD, storyboardMaterialList: serialized },
      selections: SELECTIONS, subjectRows: ROWS, parentAssets: PARENTS })
    expect(typeof plan.payload.storyboardMaterialList).toBe('string')
    expect(JSON.parse(plan.payload.storyboardMaterialList as string)).toHaveLength(2)
  })

  it.each([
    ['unconfirmed', { isUsed: 0 }], ['boolean confirmation', { isUsed: true }],
    ['inactive', { hsAssetStatus: 'Inactive' }], ['missing status', { hsAssetStatus: null }],
    ['blank identity', { hsAssetId: '  ' }], ['invalid identity', { hsAssetId: false }],
    ['foreign project', { scriptId: 1 }], ['invalid URL', { assetUrl: 'http://x/lead.jpg' }],
  ])('rejects a %s subject after the prompt markers have matched', (_label, overrides) => {
    const input = oneSubject()
    expect(() => buildSubjectSelection({ ...input, subjectRows: [{ ...ROWS[0]!, ...overrides }] }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it.each([{ scriptId: 1 }, { assetUrl: URL_GUEST }, { delFlag: '1' }])
  ('rejects a parent that disagrees with its active picker row: %j', (overrides) => {
    expect(() => buildSubjectSelection({ ...oneSubject(), parentAssets: [{ ...PARENTS[0]!, ...overrides }] }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('requires exactly one parent and one material per selected key', () => {
    const input = oneSubject()
    expect(() => buildSubjectSelection({ ...input, subjectRows: [] }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
    for (const parentAssets of [[], [PARENTS[0]!, PARENTS[0]!]]) {
      expect(() => buildSubjectSelection({ ...input, parentAssets }))
        .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
    }
    expect(() => buildSubjectSelection({ ...input, storyboard: { ...input.storyboard,
      storyboardMaterialList: [{ materialKey: 'lead' }, { materialKey: 'lead' }] } }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('refuses an audio marker that collides with a selected image marker', () => {
    const input = oneSubject()
    expect(() => buildSubjectSelection({ ...input, storyboard: { ...input.storyboard,
      storyboardMaterialList: [{ materialType: 'audio', materialKey: 'lead', sortOrder: 1,
        materialUrl: 'https://x/voice.wav' }] } }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('ignores unrelated wire rows with missing identifiers when resolving a subject', () => {
    const input = oneSubject()
    const plan = buildSubjectSelection({ ...input,
      subjectRows: [{ assetId: null }, { assetId: '' }, ...input.subjectRows],
      parentAssets: [{ id: null }, { id: '' }, ...input.parentAssets],
      storyboard: { ...input.storyboard, storyboardMaterialList: [{ materialKey: null }, { materialKey: '' }] } })
    expect(plan.payload.storyboardMaterialList).toEqual([expect.objectContaining({
      assetId: 'asset-lead', materialAssetId: 81285, materialKey: 'lead', materialUrl: URL_LEAD })])
  })

  it('rejects one trusted subject represented by numeric and string identities on different parents', () => {
    expect(() => buildSubjectSelection({ storyboard: STORYBOARD, selections: SELECTIONS,
      subjectRows: [{ ...ROWS[0]!, hsAssetId: 12 }, { ...ROWS[1]!, hsAssetId: '12' }], parentAssets: PARENTS }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it.each([
    { selections: [] }, { selections: [{ material_key: ' ', asset_id: 81285 }] },
    { selections: [{ material_key: 'lead', asset_id: -1 }] },
    { selections: [SELECTIONS[0]!, SELECTIONS[0]!] },
    { selections: [{ material_key: 'lead', asset_id: 81285 }, { material_key: 'guest', asset_id: 81285 }] },
  ])('refuses ambiguous or empty requested selections before producing a payload: %j', ({ selections }) => {
    expect(() => buildSubjectSelection({ ...oneSubject(), selections }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it.each([
    { storyboardMaterialList: '{' }, { storyboardMaterialList: {} }, { storyboardMaterialList: [null] },
    { modelConfig: '{' }, { modelConfig: [] }, { modelConfig: { prompt: 1 } },
  ])('refuses unreadable provider fields: %j', (overrides) => {
    const input = oneSubject()
    expect(() => buildSubjectSelection({ ...input, storyboard: { ...input.storyboard, ...overrides } }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })
})

describe('trusted subject identity helpers', () => {
  it('treats numeric and numeric-string ids as one subject and other strings as distinct', () => {
    expect(trustedSubjectKey(12)).toBe('number:12')
    expect(trustedSubjectKey('12')).toBe('number:12')
    expect(trustedSubjectKey('asset-12')).toBe('string:asset-12')
    expect(trustedSubjectId('asset-lead')).toBe('asset-lead')
    expect(trustedSubjectId(12)).toBe(12)
    expect(trustedSubjectId(true)).toBeNull()
    expect(trustedSubjectId(1.5)).toBeNull()
  })

  it('hashes the same state for two equal material lists', () => {
    const materials = [{ materialKey: 'a', assetId: 'x', materialUrl: URL_LEAD, sortOrder: 1 }]
    expect(selectionState(materials, PROMPT)).toEqual(selectionState([...materials], PROMPT))
  })

  it('normalizes optional wire names and order without inventing missing values', () => {
    expect(trustedSubjectId('  ')).toBeNull()
    expect(trustedSubjectKey('0')).toBe('string:0')
    const state = selectionState([{ assetId: 12, materialKey: 1, materialName: 'name', imageUrl: URL_LEAD,
      sortOrder: null }, { fileName: 'fallback' }, {}], PROMPT)
    expect(state.orderedMaterials).toEqual([
      { assetId: '12', materialKey: '1', assetName: 'name', sortOrder: null },
      { assetId: null, materialKey: null, assetName: 'fallback', sortOrder: null },
      { assetId: null, materialKey: null, assetName: null, sortOrder: null },
    ])
  })
})


describe('selection readback normalization', () => {
  it('accepts repeated references in the prompt without adding materials twice', () => {
    const storyboard = { ...STORYBOARD, modelConfig: JSON.stringify({ prompt: `${PROMPT}\n素材：@[陆沉舟](lead)` }) }
    const plan = buildSubjectSelection({ storyboard, selections: SELECTIONS, subjectRows: ROWS, parentAssets: PARENTS })
    expect(plan.after.orderedMaterials).toHaveLength(2)
  })

  it('compares saved identities and URLs rather than added server metadata or numeric wire spelling', () => {
    const plan = buildSubjectSelection({ storyboard: STORYBOARD, selections: SELECTIONS, subjectRows: ROWS, parentAssets: PARENTS })
    const saved: Record<string, unknown>[] = (plan.payload.storyboardMaterialList as Record<string, unknown>[]).map((m, i) => ({
      ...m, id: i + 100, createTime: '2026-09-29', providerLabel: 'saved',
      assetName: m.fileName, materialAssetId: String(m.materialAssetId), sortOrder: String(m.sortOrder),
    }))
    expect(verifySubjectSelection({ ...STORYBOARD, storyboardMaterialList: saved }, plan.after).matches).toBe(true)
    saved[0]!.materialUrl = 'https://example.test/wrong.jpg'
    expect(verifySubjectSelection({ ...STORYBOARD, storyboardMaterialList: saved }, plan.after).matches).toBe(false)
  })

  it('rejects readback fields that no longer contain the planned material list or prompt', () => {
    const plan = buildSubjectSelection(oneSubject())
    for (const overrides of [{ storyboardMaterialList: {} }, { modelConfig: { prompt: null } }]) {
      expect(() => verifySubjectSelection({ ...plan.payload, ...overrides }, plan.after))
        .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
    }
  })
})
