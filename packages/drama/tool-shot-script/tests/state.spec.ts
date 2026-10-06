/**
 * The character-state gate, driven through the registered `drama_shot` tool:
 * what a shot declares as an on-screen character's body state, what the asset
 * manifest registers for that character's version, and what happens when the two
 * disagree or when nothing is registered at all.
 *
 * The accident these cover: 《山海自有相逢处》第25集 scripts 孕八周 for 沈知意 and
 * bound 沈知意（孕期职场装） (asset 81685 / material 79293), whose board is a
 * late-pregnancy body, so 分镜3 and 分镜4 rendered a full-term belly.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONFLICT,
  coversEpisode,
  declaredBodyStates,
  describeEpisodes,
  hasBodyDimension,
  readEpisodes,
  readStateFacts,
} from '../src/state.ts'
import type { DramaShotReport } from '../src/types.ts'
import { assetRow, bodyState, call, cleanup, manifestDocument, shot, tempDir } from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  for (const dir of temporary.splice(0)) await cleanup(dir)
})

/** One episode-25 project: its shot script, its asset manifest, and its episode text. */
async function project(options: { script: string; assets: Record<string, unknown>[] }):
Promise<{ root: string; scriptPath: string; manifestPath: string }> {
  const root = await tempDir()
  temporary.push(root)
  await mkdir(join(root, 'episodes'), { recursive: true })
  const scriptPath = join(root, 'source-25.txt')
  const manifestPath = join(root, 'assets_manifest.json')
  await writeFile(scriptPath, options.script, 'utf8')
  await writeFile(manifestPath, JSON.stringify(manifestDocument(...options.assets)), 'utf8')
  await writeFile(join(root, 'episodes', '25.txt'), '第二十五集正文', 'utf8')
  return { root, scriptPath, manifestPath }
}

/** One shot that puts 沈知意 on screen in the late-pregnancy costume version. */
function shenShot(state: string): string {
  return shot(1, [
    '景别：近景',
    '运镜：相机固定，沈知意坐在诊室椅子上看向画外医生方向',
    '视角：相机视角平视',
    '主体状态追踪：',
    '【沈知意】-位置：【场景图视角诊室中央偏右木椅靠近诊桌处】；',
    bodyState(state),
    '动作状态：【双手放在膝盖上】；',
    '四层朝向链：【身体朝向画外医生方向，面部朝向那里，目光固定，眼神平静】；',
    '手部状态：【双手放在膝盖上】，【无】；',
    '情绪状态：【嘴角平，眼神平静】；',
    '台词：沈知意：我怀孕八周了。',
    '核心场景：医院诊室',
    '出镜人物：沈知意（孕期职场装）',
  ])
}

/** The registered late-pregnancy version of 沈知意, at the ids the accident used. */
function latePregnancyAsset(state = '孕晚期、孕期职场装'): Record<string, unknown> {
  return assetRow('沈知意（孕期职场装）', '角色', {
    state_or_costume: state,
    episodes: [25],
    jubian_asset_id: '81685',
    jubian_material_id: '79293',
  })
}

/** The scene both fixtures bind. */
function clinic(): Record<string, unknown> {
  return assetRow('医院诊室', '场景', { episodes: [25] })
}

/** Run one `validate` call over one project and return its report. */
async function validate(files: { scriptPath: string; manifestPath: string }, episode?: number):
Promise<DramaShotReport> {
  return await call({ method: 'validate', script: files.scriptPath, assets: files.manifestPath,
    ...(episode === undefined ? {} : { episode }) })
}

/** Every failure of one report as `code: message` lines. */
function failures(report: DramaShotReport): string {
  return report.failures.map(failure => `${failure.code}: ${failure.message}`).join('\n')
}

