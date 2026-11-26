/** Per-shot appearance choices and advisory packaging preserve authored speech. */
import { expect, it } from 'vitest'
import { buildProductionPlan, outdatedOffscreenPropPackages, productionHash } from '../src/production-plan.ts'
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

it('shares the configured speech estimate with the shot compiler', () => {
  const source = speakingShot(1, `苏晚：${'字'.repeat(23)}`, ['出镜人物：苏晚', '核心场景：后厨'])
  const input = { ...base, source, source_sha256: productionHash(source) }
  expect(buildProductionPlan(input, 8, 2).packages[0]?.duration).toBe(4)
  expect(buildProductionPlan(input, 8, 2, 5).packages[0]?.duration).toBe(6)
})

it('selects appearances per shot while keeping one character and complete dialogue', () => {
  const plan = buildProductionPlan({ ...base, requirements }, 8, 2)
  expect(plan.matches.filter(row => row.kind === 'character').map(row => row.selected_asset_id)).toEqual([101, 102, 102, 102])
  expect(plan.packages).toHaveLength(1)
  expect(plan.packages[0]?.images.map(row => row.asset_id)).toEqual([101, 201, 301, 102])
  expect(plan.packages[0]?.prompt.match(/台词：苏晚：我会好~好~享~用~的~/gu)).toHaveLength(4)
  expect(plan.matches.every(row => row.review_required)).toBe(true)
  expect(plan.packages[0]?.prompt).not.toContain('身体状态')
  expect(plan.source).toBe(source)
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

it('refuses duplicate shot numbers before mixing their scene and prop bindings', () => {
  const first = '【镜头1】\n核心场景：后厨\n关键道具：奶瓶\n画面：奶瓶落地\n发声类型：action\n时长：3秒'
  const second = '【镜头2】\n核心场景：客厅\n关键道具：杯子\n画面：杯子放回桌面\n发声类型：action\n时长：3秒'
  const inventory = [...assets,
    { ...assets[2]!, asset_id: 202, name: '客厅' },
    { ...assets[3]!, asset_id: 302, name: '杯子' }]
  const duplicated = `${first}\n\n${second.replace('镜头2', '镜头1')}`
  expect(() => buildProductionPlan({ ...base, source: duplicated, assets: inventory }, 8, 2))
    .toThrow('重复镜号：1')

  const correct = buildProductionPlan({ ...base, source: `${first}\n\n${second}`, assets: inventory }, 8, 2)
  expect(correct.packages.map(pack => pack.images.map(image => image.asset_id))).toEqual([[201, 301], [202, 302]])

  const repeatedAction = `${first}\n\n${first.replace('镜头1', '镜头2')}`
  const repeated = buildProductionPlan({ ...base, source: repeatedAction, assets: inventory }, 8, 2)
  expect(repeated.packages.flatMap(pack => pack.shots)).toEqual([1, 2])
})

it('preserves asset labels when annotations include list punctuation', () => {
  const annotated = '【镜头1】\n核心场景：@[后厨（室内、白天）](old-scene)\n'
    + '关键道具：@[奶瓶（有水、半满）](old-bottle)、杯子（小号，蓝色）；纸袋\n'
    + '画面：奶瓶落地\n发声类型：action\n时长：3秒'
  const plan = buildProductionPlan({ ...base, source: annotated, assets: [...assets,
    { ...assets[3]!, asset_id: 302, name: '杯子' }] }, 8, 2)
  expect(plan.matches.filter(row => row.kind === 'prop').map(row => [row.name, row.selected_asset_id]))
    .toEqual([['奶瓶', 301], ['杯子', 302], ['纸袋', null]])
  expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'asset_missing', name: '纸袋' }))
  expect(plan.packages[0]?.images.map(row => row.asset_id)).toEqual([201, 301, 302])
  expect(plan.packages[0]?.prompt).toContain('@[奶瓶](asset_301)')
  expect(plan.packages[0]?.prompt).not.toContain('old-bottle')
  expect(plan.source).toBe(annotated)
})

it('uses sequential performance budgets in automatic production packages without sending budget metadata', () => {
  const timed = source.replaceAll('时长：6秒', [
    '动作预算：6秒', '发声预算：3秒', '反应预算：2秒', '表演顺序：先动作后台词',
  ].join('\n'))
  const plan = buildProductionPlan({ ...base, source: timed, requirements }, 8, 2)
  expect(plan.packages.map(pack => pack.duration)).toEqual([23, 23])
  expect(plan.packages.flatMap(pack => pack.shots)).toEqual([1, 2, 3, 4])
  expect(plan.packages.every(pack => !/(?:动作预算|发声预算|反应预算|表演顺序)：/.test(pack.prompt))).toBe(true)
  expect(plan.source).toBe(timed)
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

it('retains deliberate omissions and surfaces unrelated explicit identities and unavailable media', () => {
  const plan = buildProductionPlan({ ...base, assets: [...assets,
    { ...assets[0]!, asset_id: 901, name: '另一个人' },
    { ...assets[0]!, asset_id: 902, usable: true, url: null, material_id: null }],
  requirements: [{ shot: 1, kind: 'character', name: '苏晚', character_id: 'correct', conditions: ['红婚服'] }],
  choices: [{ shot: 1, kind: 'character', name: '苏晚', asset_id: 901 },
    { shot: 2, kind: 'character', name: '苏晚', asset_id: null },
    { shot: 3, kind: 'character', name: '苏晚', asset_id: 902 }],
  }, 1, 2)
  expect(plan.matches.find(row => row.shot === 1 && row.kind === 'character')?.candidates.at(-1)?.asset_id).toBe(901)
  expect(plan.matches).toContainEqual(expect.objectContaining({ shot: 2, kind: 'character', selection_basis: 'omitted' }))
  expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'selected_asset_needs_review', shot: 1 }))
  expect(plan.packages.flatMap(row => row.images).some(row => row.asset_id === 902)).toBe(false)
})

