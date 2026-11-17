import { describe, expect, it } from 'vitest'
import { needsUpscale, readSubtaskPage, readTaskList, readTaskPage } from '../src/video.ts'

const PARENT = { id: 335343, taskType: 10, taskStatus: 'success', firstResultId: 1, parentResultId: 2,
  realCost: '3.50', estimatedCost: '4.00' }

describe('readTaskPage', () => {
  it.each([0, 3.3906, 3.52, 1e-7])('retains a numeric provider cost %s as text', (amount) => {
    expect(readTaskPage({ id: 544551, realCost: amount, estimatedCost: amount, discountCost: amount }))
      .toMatchObject({ real_cost: String(amount), estimated_cost: String(amount), discount_cost: String(amount) })
    expect(readTaskList({ total: 1, rows: [{ id: 544551, realCost: amount }] }).rows[0]?.real_cost)
      .toBe(String(amount))
  })
  it.each([-1, NaN, Infinity, -Infinity, null, true, {}, 'invalid'])
  ('keeps an unreadable provider cost %j unavailable', (amount) => {
    expect(readTaskPage({ id: 544551, realCost: amount, estimatedCost: amount, discountCost: amount }))
      .toMatchObject({ real_cost: null, estimated_cost: null, discount_cost: null })
  })
  it('leaves malformed optional identifiers null instead of failing a readable task', () => {
    expect(readTaskPage({ id: 1, scriptId: 0, episodeId: 'bad', firstResultId: -1, parentResultId: {},
      episodeCount: 1.5 })).toMatchObject({ task_id: 1, script_id: null, episode_id: null,
      first_result_id: null, parent_result_id: null, episode_count: null })
  })
  it('reads task identity, status and the cost observation when present', () => {
    expect(readTaskPage(PARENT)).toEqual({ task_id: 335343, task_type: 10, status: 'success',
      first_result_id: 1, parent_result_id: 2, real_cost: '3.50', estimated_cost: '4.00', discount_cost: null,
      script_id: null, episode_id: null, episode_count: null, task_name: null })
  })

  it('reads the project, episode and count a billed method needs', () => {
    // Captured from a real task row. The subtitle erasure takes the project from
    // here, which is what lets a caller send a correct request with only
    // task_id and the frame size.
    const row = readTaskPage({ id: 428322, taskType: 1, taskStatus: 'succeeded', scriptId: 2708,
      episodeId: 46734, episodeCount: 1, taskName: 'null-第1集-第1集｜三百万，和我领证｜第二包' })
    expect(row.script_id).toBe(2708)
    expect(row.episode_id).toBe(46734)
    expect(row.episode_count).toBe(1)
    expect(row.task_name).toBe('null-第1集-第1集｜三百万，和我领证｜第二包')
  })

  it('leaves an absent cost observation null instead of inventing zero', () => {
    expect(readTaskPage({ id: 1, taskType: 1, taskStatus: 'running' }).real_cost).toBeNull()
  })

  it('rejects a payload with no identity', () => {
    expect(() => readTaskPage({ taskStatus: 'running' })).toThrow()
  })
})

describe('readTaskList', () => {
  it('reads a page of generation tasks', () => {
    expect(readTaskList({ total: 1, rows: [PARENT] }).rows[0]!.task_id).toBe(335343)
  })
})

