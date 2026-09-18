import { describe, expect, it } from 'vitest'
import { defaultSubtitleBox, buildSubtitleEraseRequest, readSubtitleTaskId } from '../src/subtitle.ts'

/** The operator's captured workbench request, reproduced field for field. */
const CAPTURED_SOURCE = {
  scriptId: 2708,
  episodeId: 46734,
  episodeCount: 1,
  firstResultId: 979766,
  parentResultId: 979766,
  duration: 13,
  taskName: '山海自有相逢处-第1集-第1集｜三百万，和我领证｜第二包-去字幕',
  videoUrl: 'https://101.aigc.jubianai.net/prod/media/2026/09/17/aigc_video_979766f610w8q0ly.mp4',
  videoWidth: 720,
  videoHeight: 1280,
}

describe('defaultSubtitleBox', () => {
  it('reproduces the box the workbench submitted for a 720x1280 video', () => {
    // The captured request carried 0 / 570 / 719 / 720 — one pixel inside the
    // frame on width, and the provider's own region on height.
    expect(defaultSubtitleBox(720, 1280)).toEqual({ zimuLeft: 0, zimuTop: 570, zimuWidth: 719, zimuHeight: 720 })
  })

  it('scales to another frame instead of assuming one size', () => {
    const hd = defaultSubtitleBox(1080, 1920)
    expect(hd.zimuLeft).toBe(0)
    // 570 / 1280 and 720 / 1280 are exact ratios, so a taller frame scales them.
    expect(hd.zimuTop).toBe(855)
    expect(hd.zimuWidth).toBe(1079)
    expect(hd.zimuHeight).toBe(1080)
  })

  it('reproduces the measured arithmetic even though the box passes the bottom edge', () => {
    // The captured workbench request sent top 570 + height 720 against a
    // 1280-tall video: ten pixels past the edge, accepted by the provider. This
    // plugin therefore does not clamp the default box to the frame.
    const box = defaultSubtitleBox(720, 1280)
    expect(box.zimuTop + box.zimuHeight).toBeGreaterThan(1280)
  })

  it('refuses a frame it cannot derive a box from', () => {
    expect(() => defaultSubtitleBox(0, 1280)).toThrow()
    expect(() => defaultSubtitleBox(720, 1.5)).toThrow()
  })
})

describe('buildSubtitleEraseRequest', () => {
  it('reproduces the captured workbench body for the regional eraser', () => {
    expect(buildSubtitleEraseRequest('quzimuToB', CAPTURED_SOURCE)).toEqual({ ...CAPTURED_SOURCE,
      taskType: 10, modelId: 'quzimuToB', platformId: 'YU_DIAN', standardId: 26, videoStandardId: null,
      zimuLeft: 0, zimuTop: 570, zimuWidth: 719, zimuHeight: 720 })
  })

  it('honours an explicit rectangle when a caller really knows one', () => {
    const body = buildSubtitleEraseRequest('quzimuToB', { ...CAPTURED_SOURCE,
      subtitleBox: { zimuLeft: 10, zimuTop: 20, zimuWidth: 100, zimuHeight: 50 } })
    expect(body).toMatchObject({ zimuLeft: 10, zimuTop: 20, zimuWidth: 100, zimuHeight: 50 })
  })

  it('takes no rectangle for the automatic route and pins its own selectors', () => {
    const body = buildSubtitleEraseRequest('ark-erase-video-subtitle-pro', CAPTURED_SOURCE)
    expect(body).toMatchObject({ taskType: 10, modelId: 'ark-erase-video-subtitle-pro',
      platformId: 'AI_MEDIA_KIT', standardId: 67, videoStandardId: null })
    expect(body.zimuLeft).toBeUndefined()
    expect(() => buildSubtitleEraseRequest('ark-erase-video-subtitle-pro', { ...CAPTURED_SOURCE,
      subtitleBox: { zimuLeft: 0, zimuTop: 0, zimuWidth: 10, zimuHeight: 10 } })).toThrow()
  })

  it('refuses an unknown model instead of falling back to another route', () => {
    expect(() => buildSubtitleEraseRequest('something-else', CAPTURED_SOURCE)).toThrow()
  })

  it('rejects an explicit box that starts outside the frame', () => {
    expect(() => buildSubtitleEraseRequest('quzimuToB', { ...CAPTURED_SOURCE,
      subtitleBox: { zimuLeft: 0, zimuTop: 1300, zimuWidth: 720, zimuHeight: 400 } })).toThrow()
    expect(() => buildSubtitleEraseRequest('quzimuToB', { ...CAPTURED_SOURCE,
      subtitleBox: { zimuLeft: 0, zimuTop: 100, zimuWidth: 0, zimuHeight: 400 } })).toThrow()
  })
})

describe('readSubtitleTaskId', () => {
  it('reads the single task identity a submitted erasure returns', () => {
    expect(readSubtitleTaskId({ code: 200, data: { taskId: 123, jobId: '123' } })).toBe('123')
    expect(readSubtitleTaskId({ code: 200, data: { taskId: 1, jobId: 2 } })).toBeNull()
    expect(readSubtitleTaskId({ code: 500, data: { taskId: 1 } })).toBeNull()
    expect(readSubtitleTaskId({ code: 200, data: {} })).toBeNull()
  })
})
