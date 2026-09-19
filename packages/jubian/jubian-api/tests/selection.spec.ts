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

describe('subject selection planning', () => {
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
})
