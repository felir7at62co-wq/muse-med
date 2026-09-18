import { describe, expect, it } from 'vitest'
import { readStoryboard, withGenerationDisabled, withGenerationEnabled } from '../src/storyboard.ts'

/** A provider snapshot whose saved duration is 8s, i.e. 7000 ms of content plus the one-second hold. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return { id: 916953, scriptId: 2708, isGenerate: 0, storyboardName: '第1集-分镜1',
    prompt: '@[陆沉舟](83749) 走进办公室',
    modelConfig: JSON.stringify({ platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-1', standardId: 11,
      genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p',
      genNum: 1, prompt: '@[陆沉舟](83749) 走进办公室', materialList: [{ materialKey: '83749', sortOrder: 1 }],
      backupModelList: [] }),
    storyboardMaterialList: [{ materialKey: '83749', sortOrder: 1 }], ...overrides }
}

describe('readStoryboard', () => {
  it('parses the modelConfig string and keeps the provider snapshot intact', () => {
    const result = readStoryboard(snapshot())
    expect(result.storyboard_id).toBe(916953)
    expect(result.script_id).toBe(2708)
    expect(result.is_generate).toBe(0)
    expect(result.model_config.duration).toBe(8)
    expect(result.content_duration_ms).toBe(7000)
    expect(result.material_keys).toEqual(['83749'])
  })

  it('rejects a snapshot whose identity does not match the requested storyboard', () => {
    expect(() => readStoryboard(snapshot(), 111)).toThrow()
  })
})

describe('withGenerationEnabled (收费路径)', () => {
  it('flips only isGenerate and hands back the provider snapshot untouched', () => {
    const next = withGenerationEnabled(snapshot(), 7000)
    expect(next.isGenerate).toBe(1)
    expect(next.storyboardName).toBe('第1集-分镜1')
    expect(next.storyboardMaterialList).toEqual([{ materialKey: '83749', sortOrder: 1 }])
  })

  it('refuses to generate from a snapshot whose saved duration differs from the requested package', () => {
    expect(() => withGenerationEnabled(snapshot(), 12000)).toThrow()
  })

  it('refuses a snapshot that is already generating', () => {
    expect(() => withGenerationEnabled(snapshot({ isGenerate: 1 }), 7000)).toThrow()
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
