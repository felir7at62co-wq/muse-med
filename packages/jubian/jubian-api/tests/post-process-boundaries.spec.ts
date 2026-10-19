/** Live post-process rows reject incompatible selectors before a paid request can be built. */
import { expect, it, vi } from 'vitest'
import { validateVideoDuration } from '../src/native.ts'
import { readStoryboard } from '../src/storyboard.ts'
import { buildSubtitleEraseRequest } from '../src/subtitle.ts'
import { resolvePostProcessModel } from '../src/upscale.ts'
import * as Wire from '../src/wire.ts'

const selection = { modelId: 'new-upscale', platformId: 'LIVE', resolution: '1080p' }
const row = { standardId: 17, modelId: selection.modelId, platformId: selection.platformId,
  videoStandards: [{ id: 18, modelId: selection.modelId, resolution: selection.resolution }] }

it.each([null, {}, 'catalogue'])( 'rejects an unreadable post-process catalogue %j', (value) => {
  expect(() => resolvePostProcessModel(value, selection)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
})
it('resolves the provider standardId alias and rejects malformed or cross-model specifications', () => {
  expect(resolvePostProcessModel([row], selection)).toEqual({ modelId: selection.modelId, platformId: selection.platformId,
    standardId: 17, videoStandardId: 18 })
})
it.each([
  { ...row, videoStandards: null },
  { ...row, videoStandards: [{ id: 18, modelId: 'another-model', resolution: '1080p' }] },
])('rejects incompatible live post-process row %j', (value) => {
  expect(() => resolvePostProcessModel([value], selection)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
})
it('requires a positive integer for models whose duration ceiling is unknown', () => {
  expect(() => validateVideoDuration('provider-new-model', 0)).toThrow('consult the selected provider')
  expect(validateVideoDuration('provider-new-model', 1)).toBe(1)
})
it('does not swallow an unexpected duration decoder failure while reading a provider card', () => {
  const failure = new Error('decoder unavailable')
  const decoder = vi.spyOn(Wire, 'wireInteger').mockImplementationOnce(() => { throw failure })
  try { expect(() => readStoryboard({ id: 1, scriptId: 2, isGenerate: 0, storyboardMaterialList: [], modelConfig: { platformId: 'LIVE', modelId: 'custom', genType: 3, ratio: '16:9', resolution: '1080p', genNum: 1, duration: '8' } })).toThrow('decoder unavailable') }
  finally { decoder.mockRestore() }
})
it('requires an explicit erasure mode and binds custom model selectors to that same model', () => {
  const media = { scriptId: 1, episodeId: 2, episodeCount: 1, firstResultId: 3, parentResultId: 4,
    duration: 8, videoUrl: 'https://media.invalid/video.mp4', taskName: 'erase', videoWidth: 720, videoHeight: 1280 }
  const model = { modelId: 'custom-eraser', platformId: 'LIVE', standardId: 17, videoStandardId: null }
  expect(() => buildSubtitleEraseRequest(model.modelId, media, model)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  expect(() => buildSubtitleEraseRequest('other', media, model, 'region')).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  expect(buildSubtitleEraseRequest(model.modelId, media, model, 'region')).toMatchObject({
    modelId: model.modelId, platformId: model.platformId, standardId: 17, zimuWidth: 719,
  })
})
