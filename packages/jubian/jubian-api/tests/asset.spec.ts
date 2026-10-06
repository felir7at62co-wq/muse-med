import { describe, expect, it } from 'vitest'
import { readAssetList, readAssetPage, readGeneratedImage, readMaterialList } from '../src/asset.ts'

describe('readAssetList / readAssetPage', () => {
  it('reads a paged asset list with its total', () => {
    expect(readAssetList({ total: 1, rows: [{ id: 83749, name: '陆沉舟', assetType: 1 }] }))
      .toEqual({ total: 1, rows: [{ asset_id: 83749, name: '陆沉舟', asset_type: 1 }] })
  })

  it('reads the assetName the provider really sends', () => {
    expect(readAssetList({ total: 1, rows: [{ id: 134986, assetName: '办事大姐｜现代都市豪门剧｜16x9角色设定板｜v1',
      assetType: 1 }] })).toEqual({ total: 1, rows: [{ asset_id: 134986,
      name: '办事大姐｜现代都市豪门剧｜16x9角色设定板｜v1', asset_type: 1 }] })
  })

  it('reads one asset and keeps the local-upload flag', () => {
    expect(readAssetPage({ id: 83749, name: '陆沉舟', assetType: 1, isLocal: 1, hsAssetStatus: 'Active' }))
      .toEqual({ asset_id: 83749, name: '陆沉舟', asset_type: 1, is_local: true, status: 'Active' })
    expect(readAssetPage({ id: 1, name: 'x', assetType: 2, isLocal: 0, hsAssetStatus: null }))
      .toEqual({ asset_id: 1, name: 'x', asset_type: 2, is_local: false, status: null })
  })

  it('reads the assetName of one asset', () => {
    expect(readAssetPage({ id: 83749, assetName: '陆沉舟｜第一集正式出演身份母版｜16x9｜v1', assetType: 1,
      isLocal: 0, hsAssetStatus: 'Active' })).toEqual({ asset_id: 83749,
      name: '陆沉舟｜第一集正式出演身份母版｜16x9｜v1', asset_type: 1, is_local: false, status: 'Active' })
  })

  it('keeps nullable fields absent and accepts the assetId spelling on both routes', () => {
    expect(readAssetList({ rows: [{ assetId: 7 }] })).toEqual({ total: 1,
      rows: [{ asset_id: 7, name: null, asset_type: null }] })
    expect(readAssetPage({ assetId: 7, isLocal: true })).toEqual({ asset_id: 7,
      name: null, asset_type: null, is_local: true, status: null })
    expect(readAssetPage({ assetId: 7, assetType: '1', isLocal: '1' }))
      .toMatchObject({ asset_type: null, is_local: false })
  })
})

describe('readMaterialList', () => {
  it('reads the subject-setting rows a shot match selects from', () => {
    const data = { total: 1, rows: [{ id: 900, assetId: 83749, materialName: '陆沉舟｜低调投资顾问装',
      materialUrl: 'https://x/y.png', materialType: 1, isUsed: 1, hsAssetStatus: 'Active' }] }
    expect(readMaterialList(data)).toEqual({ total: 1, rows: [{ material_id: 900, asset_id: 83749,
      name: '陆沉舟｜低调投资顾问装', url: 'https://x/y.png', material_type: 1, is_used: true, status: 'Active' }] })
  })

  it('reads the assetName, assetUrl and assetType the provider really sends', () => {
    const data = { total: 1, rows: [{ id: 79293, assetId: 81685, assetName: '沈知意｜同脸孕期职场装｜16x9｜v4',
      assetUrl: 'https://x/z.png', assetType: 1, isUsed: 1, hsAssetStatus: 'Active' }] }
    expect(readMaterialList(data)).toEqual({ total: 1, rows: [{ material_id: 79293, asset_id: 81685,
      name: '沈知意｜同脸孕期职场装｜16x9｜v4', url: 'https://x/z.png', material_type: 1, is_used: true,
      status: 'Active' }] })
  })

  it('rejects a payload without rows', () => {
    expect(() => readMaterialList({ total: 0 })).toThrow()
  })

  it('reads older material identifiers without inventing a parent or media type', () => {
    expect(readMaterialList({ rows: [{ materialId: 9, name: 'uploaded', url: 'https://x/file.png', isUsed: true }] }))
      .toEqual({ total: 1, rows: [{ material_id: 9, asset_id: null, name: 'uploaded',
        url: 'https://x/file.png', material_type: null, is_used: true, status: null }] })
    expect(readMaterialList({ rows: [{ materialId: 9, assetId: null, assetType: '1', isUsed: '1' }] }).rows[0])
      .toMatchObject({ asset_id: null, material_type: null, is_used: false })
  })
})

describe('readGeneratedImage', () => {
  it('reads the generated image URL for one asset', () => {
    expect(readGeneratedImage({ url: 'https://x/gen.png', materialId: 900 }))
      .toEqual({ url: 'https://x/gen.png', material_id: 900 })
  })

  it('reads the list the endpoint really answers with, using assetUrl and id', () => {
    expect(readGeneratedImage([{ id: 900, assetId: 83749, assetUrl: 'https://x/gen.png',
      hsAssetStatus: 'Active' }]))
      .toEqual({ url: 'https://x/gen.png', material_id: 900 })
  })

  it('takes the first row of a multi-row list', () => {
    expect(readGeneratedImage([{ id: 901, assetUrl: 'https://x/first.png' },
      { id: 900, assetUrl: 'https://x/second.png' }]))
      .toEqual({ url: 'https://x/first.png', material_id: 901 })
  })

  it('rejects a payload with no usable URL', () => {
    expect(() => readGeneratedImage({ materialId: 900 })).toThrow()
    expect(() => readGeneratedImage([{ id: 900 }])).toThrow()
  })

  it('rejects an empty list rather than reporting a reference it never read', () => {
    expect(() => readGeneratedImage([])).toThrow()
  })

  it('keeps a generated image URL whose response omits its optional material identifier', () => {
    expect(readGeneratedImage({ materialUrl: 'https://x/image.png' }))
      .toEqual({ url: 'https://x/image.png', material_id: null })
    expect(readGeneratedImage({ materialUrl: 'https://x/image.png', materialId: null }))
      .toEqual({ url: 'https://x/image.png', material_id: null })
    expect(() => readGeneratedImage({ assetUrl: '  ' })).toThrow()
  })
})
