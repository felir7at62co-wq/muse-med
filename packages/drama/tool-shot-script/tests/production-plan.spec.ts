/** Per-shot appearance choices and advisory packaging preserve authored speech. */
import { expect, it } from 'vitest'
import { buildProductionPlan, productionHash } from '../src/production-plan.ts'
import type { ProductionAsset, ProductionPlan, ProductionRequirement } from '../src/production-types.ts'
import { speakingShot } from './harness.ts'

const assets: ProductionAsset[] = [
  { asset_id: 101, name: '全剧｜角色｜苏晚（青年；红婚服）', kind: 'character', url: 'https://cdn.example.test/red.png', material_id: 'image-red', usable: true },
  { asset_id: 102, name: '全剧｜角色｜苏晚（青年；白中衣）', kind: 'character', url: 'https://cdn.example.test/white.png', material_id: 'image-white', usable: true },
  { asset_id: 201, name: '后厨', kind: 'scene', url: 'https://cdn.example.test/kitchen.png', material_id: 'image-kitchen', usable: true },
  { asset_id: 301, name: '奶瓶', kind: 'prop', url: 'https://cdn.example.test/bottle.png', material_id: 'image-bottle', usable: true },
]
const source = [1, 2, 3, 4].map(n => speakingShot(n, '苏晚：我会好~好~享~用~的~', [
  '出镜人物：苏晚', '核心场景：后厨', '关键道具：奶瓶', '发声类型：dialogue', '时长：6秒',
])).join('\n\n')
const base: Omit<ProductionPlan, 'version' | 'operation' | 'matches' | 'packages' | 'warnings' | 'fingerprint'> = {
  project_dir: '/project', script_id: 4908, script_name: 'Appearance test', episode: 1, episode_id: 102505,
  source_path: '/project/shots.txt', source_sha256: productionHash(source), source,
  assets, choices: [], requirements: [], targets: [], model: { modelId: 'model', platformId: 'channel', standardId: 1,
    modelGenerationTypeId: 2, videoStandardId: 3, genType: 3, ratio: '16:9', resolution: '480p', maxDurationSeconds: 30, revision: 1 },
}
const requirements: ProductionRequirement[] = [1, 2, 3, 4].map(shot => ({ shot, kind: 'character', name: '苏晚', state: shot === 1 ? '红婚服' : '白中衣' }))

it('selects appearances per shot while keeping one character and complete dialogue', () => {
  const plan = buildProductionPlan({ ...base, requirements }, 8, 2)
  expect(plan.matches.filter(row => row.kind === 'character').map(row => row.selected_asset_id)).toEqual([101, 102, 102, 102])
  expect(plan.packages).toHaveLength(1)
  expect(plan.packages[0]?.images.map(row => row.asset_id)).toEqual([101, 201, 301, 102])
  expect(plan.packages[0]?.prompt.match(/台词：苏晚：我会好~好~享~用~的~/gu)).toHaveLength(4)
  expect(plan.matches.every(row => row.review_required)).toBe(true)
})

it('keeps a disputed explicit choice and reports the exact shot rather than blocking publication', () => {
  const plan = buildProductionPlan({ ...base, requirements,
    choices: [{ shot: 2, kind: 'character', name: '苏晚', asset_id: 101 }] }, 8, 2)
  expect(plan.matches.find(row => row.kind === 'character' && row.shot === 2)).toMatchObject({ selected_asset_id: 101, selection_basis: 'explicit' })
  expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'selected_asset_needs_review', shot: 2, name: '苏晚' }))
  expect(plan.packages).toHaveLength(1)
})

it('uses the current model ceiling and keeps overlong complete shots as warnings', () => {
  const short = buildProductionPlan({ ...base, requirements, model: { ...base.model, maxDurationSeconds: 15, revision: 2 } }, 8, 2)
  expect(short.packages.map(row => row.duration)).toEqual([13, 13])
  expect(short.packages.flatMap(row => row.shots)).toEqual([1, 2, 3, 4])
  const longSource = source.replaceAll('时长：6秒', '时长：20秒')
  const long = buildProductionPlan({ ...base, source: longSource, model: { ...base.model, maxDurationSeconds: 15 } }, 8, 2)
  expect(long.packages.map(row => row.duration)).toEqual([21, 21, 21, 21])
  expect(long.warnings.some(row => row.code === 'shot_exceeds_package_budget')).toBe(true)
})

it('retains missing voice requirements and separates ambiguous candidates from unavailable assets', () => {
  const plan = buildProductionPlan(base, 1, 2)
  expect(plan.matches.filter(row => row.kind === 'voice')).toHaveLength(4)
  expect(plan.matches.find(row => row.kind === 'character')).toMatchObject({ candidate_count: 2,
    candidates_truncated: true, selected_asset_id: null, selection_basis: 'unresolved' })
  const unavailable = buildProductionPlan({ ...base, requirements, assets: assets.map(row => ({ ...row, usable: false })) }, 8, 2)
  expect(unavailable.packages.every(row => row.images.length === 0)).toBe(true)
  expect(unavailable.packages.map(row => row.prompt).join('')).toContain('我会好~好~享~用~的~')
})

it('does not borrow another model duration or invent assets for an empty or unresolved script', () => {
  const unknown = buildProductionPlan({ ...base, model: { ...base.model, maxDurationSeconds: null } }, 8, 2)
  expect(unknown.packages.map(item => item.shots)).toEqual([[1], [2], [3], [4]])
  expect(unknown.matches.length).toBeGreaterThan(0)
  expect(unknown.warnings.some(row => row.code === 'model_duration_unknown')).toBe(true)
  const empty = buildProductionPlan({ ...base, source: '尚未写分镜' }, 8, 2)
  expect(empty.packages).toEqual([])
  expect(empty.warnings.some(row => row.code === 'no_shots')).toBe(true)
})

it('rejects choices for absent shots and identities instead of redirecting them to another character', () => {
  expect(() => buildProductionPlan({ ...base, requirements: [{ shot: 9, kind: 'character', name: '苏晚' }] }, 8, 2)).toThrow('镜头9')
  expect(() => buildProductionPlan({ ...base, choices: [{ shot: 1, kind: 'character', name: '另一人', asset_id: 101 }] }, 8, 2)).toThrow('没有对应')
  expect(() => buildProductionPlan({ ...base, choices: [{ shot: 1, kind: 'character', name: '苏晚', asset_id: 999 }] }, 8, 2)).toThrow('当前项目')
})

it('replaces an old costume marker with the selected version while preserving dialogue and the original file text', () => {
  const authored = source.replaceAll('相机固定，苏晚', '相机固定，@[全剧｜角色｜苏晚（青年；红婚服）](old-red)')
  const plan = buildProductionPlan({ ...base, source: authored, requirements }, 8, 2)
  expect(plan.packages[0]?.prompt).toContain('@[全剧｜角色｜苏晚（青年；白中衣）](asset_102)')
  expect(plan.packages[0]?.prompt).not.toContain('(old-red)')
  expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'reference_binding_changed' }))
  expect(plan.source).toBe(authored)
})

it('recognizes the story identity before a pipe-separated costume suffix', () => {
  const plan = buildProductionPlan({ ...base, requirements, assets: assets.map(asset => asset.kind === 'character'
    ? { ...asset, name: asset.asset_id === 101 ? '苏晚｜红婚服' : '苏晚｜白中衣' } : asset) }, 8, 2)
  expect(plan.matches.filter(row => row.kind === 'character').map(row => row.selected_asset_id)).toEqual([101, 102, 102, 102])
})