it('omits a clearly off-screen prop only from the affected shot, including an earlier explicit choice', () => {
  const authored = [
    speakingShot(1, '苏晚：我看见奶瓶了', ['核心场景：后厨', '关键道具：奶瓶', '画面：奶瓶在桌上']),
    speakingShot(2, '奶瓶：我还在这儿', ['核心场景：后厨', '关键道具：@[奶瓶](old-bottle)',
      '画面：苏晚低头听，器物不在画面内、不开口。', '发声类型：心声']),
  ].join('\n\n')
  const plan = buildProductionPlan({ ...base, source: authored, source_sha256: productionHash(authored),
    assets: [...assets.slice(0, 3), { ...assets[3]!, aliases: ['奶壶'] }],
    requirements: [{ shot: 2, kind: 'prop', name: '奶瓶' }, { shot: 2, kind: 'prop', name: '奶壶' }],
    choices: [{ shot: 2, kind: 'prop', name: '奶瓶', asset_id: 301 },
      { shot: 2, kind: 'prop', name: '奶壶', asset_id: 301 }] }, 8, 2)
  expect(plan.packages).toHaveLength(1)
  const [before, after] = plan.packages[0]!.prompt.split('【镜头2】')
  expect(before).toContain('@[奶瓶](asset_301)')
  expect(after).not.toContain('(asset_301)')
  expect(after).not.toContain('(old-bottle)')
  expect(after).toContain('画外道具（本镜不入画）：奶瓶')
  expect(after).toContain('台词：奶瓶：我还在这儿')
  expect(after).toContain('@[后厨](asset_201)')
  expect(plan.packages[0]?.images.filter(row => row.asset_id === 301)).toHaveLength(1)
  expect(plan.matches).toContainEqual(expect.objectContaining({ shot: 2, kind: 'prop', name: '奶瓶',
    selected_asset_id: null, selection_basis: 'omitted' }))
  expect(plan.matches).toContainEqual(expect.objectContaining({ shot: 2, kind: 'prop', name: '奶壶',
    selected_asset_id: null, selection_basis: 'omitted' }))
  expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'offscreen_prop_omitted', shot: 2, name: '奶瓶' }))
  expect(plan.source).toBe(authored)
})

it('preserves other props, visible mind-voice props, and props entering later in the shot', () => {
  const cup: ProductionAsset = { ...assets[3]!, asset_id: 302, name: '杯子', material_id: 'image-cup' }
  const authored = [
    speakingShot(1, '苏晚：奶瓶不出镜', ['核心场景：后厨', '关键道具：奶瓶、杯子', '画面：杯子在桌上；奶瓶不出镜。']),
    speakingShot(2, '奶瓶：器物不在画面内', ['核心场景：后厨', '关键道具：奶瓶', '发声类型：心声', '画面：奶瓶留在桌上。']),
    speakingShot(3, '苏晚：现在看', ['核心场景：后厨', '关键道具：奶瓶', '画面：器物不在画面内，随后手把奶瓶拿入画。']),
    speakingShot(4, '苏晚：快看', ['核心场景：后厨', '关键道具：奶瓶、杯子', '画面：器物不出镜。']),
    speakingShot(5, '苏晚：看这里', ['核心场景：后厨', '关键道具：奶瓶', '画面：。']),
  ].join('\n\n')
  const plan = buildProductionPlan({ ...base, source: authored, source_sha256: productionHash(authored),
    assets: [...assets, cup] }, 8, 2)
  const matches = plan.matches.filter(row => row.kind === 'prop')
  expect(matches.map(row => [row.shot, row.name, row.selected_asset_id])).toEqual([
    [1, '奶瓶', null], [1, '杯子', 302], [2, '奶瓶', 301], [3, '奶瓶', 301], [4, '奶瓶', 301], [4, '杯子', 302], [5, '奶瓶', 301],
  ])
  const [first] = plan.packages[0]!.prompt.split('【镜头2】')
  expect(first).toContain('道具（「奶瓶」不入画）：奶瓶、杯子')
  expect(first).toContain('@[杯子](asset_302)')
  expect(first).not.toContain('(asset_301)')
  expect(first).toContain('台词：苏晚：奶瓶不出镜')
})

