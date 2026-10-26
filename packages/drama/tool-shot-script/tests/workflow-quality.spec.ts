/** Authored references retain identity checks and speaking actions retain their time. */
import { expect, it } from 'vitest'
import { registeredShot } from './fixtures/registered-shot.ts'
import { bindShot, parseAssetManifest } from '../src/assets.ts'
import { materialReferenceIssues } from '../src/episode.ts'
import { productionName } from '../src/production-plan.ts'
import { parseShotScript } from '../src/script.ts'
import { assetRow, cleanup, speakingShot, tempDir } from './harness.ts'

it.each([
  ['苏晚 @[苏晚](asset_70001)', '后厨 @[后厨](asset_70002)'],
  ['@[苏晚](asset_70001)', '@[后厨](asset_70002)'],
])('binds annotated field labels without treating markup as a name: %s', (person, scene) => {
  const parsed = parseShotScript(speakingShot(1, '苏晚：好。', [
    `出镜人物：${person}`, `核心场景：${scene}`,
  ]), { actionShotSeconds: 2 })
  const shot = parsed.shots[0]!
  const rows = parseAssetManifest({ items: [assetRow('苏晚', '角色'), assetRow('后厨', '场景')] }, 'assets.json').assets
  const bound = bindShot(shot, rows, 1)
  expect(bound.issues).toEqual([])
  expect(bound.characters).toEqual(['苏晚'])
  expect(bound.scene).toBe('后厨')
  expect(materialReferenceIssues([{ shot, ...bound, start: 0, end: shot.durationSeconds }], rows)).toEqual([])
})

it('rejects a mismatching parent key after resolving an annotated label', () => {
  const shot = parseShotScript(speakingShot(1, '苏晚：好。', [
    '出镜人物：苏晚 @[苏晚](asset_70002)', '核心场景：后厨',
  ]), { actionShotSeconds: 2 }).shots[0]!
  const rows = parseAssetManifest({ items: [assetRow('苏晚', '角色'), assetRow('后厨', '场景')] }, 'assets.json').assets
  const bound = bindShot(shot, rows, 1)
  expect(materialReferenceIssues([{ shot, ...bound, start: 0, end: shot.durationSeconds }], rows))
    .toEqual([expect.objectContaining({ code: 'material_reference_mismatch', severity: 'failure' })])
})

it('uses one identity for repeated display names in Muse production requirements', () => {
  expect(productionName('苏晚 @[苏晚](asset_70001)')).toBe('苏晚')
  expect(productionName('@[苏晚](asset_70001)')).toBe('苏晚')
  expect(productionName('另一个人 @[苏晚](asset_70001)')).toBe('另一个人')
})

it('recognizes a prefixed style declaration without rewriting the authored body', () => {
  const text = speakingShot(1).replace('真人短剧写实风格', '风格：真人短剧写实风格。')
  const parsed = parseShotScript(text, { actionShotSeconds: 2 })
  expect(parsed.issues.some(issue => issue.code === 'missing_style_line')).toBe(false)
  expect(parsed.shots[0]!.visual).toContain('运镜：相机固定')
})

it('budgets a speaking action for at least its declared complexity', () => {
  const parsed = parseShotScript(speakingShot(1, '苏晚：好烫！', ['动作复杂度：复杂']), { actionShotSeconds: 2 })
  expect(parsed.shots[0]).toMatchObject({ text: '好烫！', durationSeconds: 4 })
  expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'action_complexity_on_speaking_shot' }))
})

it('uses the configured speech rate without changing the spoken text', () => {
  const text = '饭是劈了十三根柴的红薯是奖励你自己把箱子拖回来'
  const parsed = parseShotScript(speakingShot(1, `苏晚：${text}`), { actionShotSeconds: 2, speechCharsPerSecond: 5 })
  expect(parsed.shots[0]).toMatchObject({ text, durationSeconds: Math.ceil(text.length / 5) })
})

it('retains explicit timing and refuses unknown complexity on speaking actions', () => {
  const parsed = parseShotScript(speakingShot(1, '苏晚：好烫！', ['动作复杂度：随意', '时长：6秒']), { actionShotSeconds: 2 })
  expect(parsed.shots[0]).toMatchObject({ durationSeconds: 6, durationSource: 'declared' })
  expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'unknown_action_complexity', severity: 'failure' }))
})

it('rejects a non-positive configured speech rate through the Loader', async () => {
  const root = await tempDir()
  try {
    await expect(registeredShot(root, { speechCharsPerSecond: 0 })).rejects.toThrow()
  } finally {
    await cleanup(root)
  }
})
