/** Account catalogue captured by read-only queries; these checks submit no provider requests. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildNativeVideoPreview, resolveVideoModel } from '../src/native.ts'
import { buildImageRequest } from '../src/image.ts'
import { buildSubtitleEraseRequest } from '../src/subtitle.ts'
import { buildVideoUpscaleRequest, resolvePostProcessModel } from '../src/upscale.ts'

interface Model {
  id: number
  modelId: string
  platformId: string
  genTypes: { id: number; type: number }[]
  videoStandards: { id: number; ratio: string; resolution: string }[]
}
const catalogue = JSON.parse(readFileSync(new URL('./fixtures/catalogue-20261016.json', import.meta.url), 'utf8')) as Record<string, Model[]>
const media = { scriptId: 1, episodeId: 2, episodeCount: 1, firstResultId: 3, parentResultId: 4,
  duration: 8, videoUrl: 'https://example.invalid/video.mp4', taskName: 'catalogue check' }

describe('live catalogue models', () => {
  it.each(catalogue['1']!)('resolves video $modelId on $platformId', (row) => {
    const standard = row.videoStandards[0]!
    const resolved = resolveVideoModel(catalogue['1'], { modelId: row.modelId, platformId: row.platformId,
      ratio: standard.ratio, resolution: standard.resolution, genType: row.genTypes[0]!.type, duration: 8, genNum: 1 })
    expect(resolved).toMatchObject({ modelId: row.modelId, platformId: row.platformId, standardId: row.id,
      videoStandardId: standard.id, duration: 8 })
    const material = { assetId: 'lead', materialAssetId: 8, fileName: 'Lead', materialKey: 'lead',
      materialType: 'image', materialUrl: 'https://example.invalid/lead.png', sortOrder: 1 }
    const preview = buildNativeVideoPreview({ createdAt: '2026-10-16T12:00:00.000Z',
      models: catalogue['1'], assets: [{ id: 8, scriptId: 1, assetUrl: material.materialUrl, official: true,
        asset_status: 'confirmed', isUsed: 1 }], storyboard: { id: 5, scriptId: 1,
        storyboardMaterialList: [material], modelConfig: JSON.stringify({ ...resolved,
          prompt: '@[Lead](lead) walks into the room.', materialList: [material], backupModelList: [] }) } })
    expect(JSON.parse(String(preview.payload.modelConfig))).toMatchObject({ modelId: row.modelId,
      platformId: row.platformId, videoStandardId: standard.id })
  })

  it.each(catalogue['2']!)('prepares an image with $modelId on $platformId', (row) => {
    const request = buildImageRequest({ scriptId: 1, assetName: 'catalogue check', assetType: 1,
      prompt: 'Character portrait', references: [] }, catalogue['2'], { modelId: row.modelId, platformId: row.platformId,
      videoStandardId: row.videoStandards.find(standard => standard.ratio === '16:9')!.id })
    expect(JSON.parse(String(request.modelConfig))).toMatchObject({ modelId: row.modelId,
      platformId: row.platformId, standardId: row.id, ratio: '16:9' })
  })

  it.each(catalogue['20']!)('prepares upscale $modelId on $platformId', (row) => {
    const model = resolvePostProcessModel(catalogue['20'], { modelId: row.modelId, platformId: row.platformId, resolution: '1080p' })
    expect(buildVideoUpscaleRequest(media, model)).toMatchObject({ taskType: 20,
      modelId: row.modelId, platformId: row.platformId, standardId: row.id })
  })

  it.each(catalogue['10']!)('prepares subtitle erasure $modelId on $platformId', (row) => {
    const model = resolvePostProcessModel(catalogue['10'], { modelId: row.modelId, platformId: row.platformId })
    expect(buildSubtitleEraseRequest(row.modelId, { ...media, videoWidth: 1920, videoHeight: 1080 }, model))
      .toMatchObject({ taskType: 10, modelId: row.modelId, platformId: row.platformId, standardId: row.id })
  })

  it.each(catalogue['10']!)('rejects a conflicting erasure route for $modelId', (row) => {
    expect(() => buildSubtitleEraseRequest(row.modelId, { ...media, videoWidth: 1920, videoHeight: 1080 },
      undefined, row.modelId === 'quzimuToB' ? 'automatic' : 'region')).toThrow()
  })

  it('refuses models, platforms and output standards absent from the selected task catalogue', () => {
    expect(() => resolvePostProcessModel(catalogue['20'], { modelId: 'missing' })).toThrow()
    expect(() => resolvePostProcessModel(catalogue['20'], { modelId: catalogue['20']![0]!.modelId, platformId: 'other' })).toThrow()
    expect(() => resolvePostProcessModel(catalogue['20'], { modelId: catalogue['20']![0]!.modelId, resolution: '8k' })).toThrow()
    expect(() => resolveVideoModel(catalogue['1'], { modelId: 'missing', platformId: 'FANG_ZHOU',
      ratio: '16:9', resolution: '720p', genType: 3, duration: 8, genNum: 1 })).toThrow()
  })
})
