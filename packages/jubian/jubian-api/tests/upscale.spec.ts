import { describe, expect, it } from 'vitest'
import { VIDEO_UPSCALE_MODEL, buildVideoUpscaleRequest, readUpscaleTaskId } from '../src/upscale.ts'

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
    expect(buildVideoUpscaleRequest(CAPTURED)).toEqual({ ...CAPTURED,
      taskType: 20, modelId: '2074071626416742401', platformId: 'RUNNING_HUB',
      standardId: 55, videoStandardId: 303 })
  })

  it('pins the SeedVR2 selectors the workbench uses by default', () => {
    expect(VIDEO_UPSCALE_MODEL).toEqual({ modelId: '2074071626416742401', platformId: 'RUNNING_HUB',
      standardId: 55, videoStandardId: 303 })
  })

  it('never emits taskType 2, which is an image operation, not this stage', () => {
    expect(buildVideoUpscaleRequest(CAPTURED).taskType).toBe(20)
    expect(buildVideoUpscaleRequest(CAPTURED).taskType).not.toBe(2)
  })

  it('passes the provider URL through verbatim instead of rewriting its host', () => {
    const body = buildVideoUpscaleRequest({ ...CAPTURED,
      videoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/17/x.mp4' })
    expect(body.videoUrl).toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/17/x.mp4')
  })

  it('rejects an unusable source rather than sending a request the provider refuses', () => {
    expect(() => buildVideoUpscaleRequest({ ...CAPTURED, videoUrl: 'http://x/y.mp4' })).toThrow()
    expect(() => buildVideoUpscaleRequest({ ...CAPTURED, duration: 0 })).toThrow()
    expect(() => buildVideoUpscaleRequest({ ...CAPTURED, firstResultId: 0 })).toThrow()
    expect(() => buildVideoUpscaleRequest({ ...CAPTURED, taskName: '  ' })).toThrow()
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
