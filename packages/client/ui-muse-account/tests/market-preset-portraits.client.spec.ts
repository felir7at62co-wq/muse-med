import { expect, it } from 'vitest'
import { findMarketPresetPortrait, marketPresetPortraits, matchMarketPresetPortrait, matchUnboundMarketPresetPortrait } from '../src/client/market-preset-portraits.ts'
import { marketFixture } from './market-fixture.client.ts'

it('makes all 50 presets selectable and matches each name in both market languages', () => {
  expect(marketPresetPortraits).toHaveLength(50)
  expect(new Set(marketPresetPortraits.map(row => row.id)).size).toBe(50)
  for (const row of marketPresetPortraits) {
    expect(findMarketPresetPortrait(row.id)).toBe(row)
    expect(matchMarketPresetPortrait({ title: row.name })).toBe(row)
    expect(matchMarketPresetPortrait({ title: row.nameEn })).toBe(row)
  }
  expect(findMarketPresetPortrait('storyboard-director')).toBeUndefined()
})

it('uses purpose and distinguishes related roles in a free-text title', () => {
  expect(matchMarketPresetPortrait({ title: 'Muse 竖屏分镜导演助手' }).id).toBe('vertical-storyboard-director')
  expect(matchMarketPresetPortrait({ title: '短剧分镜审阅助手' }).id).toBe('storyboard-reviewer')
  expect(matchMarketPresetPortrait({ title: '通用助手', description: '提供短剧背景音乐和选曲协助' }).id).toBe('music-supervisor')
  expect(matchMarketPresetPortrait({ purpose: '视频剪辑', title: '文件助手', category: '文档编辑' }).id).toBe('video-editor')
  expect(matchMarketPresetPortrait({ category: 'VIDEO EDITING' }).id).toBe('video-editor')
})

it('matches English words without accepting a substring and falls back for unclassified Bots', () => {
  expect(matchMarketPresetPortrait({ description: 'Prepare a color-grading palette' }).id).toBe('colorist')
  expect(matchMarketPresetPortrait({ title: 'SRTicle' }).id).toBe('screenplay-editor')
  expect(matchMarketPresetPortrait({ title: '我的助手' }).id).toBe('screenplay-editor')
})

it('uses tags for matching and keeps the existing portrait binding on imported packages', () => {
  expect(matchMarketPresetPortrait({ tags: ['Video Editor'] }).id).toBe('video-editor')
  const bot = marketFixture[0]!.manifest
  expect(matchUnboundMarketPresetPortrait({ ...bot, title: 'Muse 竖屏分镜导演助手', description: '', category: '' })).toBe('vertical-storyboard-director')
  expect(matchUnboundMarketPresetPortrait({ ...bot, presetPortrait: 'video-editor' })).toBeUndefined()
  expect(matchUnboundMarketPresetPortrait({ ...bot, portrait: 'storyboard-director' })).toBeUndefined()
  expect(matchUnboundMarketPresetPortrait(marketFixture[1]!.manifest)).toBeUndefined()
})
