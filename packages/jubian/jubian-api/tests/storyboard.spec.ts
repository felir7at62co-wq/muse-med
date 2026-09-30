import { describe, expect, it } from 'vitest'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readStoryboard, withGenerationDisabled, withGenerationEnabled } from '../src/storyboard.ts'

/**
 * A provider snapshot whose saved duration is 8s, i.e. 7000 ms of content plus the one-second hold.
 *
 * `isGenerate` is 1 because that is what the provider stores on every storyboard it holds: ones that
 * already produced videos, ones that never generated and empty placeholders alike.
 */
function snapshot(overrides: Record<string, unknown> = {}) {
  return { id: 916953, scriptId: 2708, isGenerate: 1, storyboardName: '第1集-分镜1',
    prompt: '@[陆沉舟](83749) 走进办公室',
    modelConfig: JSON.stringify({ platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11,
      genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p',
      genNum: 1, prompt: '@[陆沉舟](83749) 走进办公室', materialList: [{ materialKey: '83749', sortOrder: 1 }],
      backupModelList: [] }),
    storyboardMaterialList: [{ materialKey: '83749', sortOrder: 1 }], ...overrides }
}

/**
 * The stub `1699732` of the 2026-09-27 field report: created through `jubian_storyboard create`
 * and unreadable afterwards.
 *
 * This is the structure of the dumped `/aigc/storyboard/1699732` body with the reporter's
 * account fields removed (`createBy`, `userId`, `companyId`, `mainDeptId`, `secondDeptId`) and
 * nothing else changed: `modelConfig` is `null` because nobody saved a model on it, an empty
 * `storyboardMaterialList` is legal, and `episodeCount`, `scriptName`, `remark`, `updateBy`,
 * `updateTime` and `videoSubTaskList` are all `null` on the same body.
 */
function unconfigured(overrides: Record<string, unknown> = {}) {
  return { createTime: '2026-09-27 17:39:22', updateTime: null, updateBy: null, remark: null,
    id: 1699732, scriptId: 2708, episodeId: 80999, episodeCount: null, storyboardName: 'EP25-P1',
    sortOrder: 0, modelConfig: null, scriptName: null, isGenerate: 1, storyboardMaterialList: [],
    videoSubTaskList: null, ...overrides }
}

/** The detail one rejection states, without the payload summary `readPayload` appends to it. */
function refusalDetail(call: () => unknown): string {
  try { call() } catch (error) {
    if (error instanceof JubianError && error.detail !== undefined) return error.detail
    throw error
  }
  throw new Error('the payload was read, so this case states no refusal')
}

