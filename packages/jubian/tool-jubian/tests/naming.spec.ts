import { describe, expect, it } from 'vitest'
import { ASSET_CATEGORIES, ASSET_CATEGORY_TYPES, auditAssetName, carriedEpisode, categoryOfType,
  composedAssetName, declaredCategory, episodePrefix, normalizedEpisode, resolveNaming, taskPrefix }
  from '../src/naming.ts'

const NAMING = resolveNaming()

describe('resolveNaming', () => {
  it('applies the convention\'s defaults', () => {
    expect(NAMING).toEqual({ separator: '｜', seriesLabel: '全剧' })
  })

  it('takes a deployment\'s own separator and series label', () => {
    expect(resolveNaming({ separator: '|', seriesLabel: '全季' })).toEqual({ separator: '|', seriesLabel: '全季' })
  })

  it('refuses a blank separator or series label at mount', () => {
    expect(() => resolveNaming({ separator: '  ' })).toThrow(/separator and series label/)
    expect(() => resolveNaming({ seriesLabel: '' })).toThrow(/separator and series label/)
  })
})

describe('normalizedEpisode', () => {
  it('pads a number to two digits and leaves a longer one alone', () => {
    expect(normalizedEpisode('5')).toBe('05')
    expect(normalizedEpisode(5)).toBe('05')
    expect(normalizedEpisode('105')).toBe('105')
  })

  it('reports null for anything that is not a number', () => {
    expect(normalizedEpisode('番外')).toBeNull()
    expect(normalizedEpisode('')).toBeNull()
  })
})

describe('episodePrefix', () => {
  it('composes the episode token', () => {
    expect(episodePrefix('5', NAMING)).toBe('EP05')
    expect(episodePrefix('05', NAMING)).toBe('EP05')
  })

  it('passes the configured series label through untouched', () => {
    expect(episodePrefix('全剧', NAMING)).toBe('全剧')
    expect(episodePrefix('全季', resolveNaming({ seriesLabel: '全季' }))).toBe('全季')
  })

  it('names the argument it could not use', () => {
    expect(() => episodePrefix('番外', NAMING)).toThrow(/episode=番外/)
  })
})

describe('composedAssetName', () => {
  it('composes an episode asset and a series master', () => {
    expect(composedAssetName('5', '道具', '红包', NAMING)).toBe('EP05｜道具｜红包')
    expect(composedAssetName('全剧', '角色', '陆沉舟', NAMING)).toBe('全剧｜角色｜陆沉舟')
  })

  it('trims the name it was given', () => {
    expect(composedAssetName('5', '场景', '  天台  ', NAMING)).toBe('EP05｜场景｜天台')
  })

  it('refuses an empty name rather than composing a nameless asset', () => {
    expect(() => composedAssetName('5', '道具', '   ', NAMING)).toThrow(/asset_name/)
  })

  it('honours a configured separator', () => {
    expect(composedAssetName('5', '道具', '红包', resolveNaming({ separator: '|' }))).toBe('EP05|道具|红包')
  })
})

describe('taskPrefix', () => {
  it('composes the episode prefix, with and without a package number', () => {
    expect(taskPrefix('5', undefined, NAMING)).toBe('EP05')
    expect(taskPrefix('5', '3', NAMING)).toBe('EP05-P3')
    expect(taskPrefix(5, 3, NAMING)).toBe('EP05-P3')
    expect(taskPrefix('全剧', '2', NAMING)).toBe('全剧-P2')
  })

  it('refuses a package number that is not a number', () => {
    expect(() => taskPrefix('5', '上', NAMING)).toThrow(/package_number=上/)
  })
})

describe('auditAssetName', () => {
  it('accepts both conventional forms', () => {
    expect(auditAssetName('EP05｜道具｜红包', NAMING)).toEqual({ conforming: true, reason: null })
    expect(auditAssetName('全剧｜角色｜陆沉舟', NAMING)).toEqual({ conforming: true, reason: null })
  })

  it('rejects the legacy names the pipeline wrote before the convention', () => {
    expect(auditAssetName('陆沉舟｜高定西装｜16x9｜v1', NAMING))
      .toEqual({ conforming: false, reason: '缺少集号前缀（应为 EP{两位集数} 或 全剧）' })
  })

  it('reports a name with too few segments', () => {
    expect(auditAssetName('EP05', NAMING).reason).toMatch(/缺少类别与名称段/)
  })

  it('reports a category segment that is not one of the three', () => {
    expect(auditAssetName('EP05｜服装｜红包', NAMING).reason).toBe('类别段 服装 不是 角色、场景、道具')
  })

  it('reports an empty name segment', () => {
    expect(auditAssetName('EP05｜道具｜ ', NAMING).reason).toBe('名称段为空')
  })
})

describe('categoryOfType', () => {
  it('names every category the console pages on, and nothing else', () => {
    expect(ASSET_CATEGORIES.map(category => ASSET_CATEGORY_TYPES[category])).toEqual([1, 2, 3])
    expect(categoryOfType(1)).toBe('角色')
    expect(categoryOfType(2)).toBe('场景')
    expect(categoryOfType(3)).toBe('道具')
    expect(categoryOfType(4)).toBeNull()
    expect(categoryOfType(null)).toBeNull()
  })
})

describe('declaredCategory', () => {
  it('reads the category segment of a conventional name', () => {
    expect(declaredCategory('EP05｜道具｜红包', NAMING)).toBe('道具')
  })

  it('reads a legacy category prefix in either language', () => {
    expect(declaredCategory('scene_酒店套房', NAMING)).toBe('场景')
    expect(declaredCategory('prop-红包', NAMING)).toBe('道具')
    expect(declaredCategory('角色_陆沉舟', NAMING)).toBe('角色')
  })

  it('reads the scene slugs the pipeline writes between segments', () => {
    expect(declaredCategory('EP03｜天台｜夜｜内', NAMING)).toBe('场景')
    expect(declaredCategory('EP03｜天台｜日｜内', NAMING)).toBe('场景')
  })

  it('declares nothing for a name that says nothing', () => {
    expect(declaredCategory('陆沉舟｜高定西装｜16x9｜v1', NAMING)).toBeNull()
  })
})

describe('carriedEpisode', () => {
  it('reads the episode token a name carries, in any position', () => {
    expect(carriedEpisode('EP05-P3-sb12-去字幕', NAMING)).toBe('EP05')
    expect(carriedEpisode('sb12-EP05', NAMING)).toBe('EP05')
    expect(carriedEpisode('全剧｜角色｜陆沉舟', NAMING)).toBe('全剧')
  })

  it('reports null when the name carries no token', () => {
    expect(carriedEpisode('sb12-去字幕', NAMING)).toBeNull()
    expect(carriedEpisode('EP5-x', NAMING)).toBeNull()
  })
})
