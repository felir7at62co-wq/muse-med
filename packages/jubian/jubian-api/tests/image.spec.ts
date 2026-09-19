import { describe, expect, it } from 'vitest'
import { buildImageRequest, readImageDisplayPrice, resolveImageModel } from '../src/image.ts'

const CATALOGUE = [{ id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
  genTypes: [{ id: 7, type: 3 }],
  videoStandards: [
    { id: 90, ratio: '16:9', resolution: '2K', width: 2048, height: 1152, genNum: 1 },
    { id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 },
  ] }]

// The live account catalogue: one model id, two platforms, two prices.
const MULTI = [
  { id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI', unitPrice: 0.12, unit: '张',
    genTypes: [{ id: 7, type: 3 }],
    videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] },
  { id: 76, modelId: 'gpt-image-2', platformId: 'DUO_YUAN_TAN_SUO', unitPrice: 1.05, unit: '条',
    genTypes: [{ id: 8, type: 3 }],
    videoStandards: [{ id: 92, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] },
]

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

describe('resolveImageModel against a catalogue listing several gpt-image-2 rows', () => {
  it('refuses to pick a platform and names every candidate with its own price', () => {
    let message = ''
    try { resolveImageModel(MULTI) } catch (error) { message = (error as Error).message }
    // Choosing here would silently buy from one platform at one price; the
    // failure has to carry enough for a deployment to pin the other.
    for (const token of ['66', 'KU_AI', '0.12', '76', 'DUO_YUAN_TAN_SUO', '1.05']) {
      expect(message).toContain(token)
    }
  })

  it('selects the pinned platform or standard and reports that row alone', () => {
    expect(resolveImageModel(MULTI, { platformId: 'KU_AI' }))
      .toMatchObject({ standardId: 66, platformId: 'KU_AI', videoStandardId: 91, modelGenerationTypeId: 7 })
    expect(resolveImageModel(MULTI, { standardId: 76 }))
      .toMatchObject({ standardId: 76, platformId: 'DUO_YUAN_TAN_SUO', videoStandardId: 92,
        modelGenerationTypeId: 8 })
  })

  it('quotes the pinned row and never the other platform price', () => {
    expect(readImageDisplayPrice(MULTI, { platformId: 'KU_AI' }))
      .toEqual({ status: 'available', unit_price: 0.12, unit: '张', quote_verified: false })
    expect(readImageDisplayPrice(MULTI, { standardId: 76 }))
      .toEqual({ status: 'available', unit_price: 1.05, unit: '条', quote_verified: false })
  })

  it('rejects a pin that matches no candidate instead of falling back to one', () => {
    expect(() => resolveImageModel(MULTI, { platformId: 'YU_DIAN' })).toThrow(/KU_AI/)
    expect(() => resolveImageModel(MULTI, { standardId: 42 })).toThrow(/DUO_YUAN_TAN_SUO/)
  })

  it('builds the body from the pinned row', () => {
    const body = buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p', references: [] },
      MULTI, { standardId: 76 })
    const config = JSON.parse(body.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ standardId: 76, platformId: 'DUO_YUAN_TAN_SUO', videoStandardId: 92,
      modelGenerationTypeId: 8 })
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