describe('character state at binding time', () => {
  it('正例：剧本要孕八周、资产登记孕早期 ⇒ 通过', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [latePregnancyAsset('孕早期（孕八周）、孕期职场装'), clinic()] })
    const report = await validate(files, 25)
    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.shots[0]?.bindings.map(binding => binding.name))
      .toEqual(['沈知意（孕期职场装）', '医院诊室'])
  })

  it('反例1：剧本要孕八周、资产登记孕晚期 ⇒ 报错并点名期望值/实际值/资产 id', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）；青年；孕期职场装'),
      assets: [latePregnancyAsset('孕晚期、青年、孕期职场装'), clinic()] })
    const report = await validate(files, 25)
    expect(report.ok).toBe(false)
    expect(report.failures.map(failure => failure.code)).toContain('asset_state_mismatch')
    const message = failures(report)
    expect(message).toContain('孕早期')
    expect(message).toContain('孕晚期')
    expect(message).toContain('jubian_asset_id 81685')
    expect(message).toContain('material 79293')
    expect(message).toContain('镜头声明：孕早期（孕八周）；青年；孕期职场装')
    expect(message).toContain('孕期阶段：镜头 孕期阶段=孕早期 / 资产 孕晚期')
    expect(message).toContain('年龄段=青年')
    expect(message).toContain('服装/发型 孕期职场装')
  })

  it('边界：只声明体型不声明服装，且调用没给集号时的补料需求', async () => {
    const files = await project({ script: shenShot('青年'),
      assets: [assetRow('沈知意（孕期职场装）', '角色', { state_or_costume: '中年、职场装', episodes: [25] }),
        clinic()] })
    const report = await validate(files)
    expect(report.failures.map(failure => failure.code)).toContain('asset_state_missing')
    const message = failures(report)
    expect(message).toContain('服装=（镜头未写服装）')
    expect(message).toContain('阶段=按剧本写明')
    expect(message).toContain('用于=本次调用没给 episode，请在 compile 或 validate 时带上集号')
  })

  it('边界：登记的 state_or_costume 有文字但读不出阶段', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [assetRow('沈知意', '角色', { state_or_costume: '深色职业装', episodes: [25] }), clinic()] })
    const report = await validate(files, 25)
    expect(report.ok).toBe(false)
    expect(failures(report)).toContain('state_or_costume 是「深色职业装」')
  })

  it('反例2：清单无匹配资产 ⇒ 阻断并给出补料需求（含集号与阶段）', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [assetRow('沈知意（日常装）', '角色', { state_or_costume: '非孕期、青年、家常装', episodes: [25] }),
        clinic()] })
    const report = await validate(files, 25)
    expect(report.ok).toBe(false)
    expect(report.failures.map(failure => failure.code)).toEqual(['asset_state_missing'])
    const message = failures(report)
    expect(message).toContain('角色=沈知意')
    expect(message).toContain('阶段=孕早期')
    expect(message).toContain('服装=孕期职场装')
    expect(message).toContain('用于=第25集')
    expect(message).toContain('沈知意（日常装）')
    expect(message).toContain('assets_manifest.json')
    expect(message).toContain('drama_assets reconcile')
  })

  it('边界：episodes 全剧标记覆盖任何一集', async () => {
    const one = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [latePregnancyAsset('孕早期（孕八周）、孕期职场装'), clinic()] })
    const all = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [{ ...latePregnancyAsset('孕早期（孕八周）、孕期职场装'), episodes: ['all'] },
        { ...clinic(), episodes: ['all'] }] })
    expect((await validate(one, 25)).ok).toBe(true)
    expect((await validate(all, 25)).ok).toBe(true)
    expect((await validate(all, 47)).ok).toBe(true)
  })

  it('边界：未标阶段的资产在绑定时报错，而不是静默绑定', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [assetRow('沈知意', '角色', { episodes: [25], state_or_costume: '' }), clinic()] })
    const report = await validate(files, 25)
    expect(report.ok).toBe(false)
    expect(report.failures.map(failure => failure.code)).toContain('asset_state_unregistered')
    expect(failures(report)).toContain('state_or_costume 是「空」')
    expect(failures(report)).toContain('孕期阶段：镜头 孕期阶段=孕早期 / 资产 未登记')
  })

  it('边界：资产名只说孕期不说阶段，读不出阶段即判不一致', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [assetRow('沈知意（孕期职场装）', '角色', { state_or_costume: '', episodes: [25] }), clinic()] })
    const report = await validate(files, 25)
    expect(report.ok).toBe(false)
    expect(failures(report)).toContain('孕期待定')
  })

  it('边界：未登记 episodes 与登记了别的集数分别报错', async () => {
    const bare = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [{ ...latePregnancyAsset('孕早期（孕八周）、孕期职场装'), episodes: undefined },
        { ...clinic(), episodes: undefined }] })
    const other = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [{ ...latePregnancyAsset('孕早期（孕八周）、孕期职场装'), episodes: [3] }, clinic()] })
    const bareReport = await validate(bare, 25)
    const otherReport = await validate(other, 25)
    expect(bareReport.failures.map(failure => failure.code))
      .toEqual(['asset_episodes_unregistered', 'asset_episodes_unregistered'])
    expect(otherReport.failures.map(failure => failure.code)).toEqual(['asset_episode_mismatch'])
    expect(failures(otherReport)).toContain('第 3 集')
    expect(failures(otherReport)).toContain('第25集')
  })

  it('边界：镜头没写身体状态就不许绑定该角色', async () => {
    const withoutState = shot(1, [
      '景别：近景',
      '运镜：相机固定，沈知意坐在诊室椅子上看向画外医生方向',
      '视角：相机视角平视',
      '主体状态追踪：',
      '【沈知意】-位置：【场景图视角诊室中央偏右木椅靠近诊桌处】；',
      '台词：沈知意：我怀孕八周了。',
      '核心场景：医院诊室',
      '出镜人物：沈知意（孕期职场装）',
    ])
    const files = await project({ script: withoutState, assets: [latePregnancyAsset(), clinic()] })
    const report = await validate(files, 25)
    expect(report.ok).toBe(false)
    expect(report.failures.map(failure => failure.code)).toEqual(['shot_body_state_missing'])
    expect(failures(report)).toContain('身体状态')
  })

  it('边界：声明里只有服装读不出体型，以及资产多登记了镜头没写的维度', async () => {
    const costumeOnly = await project({ script: shenShot('职场装'),
      assets: [latePregnancyAsset('孕早期（孕八周）、孕期职场装'), clinic()] })
    const extraDimension = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [latePregnancyAsset('孕早期（孕八周）、青年、孕期职场装'), clinic()] })
    const costumeReport = await validate(costumeOnly, 25)
    const extraReport = await validate(extraDimension, 25)
    expect(costumeReport.failures.map(failure => failure.code)).toEqual(['shot_body_state_unusable'])
    expect(failures(costumeReport)).toContain('读不出阶段/体型')
    expect(extraReport.failures.map(failure => failure.code)).toEqual(['shot_body_state_unusable'])
    expect(failures(extraReport)).toContain('年龄段=青年')
  })

  it('边界：同一处写了两个阶段时不许绑定，并报出冲突', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）、孕晚期'),
      assets: [latePregnancyAsset('孕早期（孕八周）、孕期职场装'), clinic()] })
    const report = await validate(files, 25)
    expect(report.ok).toBe(false)
    expect(report.failures.map(failure => failure.code)).toEqual(['asset_state_mismatch'])
    expect(failures(report)).toContain('孕期阶段=同一处写了两个不同取值')
  })
  it('边界：清单里没有这个角色时，补料需求写明「已登记的该角色版本：无」', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'), assets: [clinic()] })
    const report = await validate(files, 25)
    expect(report.failures.map(failure => failure.code)).toEqual(['asset_state_missing'])
    expect(failures(report)).toContain('已登记的该角色版本：无')
  })

  it('边界：没有剧变 id 的资产在状态报错里只点名资产名', async () => {
    const files = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [assetRow('沈知意', '角色', { episodes: [25], state_or_costume: '', jubian_asset_id: '',
        jubian_material_id: '', url: '' }), clinic()] })
    const report = await validate(files, 25)
    expect(failures(report)).toContain('资产 沈知意没有登记镜头所需的孕期阶段')
    expect(report.failures.map(failure => failure.code)).toContain('incomplete_asset')
  })

  it('边界：比角色名更短的资产名要按包含关系才算是这个角色的版本', async () => {
    const shortName = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [assetRow('沈', '角色', { episodes: [25], state_or_costume: '孕早期、孕期职场装' }), clinic()] })
    const shortReport = await validate(shortName, 25)
    expect(shortReport.failures.map(failure => failure.code)).toContain('shot_body_state_missing')

    const partialName = await project({ script: shenShot('孕早期（孕八周）；孕期职场装'),
      assets: [assetRow('沈知', '角色', { episodes: [25], state_or_costume: '孕早期、孕期职场装' }), clinic()] })
    expect((await validate(partialName, 25)).ok).toBe(true)
  })

  it('边界：同一镜头给同一资产写了两条声明时，按最长的角色名判定', async () => {
    const bothKeys = shot(1, [
      '景别：近景',
      '运镜：相机固定，沈知意坐在诊室椅子上看向画外医生方向',
      '视角：相机视角平视',
      '主体状态追踪：',
      '【沈知意】-位置：【场景图视角诊室中央偏右木椅靠近诊桌处】；',
      '身体状态：【职场装】；',
      '【沈知意（孕期职场装）】-位置：【场景图视角诊室中央偏右木椅靠近诊桌处】；',
      '身体状态：【孕晚期；孕期职场装】；',
      '台词：沈知意：我怀孕八周了。',
      '核心场景：医院诊室',
      '出镜人物：沈知意（孕期职场装）',
    ])
    const longest = await project({ script: bothKeys,
      assets: [latePregnancyAsset('孕早期（孕八周）、孕期职场装'), clinic()] })
    const report = await validate(longest, 25)
    expect(report.failures.map(failure => failure.code)).toContain('asset_state_mismatch')
    expect(failures(report)).toContain('镜头声明：孕晚期；孕期职场装')
  })
})

