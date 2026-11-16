import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MEDIAKIT_UPSCALE_MODEL, SEEDVR2_UPSCALE_MODEL, buildVideoUpscaleRequest, readUpscaleTaskId,
  resolvePostProcessModel } from '../src/upscale.ts'

const UPSCALE_ROWS = (JSON.parse(readFileSync(new URL('./fixtures/catalogue-20261016.json', import.meta.url), 'utf8')) as
  Record<string, unknown[]>)['20']

/** The SeedVR2 selectors of the captured workbench request. */
const SEEDVR2 = { ...SEEDVR2_UPSCALE_MODEL, standardId: 55, videoStandardId: 303 }

/** The operator's captured workbench request, reproduced field for field. */
const CAPTURED = {
  scriptId: 2708,
  episodeId: 46734,
  episodeCount: 1,
  firstResultId: 979766,
  parentResultId: 979766,
  duration: 13,
  taskName: '山海自有相逢处-第1集-第1集｜三百万，和我领证｜第二包-高清转换',
  videoUrl: 'https://101.aigc.jubianai.net/prod/media/2026/09/17/aigc_video_979766f610w8q0ly.mp4',
}

describe('buildVideoUpscaleRequest', () => {
  it('reproduces the captured workbench body', () => {
    expect(buildVideoUpscaleRequest(CAPTURED, SEEDVR2)).toEqual({ ...CAPTURED,
      taskType: 20, modelId: '2074071626416742401', platformId: 'RUNNING_HUB',
      standardId: 55, videoStandardId: 303 })
  })

  it.each([
    { model: MEDIAKIT_UPSCALE_MODEL, standardId: 27, videoStandardId: 165 },
    { model: SEEDVR2_UPSCALE_MODEL, standardId: 55, videoStandardId: 303 },
  ])('resolves $model.modelId at 1080p from the captured live catalogue', ({ model, standardId, videoStandardId }) => {
    const selected = resolvePostProcessModel(UPSCALE_ROWS, { ...model, resolution: '1080p' })
    expect(selected).toEqual({ ...model, standardId, videoStandardId })
    expect(buildVideoUpscaleRequest(CAPTURED, selected)).toMatchObject({ taskType: 20, ...model,
      standardId, videoStandardId })
  })

  it('never emits taskType 2, which is an image operation, not this stage', () => {
    expect(buildVideoUpscaleRequest(CAPTURED, SEEDVR2).taskType).toBe(20)
    expect(buildVideoUpscaleRequest(CAPTURED, SEEDVR2).taskType).not.toBe(2)
  })

  it('passes the provider URL through verbatim instead of rewriting its host', () => {
    const body = buildVideoUpscaleRequest({ ...CAPTURED,
      videoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/17/x.mp4' }, SEEDVR2)
    expect(body.videoUrl).toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/17/x.mp4')
  })

  it('rejects an unusable source rather than sending a request the provider refuses', () => {
    expect(() => buildVideoUpscaleRequest({ ...CAPTURED, videoUrl: 'http://x/y.mp4' }, SEEDVR2)).toThrow()
    expect(() => buildVideoUpscaleRequest({ ...CAPTURED, duration: 0 }, SEEDVR2)).toThrow()
    expect(() => buildVideoUpscaleRequest({ ...CAPTURED, firstResultId: 0 }, SEEDVR2)).toThrow()
    expect(() => buildVideoUpscaleRequest({ ...CAPTURED, taskName: '  ' }, SEEDVR2)).toThrow()
  })
})

describe('readUpscaleTaskId', () => {
  it('reads the identity a submitted upscale returns', () => {
    expect(readUpscaleTaskId({ code: 200, data: 429001 })).toBe('429001')
    expect(readUpscaleTaskId({ code: 200, data: { id: 429001 } })).toBe('429001')
    expect(readUpscaleTaskId({ code: 200, data: { taskId: '429001' } })).toBe('429001')
    expect(readUpscaleTaskId({ code: 200, data: { aigcVideoTaskId: 429001 } })).toBe('429001')
  })

  it('returns null when the provider returns no identity, so a caller never invents one', () => {
    expect(readUpscaleTaskId({ code: 200, data: 'ok' })).toBeNull()
    expect(readUpscaleTaskId({ code: 200, data: {} })).toBeNull()
    expect(readUpscaleTaskId(null)).toBeNull()
  })
})
