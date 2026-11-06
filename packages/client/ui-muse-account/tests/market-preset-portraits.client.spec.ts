import { expect, it } from 'vitest'
import { findMarketPresetPortrait, marketPresetPortraits, matchMarketPresetPortrait } from '../src/client/market-preset-portraits.ts'
import { matchUnboundMarketPresetPortrait, resolveMarketSkillArtwork } from '../src/client/market-skill-artwork.ts'
import { marketFixture } from './market-fixture.client.ts'

it('assigns all 50 profession characters using either supported market language', () => {
  expect(marketPresetPortraits).toHaveLength(50)
  expect(new Set(marketPresetPortraits.map(row => row.id)).size).toBe(50)
  for (const row of marketPresetPortraits) {
    expect(findMarketPresetPortrait(row.id)).toBe(row)
    expect(matchMarketPresetPortrait({ title: row.name })).toBe(row)
    expect(matchMarketPresetPortrait({ title: row.nameEn })).toBe(row)
  }
  expect(findMarketPresetPortrait('storyboard-director')).toBeUndefined()
})

it('uses purpose and distinguishes related roles in a free-text Skill title', () => {
  expect(matchMarketPresetPortrait({ title: 'Muse 竖屏分镜导演技能' }).id).toBe('vertical-storyboard-director')
  expect(matchMarketPresetPortrait({ title: '短剧分镜审阅技能' }).id).toBe('storyboard-reviewer')
  expect(matchMarketPresetPortrait({ title: '通用技能', description: '提供短剧背景音乐和选曲协助' }).id).toBe('music-supervisor')
  expect(matchMarketPresetPortrait({ purpose: '视频剪辑', title: '文件助手', category: '文档编辑' }).id).toBe('video-editor')
  expect(matchMarketPresetPortrait({ category: 'VIDEO EDITING' }).id).toBe('video-editor')
  expect(matchMarketPresetPortrait({ title: '3D 动漫漫剧资产' }).id).toBe('3d-asset-artist')
  expect(matchMarketPresetPortrait({ title: 'Python 编程' }).id).toBe('coding-assistant')
  expect(matchMarketPresetPortrait({ description: 'Prepare voice references' }).id).toBe('voice-casting')
})

it('matches whole English words and uses the document specialist for an unknown Skill', () => {
  expect(matchMarketPresetPortrait({ description: 'Prepare a color-grading palette' }).id).toBe('colorist')
  expect(matchMarketPresetPortrait({ title: 'SRTicle' }).id).toBe('document-specialist')
  expect(matchMarketPresetPortrait({ title: '我的技能' }).id).toBe('document-specialist')
  expect(matchMarketPresetPortrait({ tags: ['Video Editor'] }).id).toBe('video-editor')
})

it('binds the same Skill character used by preview and respects the immutable published binding', () => {
  const skill = marketFixture[1]!.manifest
  const unbound = { ...skill, title: 'Muse 竖屏分镜导演技能', name: 'new-storyboard-skill', skills: [], description: '', category: '' }
  const portrait = matchUnboundMarketPresetPortrait(unbound)
  expect(portrait).toBe('vertical-storyboard-director')
  expect(resolveMarketSkillArtwork(unbound)).toBe(portrait)
  expect(matchUnboundMarketPresetPortrait({ ...unbound, presetPortrait: 'video-editor' })).toBeUndefined()
  expect(resolveMarketSkillArtwork({ ...unbound, presetPortrait: 'video-editor' })).toBe('video-editor')
  expect(matchUnboundMarketPresetPortrait({ ...unbound, kind: 'bot', plugins: [] })).toBeUndefined()
})