it('does not reject a legacy package when only another shot uses the shared picture', () => {
  const legacy = buildProductionPlan({ ...base, requirements }, 8, 2)
  const marker = '@[奶瓶](asset_301)'
  const [first, ...rest] = legacy.packages[0]!.prompt.split(/(?=【镜头[2-4]】)/u)
  const authored = '【镜头1】\n核心场景：后厨\n关键道具：奶瓶\n画面：器物不在画面内。'
  const withoutImage = first!.replaceAll(marker, '奶瓶') + `\n台词：苏晚：${marker}\n`
  const previous = { ...legacy, source: authored,
    packages: [{ ...legacy.packages[0]!, prompt: withoutImage + rest.join('') }] }
  expect(previous.packages[0]?.images.find(item => item.asset_id === 301)).toBeDefined()
  expect(outdatedOffscreenPropPackages(previous, { actionShotSeconds: 2 }).size).toBe(0)
})

it('compares explicit character identities, scene conditions and known voice periods independently', () => {
  const voice: ProductionAsset = { asset_id: 401, name: '声音', kind: 'voice', url: 'https://cdn.example.test/voice.wav',
    material_id: null, usable: true, character_id: 'su-wan', voice_period_id: 'adult', duration_seconds: 2 }
  const plan = buildProductionPlan({ ...base,
    assets: [{ ...assets[0]!, aliases: ['阿晚'], character_id: 'other', state_or_costume: '红婚服' },
      { ...assets[1]!, character_id: 'su-wan' }, { ...assets[2]!, scene_conditions: ['晨光'] }, voice],
    requirements: [{ shot: 1, kind: 'character', name: '阿晚', character_id: 'su-wan' },
      { shot: 1, kind: 'scene', name: '后厨', conditions: ['晨光'] },
      { shot: 1, kind: 'voice', name: '苏晚', character_id: 'su-wan', voice_period_id: 'adult' },
      { shot: 2, kind: 'voice', name: '苏晚', character_id: 'su-wan' }],
  }, 8, 2)
  expect(plan.matches.find(row => row.name === '阿晚')?.candidates.find(row => row.asset_id === 101)?.reasons).toContain('character_identity_mismatch')
  expect(plan.packages[0]?.voices).toEqual([voice])
  expect(plan.matches.find(row => row.shot === 2 && row.kind === 'voice')?.candidates[0]?.reasons).toContain('voice_identity_or_period_unverified')
})

it('reports changes to source scene and appearance while resolving authored aliases outside speech', () => {
  const authored = source.replaceAll('核心场景：后厨', '核心场景：@[后厨](old)')
    .replaceAll('相机固定，苏晚', '相机固定，@[阿晚](old)和@[未登记](unknown)')
    .replaceAll('出镜人物：苏晚', '出镜人物：苏晚\n苏晚：\n身体状态：青年；红婚服；')
  const plan = buildProductionPlan({ ...base, source: authored,
    assets: [{ ...assets[0]!, aliases: ['阿晚'] }, ...assets.slice(1)],
    requirements: [{ shot: 1, kind: 'scene', name: '饭堂' },
      { shot: 1, kind: 'character', name: '苏晚', state: '白中衣' }],
  }, 8, 2)
  expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'source_scene_requirement_changed' }))
  expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'source_state_requirement_changed' }))
  expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'source_reference_unresolved' }))
  expect(plan.packages.map(row => row.prompt).join('')).not.toContain('(unknown)')
  expect(plan.source).toBe(authored)
})

it('does not add absent character, prop or speech requirements to a silent scene', () => {
  const plan = buildProductionPlan({ ...base, source: '【镜头1】\n核心场景：后厨\n发声类型：action\n画面：空房间\n时长：3秒' }, 8, 2)
  expect(plan.matches.map(row => row.kind)).toEqual(['scene'])
})

it('keeps an unmeasured voice unresolved and resolves a selected visual alias without touching spoken markers', () => {
  const voice: ProductionAsset = { asset_id: 401, name: '声音', kind: 'voice', character_id: 'su-wan', voice_period_id: 'adult',
    usable: true, url: 'https://cdn.example.test/v.wav', material_id: null }
  const authored = source.replaceAll('相机固定，苏晚', '相机固定，@[阿晚](old)')
  const plan = buildProductionPlan({ ...base, source: authored, assets: [{ ...assets[0]!, aliases: ['阿晚'] }, ...assets.slice(1), voice],
    requirements: [...requirements.map(item => ({ ...item, state: '红婚服' })),
      { shot: 1, kind: 'voice', name: '苏晚', character_id: 'su-wan', voice_period_id: 'adult' }],
  }, 8, 2)
  expect(plan.matches.find(row => row.kind === 'voice')?.candidates[0]?.reasons).toContain('audio_duration_unverified')
  expect(plan.packages[0]?.prompt).toContain('@[全剧｜角色｜苏晚（青年；红婚服）](asset_101)')
  const empty = buildProductionPlan({ ...base, assets: [], source: '【镜头1】\n画面：空白\n发声类型：action\n时长：3秒' }, 8, 2)
  expect(empty.matches).toEqual([])
})
