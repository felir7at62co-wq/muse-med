import { describe, expect, it } from 'vitest'
import { buildImageRequest, readImageDisplayPrice, resolveImageModel } from '../src/image.ts'

const CATALOGUE = [{ id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
  genTypes: [{ id: 7, type: 3 }],
  videoStandards: [
    { id: 90, ratio: '16:9', resolution: '2K', width: 2048, height: 1152, genNum: 1 },
    { id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 },
  ] }]

describe('resolveImageModel', () => {
  it('selects the lowest supported resolution with valid 16:9 dimensions', () => {
    expect(resolveImageModel(CATALOGUE)).toEqual({ standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN',
      modelGenerationTypeId: 7, genType: 3, videoStandardId: 91, resolution: '1K' })
  })

  it('rejects a standard whose dimensions are not exactly 16:9', () => {
    const broken = [{ ...CATALOGUE[0], videoStandards: [{ id: 1, ratio: '16:9', resolution: '1K', width: 1280, height: 721 }] }]
    expect(() => resolveImageModel(broken)).toThrow()
  })

  it('rejects a catalogue without exactly one gpt-image-2 row', () => {
    expect(() => resolveImageModel([])).toThrow()
    expect(() => resolveImageModel([CATALOGUE[0], CATALOGUE[0]])).toThrow()
  })
})

describe('buildImageRequest', () => {
  it('builds the exact create body with a deterministic modelConfig string', () => {
    const body = buildImageRequest({ scriptId: 2708, assetName: '陆沉舟', assetType: 1,
      prompt: '一位中年男性', references: [] }, CATALOGUE)
    expect(body).toMatchObject({ scriptId: 2708, assetName: '陆沉舟', assetType: 1, isLocal: 0, isGenerate: 1 })
    const config = JSON.parse(body.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ modelId: 'gpt-image-2', genType: 3, duration: 1, resolution: '1K', ratio: '16:9',
      genNum: 1, backupModelList: [], style: 0, quality: '', prompt: '一位中年男性', materialList: [] })
    expect(config.standardId).toBe(42)
    expect(config.videoStandardId).toBe(91)
  })

  it('numbers ordered references from one and rejects a non-HTTPS url', () => {
    const body = buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p',
      references: ['https://x/a.png', 'https://x/b.png'] }, CATALOGUE)
    const config = JSON.parse(body.modelConfig as string) as { materialList: { sortOrder: number }[] }
    expect(config.materialList.map(row => row.sortOrder)).toEqual([1, 2])
    expect(() => buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p',
      references: ['http://x/a.png'] }, CATALOGUE)).toThrow()
  })

  it('adds the parent id only for the update route', () => {
    expect(buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p', references: [],
      parentAssetId: 83749 }, CATALOGUE).id).toBe(83749)
    expect('id' in buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p', references: [] }, CATALOGUE))
      .toBe(false)
  })
})

describe('readImageDisplayPrice', () => {
  it('reports the display price without claiming it is a verified quote', () => {
    expect(readImageDisplayPrice(CATALOGUE)).toEqual({ status: 'available', unit_price: 0.5, unit: '张', quote_verified: false })
    expect(readImageDisplayPrice([{ ...CATALOGUE[0], unitPrice: 'free' }]))
      .toEqual({ status: 'unavailable', quote_verified: false })
  })
})