describe('readStoryboard', () => {
  it('parses the modelConfig string and keeps the provider snapshot intact', () => {
    const result = readStoryboard(snapshot())
    expect(result.storyboard_id).toBe(916953)
    expect(result.script_id).toBe(2708)
    expect(result.is_generate).toBe(1)
    expect(result.model_config.duration).toBe(8)
    expect(result.content_duration_ms).toBe(7000)
    expect(result.material_keys).toEqual(['83749'])
    expect(result.model_config_defaults).toEqual({})
    expect(result.model_config_notes).toEqual([])
  })

  it('reads and freely saves 2.5 480p settings without enabling generic paid generation', () => {
    const config = { modelId: 'doubao-seedance-2-5-260628',
      ratio: '16:9', resolution: '480p', duration: 30, genNum: 1 }
    const data = snapshot({ modelConfig: config })
    expect(readStoryboard(data).model_config.duration).toBe(30)
    expect(withGenerationDisabled(data)).toEqual({ ...data, isGenerate: 0 })
    expect(() => withGenerationEnabled(data, 14000)).toThrow()
    expect(() => withGenerationEnabled(snapshot({ modelConfig: {
      ...config, duration: 8 } }), 7000)).toThrow()
  })

  it('directs valid 480p boards to native preparation instead of reporting an envelope error', () => {
    const data = snapshot({ modelConfig: { modelId: 'doubao-seedance-2-5-260628',
      ratio: '9:16', resolution: '480p', duration: 13, genNum: 1 } })
    expect(() => withGenerationEnabled(data, 12000)).toThrow('prepare_video → submit_video')
  })

  it('names the field it could not read instead of rejecting the payload anonymously', () => {
    expect(refusalDetail(() => readStoryboard(unconfigured({ scriptId: undefined }))))
      .toContain('scriptId is not a positive integer')
    expect(refusalDetail(() => readStoryboard(unconfigured({ isGenerate: undefined }))))
      .toContain('isGenerate is neither 0 nor 1')
    expect(refusalDetail(() => readStoryboard(unconfigured({ modelConfig: '{not json' }))))
      .toContain('modelConfig is not JSON')
    expect(refusalDetail(() => readStoryboard(unconfigured({ storyboardMaterialList: 'nope' }))))
      .toContain('storyboardMaterialList is not JSON')
    expect(refusalDetail(() => readStoryboard(unconfigured({ storyboardMaterialList: [{}] }))))
      .toContain('storyboardMaterialList[0].materialKey')
  })

  it('says what it received when the provider holds no such storyboard', () => {
    for (const [data, received, missing] of [[null, 'top-level null, excerpt null', 'the payload is not a JSON object'],
      [undefined, 'top-level null, excerpt undefined', 'the payload is not a JSON object'],
      [[], 'top-level array of 0 elements', 'the payload is not a JSON object'],
      [{}, 'top-level object with 0 keys []', 'the storyboard id is not a positive integer']] as const) {
      const detail = refusalDetail(() => readStoryboard(data, 999999))
      expect(detail).toContain(missing)
      expect(detail).toContain('readStoryboard could not read this payload')
      expect(detail).toContain(received)
    }
  })

  it('reads malformed duration for repair while refusing paid generation', () => {
    for (const duration of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER, '8']) {
      const data = snapshot({ episodeId: null, episodeCount: 2, modelConfig: {
        ...JSON.parse(snapshot().modelConfig), duration } })
      const result = readStoryboard(data)
      expect(result.storyboard_id).toBe(916953)
      expect(result.content_duration_ms).toBeNull()
      expect(result.model_config.duration).toBe(duration)
      expect(result.model_config_notes.join(' ')).toContain('duration')
      expect(result.snapshot.episodeId).toBeNull()
      expect(() => withGenerationEnabled(data, 7000)).toThrow()
    }
  })

  it('rejects empty specification labels', () => {
    expect(() => readStoryboard(snapshot({ modelConfig: {
      ratio: '', resolution: '720p', genNum: 1, duration: 8 } }))).toThrow()
  })

  it('rejects a snapshot whose identity does not match the requested storyboard', () => {
    expect(() => readStoryboard(snapshot(), 111)).toThrow()
  })
})