describe('reading one body-state declaration', () => {
  it('reads a pregnancy stage from every spelling the format uses', () => {
    expect(readStateFacts('孕八周').pregnancy).toBe('孕早期')
    expect(readStateFacts('怀孕8周 职场装').pregnancy).toBe('孕早期')
    expect(readStateFacts('怀孕十三周').pregnancy).toBe('孕早期')
    expect(readStateFacts('怀孕十四周').pregnancy).toBe('孕中期')
    expect(readStateFacts('孕二十周').pregnancy).toBe('孕中期')
    expect(readStateFacts('孕二十八周').pregnancy).toBe('孕晚期')
    expect(readStateFacts('孕三十周').pregnancy).toBe('孕晚期')
    expect(readStateFacts('孕后期').pregnancy).toBe('孕晚期')
    expect(readStateFacts('孕中期').pregnancy).toBe('孕中期')
    expect(readStateFacts('孕初期').pregnancy).toBe('孕早期')
    expect(readStateFacts('未孕期身形').pregnancy).toBe('非孕期')
    expect(readStateFacts('正常体态').pregnancy).toBe('非孕期')
    expect(readStateFacts('孕期职场装').pregnancy).toBe('孕期待定')
    expect(readStateFacts('孕八周').age).toBe('')
  })

  it('reads an age band from a number or a word, and leaves other state text to the costume', () => {
    expect(readStateFacts('8岁').age).toBe('儿童')
    expect(readStateFacts('八岁').age).toBe('儿童')
    expect(readStateFacts('15岁').age).toBe('少年')
    expect(readStateFacts('30岁').age).toBe('青年')
    expect(readStateFacts('45岁').age).toBe('中年')
    expect(readStateFacts('七十八岁').age).toBe('老年')
    expect(readStateFacts('中老年').age).toBe('中年')
    expect(readStateFacts('老人').age).toBe('老年')
    expect(readStateFacts('少女').age).toBe('少年')
    expect(readStateFacts('婴儿').age).toBe('儿童')
    expect(readStateFacts('青年').age).toBe('青年')
    // An injury or illness stays state text: the format keeps it out of a field of its own.
    expect(readStateFacts('怀孕十四周 病弱').pregnancy).toBe('孕中期')
    expect(readStateFacts('怀孕十四周 病弱').costume).toEqual(['病弱'])
  })

  it('refuses to read two contradictory stages as one state', () => {
    expect(readStateFacts('孕早期、孕晚期').pregnancy).toBe(CONFLICT)
    expect(readStateFacts('青年、老年').age).toBe(CONFLICT)
  })

  it('leaves the costume and hair the dimensions did not consume', () => {
    expect(readStateFacts('孕早期（孕八周）；孕期职场装；长发').costume).toEqual(['孕期职场装', '长发'])
    expect(readStateFacts('孕早期（孕八周）、孕期职场装、长发').costume).toEqual(['孕期职场装', '长发'])
    expect(readStateFacts('服装：孕期职场装').costume).toEqual(['孕期职场装'])
    expect(readStateFacts('（）').costume).toEqual([])
    expect(hasBodyDimension(readStateFacts('职场装'))).toBe(false)
    expect(hasBodyDimension(readStateFacts('孕八周'))).toBe(true)
  })

  it('reads every declared character of one shot block, including a repeated one', () => {
    const declared = declaredBodyStates([
      '主体状态追踪：',
      '【沈知意】-身体状态：【孕早期（孕八周）；孕期职场装】；',
      '【林晚】身体状态：非孕期；青年；职场装；',
      '【小飞右脚和足球】-位置：【训练场中央】；',
    ].join('\n'))
    expect([...declared]).toEqual([
      ['沈知意', '孕早期（孕八周）；孕期职场装'],
      ['林晚', '非孕期；青年；职场装'],
    ])
    expect([...declaredBodyStates('【沈知意】-身体状态：【孕早期】；\n【沈知意】-身体状态：【孕早期】；')])
      .toEqual([['沈知意', '孕早期']])
    expect([...declaredBodyStates('【沈知意】-身体状态：【孕早期】；\n【沈知意】-身体状态：【孕晚期】；')])
      .toEqual([['沈知意', '孕早期；孕晚期']])
    // The format's own spelling: the field is bare, and its subject is the section it sits in.
    expect([...declaredBodyStates([
      '【苏晚】-位置：【场景图视角后厨左侧洗碗池前】；',
      '身体状态：【孕期阶段：孕早期；服装：孕期职场装】；',
      '【林晚】-位置：【场景图视角诊室中央偏右木椅】；',
    ].join('\n'))]).toEqual([['苏晚', '孕期阶段：孕早期；服装：孕期职场装']])
  })

  it('reads the episodes one registration declares, and what it refuses', () => {
    expect(readEpisodes(undefined)).toEqual({ kind: 'missing' })
    expect(readEpisodes(null)).toEqual({ kind: 'missing' })
    expect(readEpisodes('')).toEqual({ kind: 'missing' })
    expect(readEpisodes([])).toEqual({ kind: 'missing' })
    expect(readEpisodes(25)).toEqual({ kind: 'list', numbers: [25] })
    expect(readEpisodes(['01', 2])).toEqual({ kind: 'list', numbers: [1, 2] })
    expect(readEpisodes(['', '7'])).toEqual({ kind: 'list', numbers: [7] })
    expect(readEpisodes(['all'])).toEqual({ kind: 'all' })
    expect(readEpisodes('ALL')).toEqual({ kind: 'all' })
    expect(readEpisodes('全剧')).toEqual({ kind: 'all' })
    expect(readEpisodes(0)).toEqual({ kind: 'invalid', raw: '0' })
    expect(readEpisodes([1, '番外'])).toEqual({ kind: 'invalid', raw: '番外' })
    expect(readEpisodes({})).toEqual({ kind: 'invalid', raw: '{}' })
    expect(readEpisodes(true)).toEqual({ kind: 'invalid', raw: 'true' })
    expect(readEpisodes([{}])).toEqual({ kind: 'invalid', raw: '{}' })
    expect(readEpisodes([false])).toEqual({ kind: 'invalid', raw: 'false' })
    expect(readEpisodes([1, 0])).toEqual({ kind: 'invalid', raw: '0' })
  })

  it('judges coverage and describes it the way a refusal reads', () => {
    expect(coversEpisode({ kind: 'all' }, 99)).toBe(true)
    expect(coversEpisode({ kind: 'list', numbers: [25] }, 25)).toBe(true)
    expect(coversEpisode({ kind: 'list', numbers: [25] }, 26)).toBe(false)
    expect(coversEpisode({ kind: 'missing' }, undefined)).toBe(true)
    expect(coversEpisode({ kind: 'missing' }, 25)).toBe(false)
    expect(describeEpisodes({ kind: 'all' })).toBe('全剧')
    expect(describeEpisodes({ kind: 'list', numbers: [1, 2] })).toBe('第 1、2 集')
    expect(describeEpisodes({ kind: 'invalid', raw: '番外' })).toBe('读不出集号（episodes: 番外）')
    expect(describeEpisodes({ kind: 'missing' })).toBe('未登记 episodes')
  })
})
