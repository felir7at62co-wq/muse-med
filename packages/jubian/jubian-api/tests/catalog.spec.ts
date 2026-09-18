import { describe, expect, it } from 'vitest'
import { readEpisodes, readModels, readScript } from '../src/catalog.ts'

const IMAGE_MODEL = { id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
  genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }

describe('readModels', () => {
  it('passes catalogue rows through and rejects a non-array', () => {
    expect(readModels([IMAGE_MODEL])).toEqual([IMAGE_MODEL])
    expect(() => readModels({ nope: true })).toThrow()
  })
})

describe('readScript', () => {
  it('keeps the identity and name fields a project read needs', () => {
    expect(readScript({ id: 2708, name: '山海自有相逢处', productionType: 2, extra: 'ignored' }))
      .toEqual({ script_id: 2708, name: '山海自有相逢处', production_type: 2 })
  })

  it('rejects a payload without a usable identity', () => {
    expect(() => readScript({ name: 'x' })).toThrow()
    expect(() => readScript(null)).toThrow()
  })
})

describe('readEpisodes', () => {
  it('reads one envelope page into rows plus its total', () => {
    expect(readEpisodes({ total: 2, rows: [{ id: 1, name: '第1集' }, { id: 2, name: '第2集' }] }))
      .toEqual({ total: 2, rows: [{ episode_id: 1, name: '第1集' }, { episode_id: 2, name: '第2集' }] })
  })

  it('rejects a payload that is not a page', () => {
    expect(() => readEpisodes({ total: 2 })).toThrow()
  })
})