describe('readStoryboard over a storyboard nobody has configured yet (桩件 1699732)', () => {
  it('reads the dumped body through and reports the settings it substituted for the ones the provider did not return', () => {
    const result = readStoryboard(unconfigured(), 1699732)
    expect(result.storyboard_id).toBe(1699732)
    expect(result.script_id).toBe(2708)
    expect(result.is_generate).toBe(1)
    expect(result.name).toBe('EP25-P1')
    expect(result.material_keys).toEqual([])
    expect(result.content_duration_ms).toBeNull()
    expect(result.model_config_defaults).toEqual({ ratio: '9:16', resolution: '720p', genNum: 1 })
    expect(result.model_config).toMatchObject({ ratio: '9:16', resolution: '720p', genNum: 1 })
  })

  it('annotates every substituted value in prose, so a caller reads it as a warning and not as data', () => {
    expect(readStoryboard(unconfigured()).model_config_notes).toEqual([
      '服务端未返回 modelConfig.ratio，已按默认 9:16 处理',
      '服务端未返回 modelConfig.resolution，已按默认 720p 处理',
      '服务端未返回 modelConfig.genNum，已按默认 1 处理',
    ])
  })

  it('treats every legally null sibling as absent, never as a reason to refuse', () => {
    const nulls = { episodeCount: null, scriptName: null, remark: null, updateBy: null, updateTime: null,
      videoSubTaskList: null, storyboardMaterialList: null }
    expect(readStoryboard(unconfigured(nulls), 1699732).snapshot).toMatchObject(nulls)
    // The empty array the dump actually carried is the same storyboard as the null spelling.
    expect(readStoryboard(unconfigured({ storyboardMaterialList: [] })).material_keys).toEqual([])
    // A blank string is this provider's third spelling of an unset modelConfig.
    expect(readStoryboard(unconfigured({ modelConfig: '   ' })).model_config_defaults)
      .toEqual({ ratio: '9:16', resolution: '720p', genNum: 1 })
  })

  it('substitutes only the labels an incomplete saved object did not carry, inline or as JSON text', () => {
    for (const modelConfig of [JSON.stringify({ duration: 8 }), { duration: 8 }]) {
      const result = readStoryboard(unconfigured({ modelConfig }))
      expect(result.content_duration_ms).toBe(7000)
      expect(result.model_config_defaults).toEqual({ ratio: '9:16', resolution: '720p', genNum: 1 })
      expect(result.model_config_notes).toHaveLength(3)
    }
    const partial = readStoryboard(unconfigured({ modelConfig: { duration: 8, ratio: '9:16' } }))
    expect(partial.model_config_defaults).toEqual({ resolution: '720p', genNum: 1 })
    expect(partial.model_config.ratio).toBe('9:16')
  })

  it('reads a material list the provider serialized as JSON text', () => {
    const result = readStoryboard(unconfigured({ storyboardMaterialList: JSON.stringify([{ materialKey: '83749' }]) }))
    expect(result.material_keys).toEqual(['83749'])
  })

  it('still saves it with generation disabled, because that path echoes the provider snapshot', () => {
    const data = unconfigured()
    expect(withGenerationDisabled(data)).toEqual({ ...data, isGenerate: 0 })
  })

  it('refuses paid generation, naming the settings it expected, the payload it received and the way to save them', () => {
    const data = unconfigured()
    const detail = refusalDetail(() => withGenerationEnabled(data, 7000))
    for (const field of ['modelConfig.ratio', 'modelConfig.resolution', 'modelConfig.genNum',
      'modelConfig.duration', 'modelConfig.modelId']) {
      expect(detail).toContain(field)
    }
    expect(detail).toContain('服务端没有返回 modelConfig.ratio、modelConfig.resolution、modelConfig.genNum、modelConfig.duration、modelConfig.modelId')
    // The actual top-level keys of the body it refused, not a promise about a field name.
    expect(detail).toContain(`top-level object with ${Object.keys(data).length} keys [${Object.keys(data).join(', ')}]`)
    expect(detail).toContain('jubian_model preview → apply')
  })

  it('refuses paid generation for a saved configuration that is only missing the channel it would buy from', () => {
    const detail = refusalDetail(() => withGenerationEnabled(unconfigured({ modelConfig: {
      ratio: '9:16', resolution: '720p', genNum: 1, duration: 8 } }), 7000))
    expect(detail).toContain('服务端没有返回 modelConfig.modelId。')
  })
})

describe('withGenerationEnabled (收费路径)', () => {
  it('flips only isGenerate and hands back the provider snapshot untouched', () => {
    const next = withGenerationEnabled(snapshot(), 7000)
    expect(next.isGenerate).toBe(1)
    expect(next.storyboardName).toBe('第1集-分镜1')
    expect(next.storyboardMaterialList).toEqual([{ materialKey: '83749', sortOrder: 1 }])
  })

  it('accepts either stored isGenerate value, because the provider stores 1 on every storyboard', () => {
    expect(withGenerationEnabled(snapshot({ isGenerate: 1 }), 7000).isGenerate).toBe(1)
    expect(withGenerationEnabled(snapshot({ isGenerate: 0 }), 7000).isGenerate).toBe(1)
  })

  it('refuses to generate from a snapshot whose saved duration differs from the requested package', () => {
    expect(() => withGenerationEnabled(snapshot(), 12000)).toThrow()
  })

  it('refuses a package duration outside the supported whole-second range', () => {
    expect(() => withGenerationEnabled(snapshot(), 3000)).toThrow()
    expect(() => withGenerationEnabled(snapshot(), 7000.5)).toThrow()
  })
})

describe('withGenerationDisabled (免费路径)', () => {
  it('forces isGenerate to 0 and preserves the rest', () => {
    const next = withGenerationDisabled(snapshot({ isGenerate: 1 }))
    expect(next.isGenerate).toBe(0)
    expect(next.id).toBe(916953)
  })
})