describe('readSubtaskPage', () => {
  it('preserves unknown stage types and both image URL field spellings', () => {
    const row = readSubtaskPage({ rows: [{ subTaskId: 1, imageMaterials: [{ materialUrl: 'https://media.example/ref.png' }],
      resultList: [{ taskType: 999, lastTaskType: 999, tosVideoUrl: 'https://media.example/result.mp4' }] }] }).rows[0]!
    expect(row.versions).toEqual([expect.objectContaining({ task_type: 999, stage: null })])
    expect(row.image_urls).toEqual(['https://media.example/ref.png'])
    expect(row.last_stage).toBeNull()
  })
  it('reads child identity, duration and the single video material URL', () => {
    const child = { id: 990, aigcVideoTaskId: 335343, taskType: 10, taskStatus: 'success', genNum: 1, duration: 13,
      zimuLeft: 0, zimuTop: 900, zimuWidth: 720, zimuHeight: 300, modelId: 'doubao-seedance-2-0-260128',
      standardId: 8, resolution: '720p', firstResultId: 11, parentResultId: 12,
      videoMaterials: [{ videoUrl: 'https://x/v.mp4', aigcVideoTaskId: 335343, aigcVideoSubTaskId: 990 }] }
    const row = readSubtaskPage({ total: 1, rows: [child] }).rows[0]!
    expect(row).toMatchObject({ subtask_id: 990, parent_task_id: 335343, status: 'success',
      duration_seconds: 13, gen_num: 1,
      subtitle_box: { zimuLeft: 0, zimuTop: 900, zimuWidth: 720, zimuHeight: 300 },
      video_url: 'https://x/v.mp4', base_video_url: null, image_urls: [],
      model_id: 'doubao-seedance-2-0-260128', standard_id: 8, resolution: '720p',
      first_result_id: 11, parent_result_id: 12, last_task_type: null, last_stage: null,
      hd_count: null, expiration_time: null, versions: [],
      subtitle_erased: false, upscaled: false, upscale_model_id: null })
  })

  it('reads the live payload shape, where the finished file sits on resultList', () => {
    // Captured from a real project. `resultVideoUrl` is deliberately present and
    // deliberately NOT chosen: it lives on an origin the download allowlist does
    // not accept, while `tosVideoUrl` is on the one it does.
    const child = { id: 972949, aigcVideoTaskId: 428322, taskStatus: 'succeeded', genNum: 1, duration: 13,
      zimuLeft: null, zimuTop: null, zimuWidth: null, zimuHeight: null,
      modelId: 'doubao-seedance-2-0-260128', standardId: 8, resolution: '720p',
      videoExpirationTime: '2026-09-18 14:28:10',
      videoMaterials: null,
      imageMaterials: [{ imageUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/a.jpg' },
        { imageUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/b.png' }],
      resultList: [{ resultVideoUrl: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/x',
        tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/v.mp4' }] }
    const page = readSubtaskPage({ total: 1, rows: [child] })
    expect(page.rows[0]!.video_url).toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/v.mp4')
    expect(page.rows[0]!.base_video_url).toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/v.mp4')
    expect(page.rows[0]!.image_urls).toEqual(['https://jubian-aigc.tos-cn-beijing.volces.com/a.jpg',
      'https://jubian-aigc.tos-cn-beijing.volces.com/b.png'])
    expect(page.rows[0]!.subtitle_box).toBeNull()
    // The stage a caller is looking at is only knowable from the provider's own
    // recorded fields, never from the file itself.
    expect(page.rows[0]!.model_id).toBe('doubao-seedance-2-0-260128')
    expect(page.rows[0]!.resolution).toBe('720p')
    expect(page.rows[0]!.standard_id).toBe(8)
    expect(page.rows[0]!.upscaled).toBe(false)
  })

  it('reports a completed upscale: hdCount 1, stage upscale, and a newer file', () => {
    // Captured right after the operator ran one upscale on this project.
    const child = { id: 972949, aigcVideoTaskId: 428322, taskStatus: 'succeeded', duration: 13,
      modelId: 'doubao-seedance-2-0-260128', standardId: 8, resolution: '720p',
      resultList: [{ taskType: 1, hdCount: 1, lastTaskType: 20, resultStatus: 'succeeded',
        lastModelId: '2074071626416742401',
        tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/17/base.mp4',
        lastTosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/18/hd.mp4' }] }
    const row = readSubtaskPage({ total: 1, rows: [child] }).rows[0]!
    expect(row.upscaled).toBe(true)
    expect(row.hd_count).toBe(1)
    expect(row.last_task_type).toBe(20)
    expect(row.last_stage).toBe('upscale')
    // The newest file is the one to use; the generation file stays behind.
    expect(row.video_url).toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/18/hd.mp4')
    expect(row.base_video_url).toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/17/base.mp4')
    expect(row.upscale_model_id).toBe('2074071626416742401')
    expect(needsUpscale(row, '1080p')).toBe(false)
  })

  it('reports the upscaled sibling the provider creates as its own subtask', () => {
    const child = { id: 982120, aigcVideoTaskId: 428322, taskStatus: 'succeeded', duration: 13,
      modelId: '2074071626416742401', standardId: 55, resolution: '1080p',
      resultList: [{ taskType: 20, hdCount: 1, lastTaskType: 20, resultStatus: 'succeeded',
        tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/18/hd.mp4',
        lastTosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/2026/09/18/hd.mp4' }] }
    const row = readSubtaskPage({ total: 1, rows: [child] }).rows[0]!
    expect(row.resolution).toBe('1080p')
    expect(row.model_id).toBe('2074071626416742401')
    expect(row.upscaled).toBe(true)
    expect(row.upscale_model_id).toBe('2074071626416742401')
    expect(row.video_url).toBe(row.base_video_url)
  })

  it.each([
    { label: 'a source row whose newest stage is an upscale', taskType: 1, lastTaskType: 20,
      lastModelId: 'AI MediaKit', expected: 'AI MediaKit' },
    { label: 'the upscale row itself', taskType: 20, lastTaskType: 20, lastModelId: undefined, expected: 'row-model' },
    { label: 'an upscale followed by erasure on a source row', taskType: 1, lastTaskType: 10,
      lastModelId: 'ark-erase-video-subtitle-pro', expected: null },
  ])('names the upscale model from $label', ({ taskType, lastTaskType, lastModelId, expected }) => {
    const row = readSubtaskPage({ rows: [{ id: 1, modelId: 'row-model', resolution: '720p', resultList: [{
      taskType, lastTaskType, hdCount: 1, lastModelId, tosVideoUrl: 'https://media.example/current.mp4' }] }] }).rows[0]!
    expect(row.upscale_model_id).toBe(expected)
  })

  it.each(['failed', 'running', undefined])('does not treat an erasure stage with status %s as clean', (status) => {
    const row = readSubtaskPage({ rows: [{ id: 1, taskStatus: 'succeeded', resultList: [{
      taskType: 1, resultStatus: 'succeeded', lastTaskType: 10, lastResultStatus: status,
      tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/base.mp4',
      lastTosVideoUrl: '',
    }] }] }).rows[0]!
    expect(row.subtitle_erased).toBe(false)
    expect(row.video_url).toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/base.mp4')
  })

  it('requires an available artifact even when an erasure reports success', () => {
    const row = readSubtaskPage({ rows: [{ id: 1, resultList: [{ taskType: 10,
      resultStatus: 'succeeded', lastTaskType: 10, lastResultStatus: 'succeeded' }] }] }).rows[0]!
    expect(row.subtitle_erased).toBe(false)
  })

  it('does not apply an older successful erasure verdict to a different current file', () => {
    const row = readSubtaskPage({ rows: [{ id: 1, resultList: [
      { taskType: 1, resultStatus: 'succeeded', tosVideoUrl: 'https://x/base.mp4' },
      { taskType: 10, resultStatus: 'succeeded', tosVideoUrl: 'https://x/clean.mp4' },
    ] }] }).rows[0]!
    expect(row.subtitle_erased).toBe(false)
  })

  it('reports a successful erasure only with its processed file, without calling it an upscale', () => {
    const child = { id: 1, aigcVideoTaskId: 2, taskStatus: 'succeeded', resolution: '720p',
      resultList: [{ taskType: 1, hdCount: 0, lastTaskType: 10, resultStatus: 'succeeded',
        lastResultStatus: 'succeeded',
        tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/base.mp4',
        lastTosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/clean.mp4' }] }
    const row = readSubtaskPage({ total: 1, rows: [child] }).rows[0]!
    expect(row.subtitle_erased).toBe(true)
    expect(row.last_stage).toBe('erase_subtitle')
    expect(row.upscaled).toBe(false)
  })

  it('falls back to originalVideoUrl when tosVideoUrl is absent', () => {
    const child = { id: 1, aigcVideoTaskId: 2, taskStatus: 'succeeded',
      resultList: [{ originalVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/o.mp4' }] }
    expect(readSubtaskPage({ total: 1, rows: [child] }).rows[0]!.video_url)
      .toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/o.mp4')
  })

  it('reports a null subtitle box when the provider omits geometry', () => {
    const child = { id: 1, aigcVideoTaskId: 2, taskStatus: 'running', videoMaterials: [] }
    expect(readSubtaskPage({ total: 1, rows: [child] }).rows[0]!.subtitle_box).toBeNull()
    expect(readSubtaskPage({ total: 1, rows: [child] }).rows[0]!.video_url).toBeNull()
  })
})

describe('needsUpscale', () => {
  const SEEDVR2 = '2074071626416742401'
  const generated = { model_id: 'doubao-seedance-2-0-260128', upscale_model_id: null, upscaled: false }

  it('flags a source below the delivery target and clears one at or above it', () => {
    expect(needsUpscale({ ...generated, resolution: '480p' }, '1080p')).toBe(true)
    expect(needsUpscale({ ...generated, resolution: '720p' }, '1080p')).toBe(true)
    expect(needsUpscale({ ...generated, resolution: '1080p' }, '1080p')).toBe(false)
    expect(needsUpscale({ ...generated, resolution: '1080p' }, '720p')).toBe(false)
  })

  it('returns null rather than a guess when a label is unrecognised', () => {
    expect(needsUpscale({ ...generated, resolution: null }, '1080p')).toBeNull()
    expect(needsUpscale({ ...generated, resolution: '480p' }, 'ultra')).toBeNull()
  })

  it('ranks a source row after a recorded SeedVR2 pass at its single 1080p standard', () => {
    const row = { ...generated, upscaled: true, upscale_model_id: SEEDVR2 }
    expect(needsUpscale({ ...row, resolution: '720p' }, '1080p')).toBe(false)
    expect(needsUpscale({ ...row, resolution: null }, '1080p')).toBe(false)
    expect(needsUpscale({ ...row, resolution: '720p' }, '2K')).toBe(true)
  })

  it.each([
    { resolution: '1080p', target: '1080p', expected: false },
    { resolution: null, target: '1080p', expected: false },
    { resolution: null, target: '2K', expected: true },
  ])('ranks the SeedVR2 upscale row labelled $resolution at its single 1080p standard against $target',
    ({ resolution, target, expected }) => {
      expect(needsUpscale({ model_id: SEEDVR2, upscale_model_id: SEEDVR2, upscaled: true, resolution }, target))
        .toBe(expected)
    })

  it.each([
    { label: 'MediaKit', upscale_model_id: 'AI MediaKit' },
    { label: 'an unnamed model', upscale_model_id: null },
  ])('leaves a source row after a $label pass unranked below the target', ({ upscale_model_id }) => {
    const row = { ...generated, upscaled: true, upscale_model_id }
    expect(needsUpscale({ ...row, resolution: '720p' }, '1080p')).toBeNull()
    expect(needsUpscale({ ...row, resolution: null }, '1080p')).toBeNull()
    expect(needsUpscale({ ...row, resolution: '720p' }, '720p')).toBe(false)
  })

  it.each([
    { resolution: '1080p', expected: false },
    { resolution: '720p', expected: true },
    { resolution: null, expected: null },
  ])('reads the upscale row\'s own $resolution label as the pass output', ({ resolution, expected }) => {
    expect(needsUpscale({ model_id: 'AI MediaKit', upscale_model_id: 'AI MediaKit', upscaled: true, resolution },
      '1080p')).toBe(expected)
  })
})
