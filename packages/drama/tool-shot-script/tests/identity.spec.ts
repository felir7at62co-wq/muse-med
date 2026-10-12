/** Identity and appearance regression cases for the compiler's local packaging path. */
import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bindShot, parseAssetManifest } from '../src/assets.ts'
import { materialReferenceIssues, packEpisode, prepareShotPrompts } from '../src/episode.ts'
import { parseShotScript, SOURCE_SCENE_PREFIX } from '../src/script.ts'
import type { CompiledShot, ParsedShot } from '../src/types.ts'
import { assetRow, call, cleanup, shot, speakingShot, tempDir } from './harness.ts'

/** Read one realistic shot with its explicit roster and subject state. */
function source(name: string, state = '非孕期；青年；家常装'): ParsedShot {
  const text = speakingShot(1, '苏晚：别走', ['出镜人物：苏晚', '核心场景：后厨', '关键道具：无'])
    .replaceAll('苏晚', name).replace('非孕期；青年；家常装', state)
  const result = parseShotScript(text, { actionShotSeconds: 2 }).shots[0]
  if (result === undefined) throw new Error('Missing test shot')
  return result
}

/** Bind one source with unique remote identities, preserving the result for packing. */
function bind(shot: ParsedShot, rows: Record<string, unknown>[]) {
  const manifest = parseAssetManifest({ assets: rows }, 'manifest.json').assets
  const binding = bindShot(shot, manifest, 1)
  const compiled: CompiledShot = { shot, ...binding, start: 0, end: shot.durationSeconds }
  return { manifest, binding, compiled }
}

const scene = assetRow('后厨', '场景', { jubian_asset_id: '72001', jubian_material_id: '82001' })

describe('character identities and appearance versions', () => {
  it('does not select a daughter for a mother whose name merely contains hers', () => {
    const { binding } = bind(source('苏晚的妈妈'), [assetRow('苏晚', '角色'), scene])
    expect(binding.characters).toEqual([])
    expect(binding.issues.some(issue => issue.code === 'unregistered_character')).toBe(true)
  })

  it('does not borrow body state from a shorter unrelated character', () => {
    const shot = { ...source('苏晚'), bodyStates: new Map([['苏', '非孕期；青年；家常装']]) }
    const { binding } = bind(shot, [assetRow('苏晚', '角色'), scene])
    expect(binding.issues.some(issue => issue.code === 'shot_body_state_missing')).toBe(true)
  })

  it('does not use a shared title and costume to decide which person is on screen', () => {
    const { binding } = bind(source('王总'), [
      assetRow('王明', '角色', { aliases: ['王总'] }),
      assetRow('王强', '角色', { aliases: ['王总'], state_or_costume: '非孕期；青年；西装', jubian_asset_id: '71002' }), scene,
    ])
    expect(binding.characters).toEqual([])
    expect(binding.issues.some(issue => issue.code === 'asset_binding_ambiguous')).toBe(true)
  })

  it('allows shot-authored costume on an explicit identity portrait and explains its use', () => {
    const { binding, compiled, manifest } = bind(source('林知秋', '非孕期；青年；砖红卫衣；右腕红绳'), [
      assetRow('全剧｜角色｜林知秋', '角色', { reference_scope: 'identity', state_or_costume: '非孕期；青年', jubian_asset_id: '70001' }), scene,
    ])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['全剧｜角色｜林知秋'])
    const completed = prepareShotPrompts([compiled], manifest)
    expect(completed[0]?.shot.visual).toContain('人物参考：林知秋 → @[全剧｜角色｜林知秋](asset_70001)（仅参考本人面孔与身份')
    expect(prepareShotPrompts(completed, manifest)).toEqual(completed)
    expect(packEpisode(completed, 29)[0]?.materialBindings[0]).toMatchObject({ asset_id: '70001', reference_scope: 'identity' })
  })

  it('prefers the compatible appearance version over the identity fallback', () => {
    const { binding } = bind(source('林知秋', '非孕期；青年；墨绿夹克'), [
      assetRow('林知秋', '角色', { reference_scope: 'identity', state_or_costume: '非孕期；青年' }),
      assetRow('林知秋（墨绿夹克）', '角色', { state_or_costume: '非孕期；青年；墨绿夹克', jubian_asset_id: '71002' }), scene,
    ])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['林知秋（墨绿夹克）'])
  })

  it('uses a registered story identity to select costume versions with different provider names', () => {
    const { binding } = bind(source('林知秋', '非孕期；青年；墨绿夹克'), [
      assetRow('妹妹身份母版R2', '角色', { character_name: '林知秋', reference_scope: 'identity',
        state_or_costume: '非孕期；青年' }),
      assetRow('妹妹返店装R3', '角色', { character_name: '林知秋',
        state_or_costume: '非孕期；青年；墨绿夹克', jubian_asset_id: '71002' }), scene,
    ])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['妹妹返店装R3'])
  })

  it('does not merge two registered story identities that share a costume and alias', () => {
    const { binding } = bind(source('穿外套的人'), [
      assetRow('同款外套姐姐', '角色', { character_name: '林知夏', aliases: ['穿外套的人'] }),
      assetRow('同款外套妹妹', '角色', { character_name: '林知秋', aliases: ['穿外套的人'], jubian_asset_id: '71002' }), scene,
    ])
    expect(binding.characters).toEqual([])
    expect(binding.issues.map(issue => issue.code)).toContain('asset_binding_ambiguous')
  })

  it('selects only a same-person version covering the requested episode', () => {
    const { binding } = bind(source('林知秋', '非孕期；青年；墨绿夹克'), [
      assetRow('妹妹返店装R2', '角色', { character_name: '林知秋', episodes: [2],
        state_or_costume: '非孕期；青年；墨绿夹克' }),
      assetRow('妹妹返店装R3', '角色', { character_name: '林知秋', episodes: [1],
        state_or_costume: '非孕期；青年；墨绿夹克', jubian_asset_id: '71002' }), scene,
    ])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['妹妹返店装R3'])
  })

  it('selects the matching makeup and hair version without copying another appearance', () => {
    const { compiled, manifest, binding } = bind(source('知秋', '非孕期；青年；浓妆；金色卷发；砖红卫衣'), [
      assetRow('妹妹身份母版R2', '角色', { character_name: '林知秋', aliases: ['知秋'],
        reference_scope: 'identity', state_or_costume: '非孕期；青年' }),
      assetRow('舞台妆造R3', '角色', { character_name: '林知秋', aliases: ['知秋'],
        state_or_costume: '非孕期；青年；浓妆；金色卷发；砖红卫衣', jubian_asset_id: '71002' }),
      assetRow('日常妆造R4', '角色', { character_name: '林知秋', aliases: ['知秋'],
        state_or_costume: '非孕期；青年；素颜；黑色直发；墨绿夹克', jubian_asset_id: '71003' }), scene,
    ])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['舞台妆造R3'])
    const authored = { ...compiled, shot: { ...compiled.shot,
      visual: compiled.shot.visual + '\n@[林知秋](actor)' } }
    expect(materialReferenceIssues([authored], manifest)).toEqual([])
    const task = packEpisode(prepareShotPrompts([authored], manifest), 29)[0]
    expect(task?.materialBindings[0]).toMatchObject({ material_key: 'actor', asset_id: '71002', name: '舞台妆造R3' })
    expect(task?.prompt).toContain('浓妆；金色卷发；砖红卫衣')
    expect(task?.prompt).not.toContain('日常妆造R4')
  })

  it('preserves one identity explanation when the packer no longer has the story-name manifest', () => {
    const { compiled, manifest } = bind(source('林知秋', '非孕期；青年；墨绿夹克'), [
      assetRow('妹妹身份母版R2', '角色', { character_name: '林知秋', reference_scope: 'identity',
        state_or_costume: '非孕期；青年' }), scene,
    ])
    const prepared = prepareShotPrompts([compiled], manifest)
    expect(prepareShotPrompts(prepared)).toEqual(prepared)
    const prompt = packEpisode(prepared, 29)[0]?.prompt ?? ''
    expect(prompt.match(/仅参考本人面孔与身份/g)).toHaveLength(1)
    expect(prompt).toContain('人物参考：林知秋 → @[妹妹身份母版R2](')
    expect(prompt).not.toContain('人物参考：妹妹身份母版R2 →')
  })

  it('limits each shot to its own selected children without filling later shots from the package roster', () => {
    const children = '非孕期；儿童；家常装'
    const first = bind({ ...source('小穗', children), charactersField: '小穗、狗娃',
      bodyStates: new Map([['小穗', children], ['狗娃', children]]) }, [
      assetRow('小穗', '角色', { state_or_costume: children }),
      assetRow('狗娃', '角色', { state_or_costume: children }), scene,
    ])
    const second = bind({ ...source('小穗', children), shot: 2 }, [
      assetRow('小穗', '角色', { state_or_costume: children }), scene,
    ])
    const prepared = prepareShotPrompts([first.compiled, second.compiled], first.manifest)
    expect(first.binding.issues).toEqual([])
    expect(prepared[0]?.shot.visual).toContain('本镜人物范围：最多2人，仅限小穗、狗娃')
    expect(prepared[1]?.shot.visual).toContain('本镜人物范围：最多1人，仅限小穗')
    expect(prepared[1]?.shot.visual).not.toContain('人物参考：狗娃')
    expect(prepared[0]?.shot.visual).toContain('不强求全员同框')
    expect(prepared[0]?.shot.visual).toContain('同一素材中的脸部、服装和多视角属于同一人')
    expect(prepared[0]?.shot.visual).toContain('同一key在本镜仅一个人物实例，跨镜复用不新增人物')
    const task = packEpisode(prepared, 29)[0]
    expect(task?.contentSeconds).toBe(first.compiled.shot.durationSeconds + second.compiled.shot.durationSeconds)
    expect(task?.materialKeys).toEqual(task?.materialBindings.map(row => row.material_key))
    expect(prepareShotPrompts(prepared)).toEqual(prepared)
  })

  it('replaces a previous derived cast limit when actors change or a shot becomes unpeopled', () => {
    const authored = source('苏晚')
    const { compiled, manifest } = bind({ ...authored,
      visual: `${authored.visual}\n本镜人物范围：最多3人，仅限苏晚、陆沉舟、奶奶；` }, [
      assetRow('苏晚', '角色'), scene,
    ])
    const prepared = prepareShotPrompts([compiled], manifest)
    expect(prepared[0]?.shot.visual.match(/本镜人物范围：/g)).toHaveLength(1)
    expect(prepared[0]?.shot.visual).toContain('本镜人物范围：最多1人，仅限苏晚')
    expect(prepared[0]?.shot.visual).not.toContain('最多3人')
    expect(prepareShotPrompts(prepared)).toEqual(prepared)
    const { compiled: empty, manifest: emptyManifest } = bind({ ...authored, speaker: '', voiceType: 'action',
      charactersField: '', bodyStates: new Map(),
      visual: '特写饭菜，镜头固定。\n本镜人物范围：最多1人，仅限苏晚；' }, [scene])
    const unpeopled = prepareShotPrompts([empty], emptyManifest)
    expect(unpeopled[0]?.shot.visual).toContain('本镜人物范围：0人，无人物入画')
    expect(unpeopled[0]?.shot.visual).not.toContain('苏晚')
    expect(prepareShotPrompts(unpeopled)).toEqual(unpeopled)
  })

  it('counts an English character registration as one visible person', () => {
    const { compiled, manifest, binding } = bind(source('苏晚'), [assetRow('苏晚', 'character'), scene])
    expect(binding.issues).toEqual([])
    const prepared = prepareShotPrompts([compiled], manifest)
    expect(prepared[0]?.shot.visual).toContain('本镜人物范围：最多1人，仅限苏晚')
    expect(prepareShotPrompts(prepared)).toEqual(prepared)
  })

  it('keeps an offscreen voice outside the visible identity limit', () => {
    const authored = source('陆沉舟')
    const offscreen = { ...authored, voiceType: 'vo' as const, speaker: '苏晚',
      visual: authored.visual.replace('台词：陆沉舟：别走', '台词：苏晚：别走') }
    const { compiled, manifest, binding } = bind(offscreen, [assetRow('陆沉舟', '角色'), assetRow('苏晚', '角色'), scene])
    expect(binding.characters).toEqual(['陆沉舟'])
    const prepared = prepareShotPrompts([compiled], manifest)[0]
    expect(prepared?.shot.visual).toContain('本镜人物范围：最多1人，仅限陆沉舟')
    expect(prepared?.shot.visual).not.toContain('人物参考：苏晚')
    expect(prepared?.shot.visual).toContain('台词：苏晚：别走')
    expect(prepared?.shot.speaker).toBe('苏晚')
    expect(prepared?.shot.voiceType).toBe('vo')
  })

  it('preserves distinct identity traits without inventing a beard or overriding a declared appearance change', () => {
    const { compiled, manifest } = bind(source('老算盘', '非孕期；中年；浓妆；长发'), [
      assetRow('老算盘身份母版', '角色', { character_name: '老算盘', reference_scope: 'identity',
        state_or_costume: '非孕期；中年' }), scene,
    ])
    const prepared = prepareShotPrompts([compiled], manifest)
    const prompt = prepared[0]?.shot.visual ?? ''
    expect(prompt).toContain('保留区分本人的脸型、年龄感与面部特征')
    expect(prompt).toContain('正文明确的年龄或妆造变化按本镜正文及对应正式版本')
    expect(prompt).toContain('非孕期；中年；浓妆；长发')
    expect(prompt).not.toContain('白灰胡须')
    expect(prompt).not.toContain('戴帽')
    expect(prepareShotPrompts(prepared)).toEqual(prepared)
  })

  it('explains the selected appearance prop even when its marker was already authored', () => {
    const authored = source('苏晚')
    const { compiled, manifest } = bind({ ...authored, propsField: '木枪',
      visual: `${authored.visual}\n道具外观：苏晚握着黑漆木枪\n@[木枪](wood)` }, [
      assetRow('苏晚', '角色'), scene,
      assetRow('木枪', '道具', { reference_scope: 'appearance' }),
    ])
    const prepared = prepareShotPrompts([compiled], manifest)
    const task = packEpisode(prepared, 29)[0]
    expect(task?.prompt).toContain('苏晚握着黑漆木枪')
    expect(task?.prompt).toContain('道具参考：木枪 → @[木枪](wood)（外形、结构、材质和颜色沿用本镜正式参考图')
    expect(task?.prompt).toContain('不凭道具泛名替换外观，不发明图中未确认的材质或结构')
    expect(task?.prompt).not.toContain('金属机械')
    expect(task?.materialKeys).toEqual(task?.materialBindings.map(row => row.material_key))
    expect(prepareShotPrompts(prepared)).toEqual(prepared)
  })

  it('does not turn an animal reference into an extra human when completion repeats without the manifest', () => {
    const authored = source('苏晚')
    const { compiled, manifest, binding } = bind({ ...authored,
      bodyStates: new Map([...authored.bodyStates, ['小鸡', '幼年；黄色绒毛']]),
      visual: `${authored.visual}\n小鸡在脚边啄米` }, [
      assetRow('苏晚', '角色'), scene, assetRow('小鸡', '角色', { subject_kind: 'animal' }),
    ])
    expect(binding.characters).toEqual(['苏晚', '小鸡'])
    const prepared = prepareShotPrompts([compiled], manifest)
    expect(prepared[0]?.shot.visual).toContain('本镜人物范围：最多1人，仅限苏晚')
    expect(prepareShotPrompts(prepared)).toEqual(prepared)
    expect(packEpisode(prepared, 29)[0]?.prompt).toContain('小鸡在脚边啄米')
  })

  it('reports conflicting registered stages when no version covers the requested episode', () => {
    const { binding } = bind(source('林知秋'), [
      assetRow('妹妹身份R1', '角色', { character_name: '林知秋', episodes: [2],
        state_or_costume: '非孕期；孕晚期；青年' }),
      assetRow('妹妹身份R2', '角色', { character_name: '林知秋', episodes: [3],
        state_or_costume: '非孕期；青年', jubian_asset_id: '71002' }), scene,
    ])
    const issue = binding.issues.find(issue => issue.code === 'asset_episode_mismatch')
    expect(issue?.message).toContain('孕期阶段=同一处写了两个不同取值')
    expect(binding.characters).toEqual([])
  })

  it('keeps a recalled off-screen speaker out of the visible roster', () => {
    const visible = source('李成')
    const { binding } = bind({ ...visible, speaker: '大黑', voiceType: 'vo',
      visual: visible.visual + '\n说话人：大黑\n画外音：大黑的记忆声音响起。' }, [
      assetRow('男主身份母版R1', '角色', { character_name: '李成' }),
      assetRow('队员大黑R1', '角色', { character_name: '大黑', jubian_asset_id: '71002' }), scene,
    ])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['男主身份母版R1'])
  })

  it('does not infer a person from the registered scene or prop naming them in a silent food insert', async () => {
    const text = shot(1, [
      '景别：特写', '运镜：相机固定，镜头对准李军家的饭桌和李军的碗', '视角：相机视角平视',
      '主体状态追踪：', '【饭菜】-位置：【摆在场景图视角李军家中央饭桌上，靠近李军的碗】；',
      '动作状态：【热气缓慢上升】；', '四层朝向链：【碗口朝上，画面只见桌面饭菜】；',
      '手部状态：【无人入画】；', '情绪状态：【无人物】；', '发声类型：action',
      '核心场景：李军家', '关键道具：李军的碗',
    ])
    const parsed = parseShotScript(text, { actionShotSeconds: 2 }).shots[0]
    if (parsed === undefined) throw new Error('Missing food insert')
    const rows = [assetRow('李军', '角色'), assetRow('李军家', '场景'), assetRow('李军的碗', '道具')]
    const { binding } = bind(parsed, rows)
    expect(binding.characters).toEqual([])
    expect(binding.issues).toEqual([])
    expect(binding.assets.map(asset => asset.name)).toEqual(['李军家', '李军的碗'])
    const root = await tempDir()
    try {
      const scriptPath = join(root, 'food-insert.txt')
      const assetsPath = join(root, 'assets_manifest.json')
      await writeFile(scriptPath, text)
      await writeFile(assetsPath, JSON.stringify({ assets: rows }))
      const report = await call({ method: 'preview', script: scriptPath, assets: assetsPath,
        episode: 1, max_submit_seconds: 30 })
      expect(report.ok).toBe(true)
      expect(report.failures).toEqual([])
      expect(report.packages[0]?.material_bindings.map(asset => asset.name)).toEqual(['李军家', '李军的碗'])
      expect(report.shots[0]?.bindings.filter(asset => asset.type === '角色')).toEqual([])
      expect(report.packages[0]?.prompt).toContain('本镜人物范围：0人，无人物入画')
      expect(report.packages[0]?.prompt).not.toContain('人物参考：李军')
    } finally {
      await cleanup(root)
    }
  })

  it('still infers a real person acting beside a named scene and prop when the roster is omitted', () => {
    const authored = source('李军')
    const { binding } = bind({ ...authored, charactersField: '', sceneField: '李军家', propsField: '李军的碗',
      visual: authored.visual.replaceAll('后厨', '李军家') + '\n李军举起李军的碗。' }, [
      assetRow('李军', '角色'), assetRow('李军家', '场景'), assetRow('李军的碗', '道具'),
    ])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['李军'])
  })

  it('does not use exact person names in scene and prop fields as an on-screen roster', () => {
    const authored = source('李军')
    const { binding } = bind({ ...authored, charactersField: '', sceneField: '李军', propsField: '苏晚',
      visual: '景别：特写\n运镜：相机固定，只拍饭菜\n核心场景：李军\n关键道具：苏晚', bodyStates: new Map() }, [
      assetRow('李军', '角色', { jubian_asset_id: '71001' }),
      assetRow('苏晚', '角色', { jubian_asset_id: '71002' }),
      assetRow('李军', '场景', { jubian_asset_id: '72001' }),
      assetRow('苏晚', '道具', { jubian_asset_id: '73001' }),
    ])
    expect(binding.characters).toEqual([])
    expect(binding.issues).toEqual([])
    expect(binding.assets.map(asset => [asset.name, asset.type])).toEqual([['李军', '场景'], ['苏晚', '道具']])
  })

  it('does not bind subjects, scenes or props mentioned only in structural source-scene context', () => {
    const context = `${SOURCE_SCENE_PREFIX}场次54-2：苏晚 后厨 奶瓶 小鸡 次日清晨 内；本镜可为内外插镜，具体以本镜画面与核心场景为准。`
    const parsed = { ...source('苏晚'), charactersField: '', sceneField: '', propsField: '', bodyStates: new Map(),
      visual: `${context}\n景别：特写\n运镜：相机固定，只拍墙面\n发声类型：action` }
    const { binding, compiled } = bind(parsed, [assetRow('苏晚', '角色'), scene,
      assetRow('奶瓶', '道具'), assetRow('小鸡', '动物')])
    expect(binding.characters).toEqual([])
    expect(binding.scene).toBe('')
    expect(binding.props).toEqual([])
    expect(binding.assets).toEqual([])
    expect(binding.issues.map(issue => issue.code)).toEqual(['no_scene_bound'])
    expect(packEpisode([compiled], 29)[0]?.prompt).toContain(context)
  })

  it('keeps actual visual actions and explicit fields effective beside structural source-scene context', () => {
    const authored = source('苏晚')
    const context = `${SOURCE_SCENE_PREFIX}场次54-2：客厅 夜 内；本镜可为内外插镜，具体以本镜画面与核心场景为准。`
    const { binding } = bind({ ...authored, charactersField: '', propsField: '奶瓶',
      visual: `${context}\n${authored.visual}\n苏晚握住奶瓶。` }, [assetRow('苏晚', '角色'), scene,
      assetRow('客厅', '场景'), assetRow('奶瓶', '道具')])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['苏晚'])
    expect(binding.scene).toBe('后厨')
    expect(binding.props).toEqual(['奶瓶'])
    expect(binding.assets.map(asset => asset.name)).toEqual(['苏晚', '后厨', '奶瓶'])
  })

  it('masks registered scene and prop aliases while retaining explicit character selection', () => {
    const authored = source('李军')
    const rows = [assetRow('李军', '角色', { aliases: ['军哥'] }),
      assetRow('李军家', '场景', { aliases: ['军哥的小院'] }),
      assetRow('李军的碗', '道具', { aliases: ['军哥的饭碗'] })]
    const visual = '运镜：相机固定，特写军哥的小院桌面上的军哥的饭碗。'
    const absent = bind({ ...authored, charactersField: '', sceneField: '李军家', propsField: '李军的碗',
      visual, bodyStates: new Map() }, rows)
    expect(absent.binding.characters).toEqual([])
    expect(absent.binding.issues).toEqual([])
    const present = bind({ ...authored, charactersField: '军哥', sceneField: '李军家', propsField: '李军的碗', visual }, rows)
    expect(present.binding.characters).toEqual(['李军'])
    expect(present.binding.issues).toEqual([])
  })

  it('does not erase a real actor name that contains a shorter prop name', () => {
    const authored = source('老算盘')
    const { binding } = bind({ ...authored, charactersField: '', propsField: '算盘',
      visual: authored.visual + '\n老算盘拨动算盘。' }, [
      assetRow('老算盘', '角色'), scene, assetRow('算盘', '道具'),
    ])
    expect(binding.issues).toEqual([])
    expect(binding.characters).toEqual(['老算盘'])
    expect(binding.props).toEqual(['算盘'])
  })

  it('keeps an unapproved version out of a successful package', () => {
    const { binding } = bind(source('林知秋'), [assetRow('林知秋', '角色', { official: false }), scene])
    expect(binding.issues.some(issue => issue.code === 'unconfirmed_asset')).toBe(true)
  })

  it('keeps a dedicated appearance version from silently changing its registered costume', () => {
    const { binding } = bind(source('林知秋', '非孕期；青年；墨绿夹克'), [
      assetRow('林知秋', '角色', { state_or_costume: '非孕期；青年；砖红卫衣' }), scene,
    ])
    expect(binding.issues.some(issue => issue.code === 'asset_state_mismatch')).toBe(true)
  })

  it('still rejects age contradictions on an identity portrait', () => {
    const { binding } = bind(source('林知秋', '非孕期；老年；墨绿夹克'), [
      assetRow('林知秋', '角色', { reference_scope: 'identity', state_or_costume: '非孕期；青年' }), scene,
    ])
    expect(binding.issues.some(issue => issue.code === 'asset_state_mismatch')).toBe(true)
  })

  it('rejects contradictory body stages even when both registration and shot repeat them', () => {
    const state = '非孕期；孕早期；青年'
    const { binding } = bind(source('林知秋', state), [assetRow('林知秋', '角色', { state_or_costume: state }), scene])
    expect(binding.issues.some(issue => issue.code === 'shot_body_state_unusable')).toBe(true)
  })

  it('refuses an unknown reference scope at the file parser', () => {
    expect(() => parseAssetManifest({ assets: [assetRow('林知秋', '角色', { reference_scope: 'automatic' })] }, 'manifest.json'))
      .toThrow('reference_scope')
  })
})

describe('prompt references and local packages', () => {
  it.each(['@[苏晚](asset_99999)', '@[另一人](lead)'])('reports the stale reference %s before any package write', (marker) => {
    const { compiled, manifest } = bind({ ...source('苏晚'), visual: source('苏晚').visual + '\n' + marker }, [assetRow('苏晚', '角色'), scene])
    expect(materialReferenceIssues([compiled], manifest).map(issue => issue.code)).toEqual(['material_reference_mismatch'])
  })

  it('does not let a key selected for one actor name a different actor in another shot', () => {
    const first = bind({ ...source('苏晚'), visual: source('苏晚').visual + '\n@[苏晚](lead)' }, [assetRow('苏晚', '角色'), scene])
    const second = bind({ ...source('陆沉舟'), visual: source('陆沉舟').visual + '\n@[陆沉舟](lead)' }, [
      assetRow('陆沉舟', '角色', { jubian_asset_id: '71002' }), scene,
    ])
    expect(materialReferenceIssues([first.compiled, second.compiled], [...first.manifest, ...second.manifest]))
      .toMatchObject([{ code: 'material_reference_mismatch' }])
  })

  it('rejects one parent asset ID naming different people or different material versions', () => {
    const first = bind(source('苏晚'), [assetRow('苏晚', '角色'), scene])
    const second = bind(source('陆沉舟'), [assetRow('陆沉舟', '角色', { jubian_asset_id: '70001' }), scene])
    expect(materialReferenceIssues([first.compiled, second.compiled], [...first.manifest, ...second.manifest]))
      .toMatchObject([{ code: 'material_reference_mismatch' }])
    const changed = { ...first.compiled, assets: first.compiled.assets.map(asset => asset.name === '苏晚'
      ? { ...asset, materialId: '80002', url: 'https://cdn.example.test/changed.png' } : asset) }
    expect(materialReferenceIssues([first.compiled, changed], first.manifest))
      .toMatchObject([{ code: 'material_reference_mismatch' }])
  })

  it('refuses invalid references when the pure packer is called without tool validation', () => {
    const { compiled } = bind({ ...source('苏晚'), visual: source('苏晚').visual + '\n@[苏晚](asset_99999)' },
      [assetRow('苏晚', '角色'), scene])
    expect(() => packEpisode([compiled], 29)).toThrow('本镜选定资产不一致')
  })

  it.each([
    { official: false }, { jubian_asset_id: '' }, { jubian_material_id: '' }, { url: '' },
  ])('refuses unapproved or incomplete bound materials in the pure packer: %j', (fields) => {
    const { compiled } = bind(source('苏晚'), [assetRow('苏晚', '角色', fields), scene])
    expect(() => packEpisode([compiled], 29)).toThrow('未确认出演或缺少父资产、material ID、URL')
  })

  it('normalizes repeated references to one material and carries exact IDs independent of list order', () => {
    const shot = source('苏晚')
    const { compiled, manifest } = bind({ ...shot, visual: shot.visual + '\n@[后厨](room) @[晚晚](lead) @[苏晚](different)' }, [
      assetRow('苏晚', '角色', { aliases: ['晚晚'] }), scene,
    ])
    expect(materialReferenceIssues([compiled], manifest)).toEqual([])
    const completed = prepareShotPrompts([compiled], manifest)
    const pack = packEpisode(completed, 29)[0]
    expect(pack?.materialKeys).toEqual(['room', 'lead'])
    expect(pack?.materialBindings.map(row => [row.material_key, row.asset_id, row.name])).toEqual([
      ['room', '72001', '后厨'], ['lead', '70001', '苏晚'],
    ])
    expect(pack?.prompt).not.toContain('](different)')
    expect(pack?.prompt).toContain('台词：苏晚：别走')
  })

  it('reuses the first actor key through multiple shots without losing another actor or scene', () => {
    const first = bind({ ...source('苏晚'), visual: source('苏晚').visual + '\n@[晚晚](lead)' }, [
      assetRow('苏晚', '角色', { aliases: ['晚晚'] }), scene,
    ])
    const secondSource = source('陆沉舟')
    const second = bind({ ...secondSource, visual: secondSource.visual + '\n@[陆沉舟](partner)' }, [
      assetRow('陆沉舟', '角色', { jubian_asset_id: '71002' }), scene,
    ])
    const third = { ...first.compiled, shot: { ...first.compiled.shot, shot: 3,
      visual: first.compiled.shot.visual.replace('](lead)', '](alternate)') } }
    const manifest = [...first.manifest, ...second.manifest]
    const prepared = prepareShotPrompts([first.compiled, second.compiled, third], manifest)
    expect(prepareShotPrompts(prepared, manifest)).toEqual(prepared)
    const task = packEpisode(prepared, 29)[0]
    expect(task?.materialKeys).toEqual(['lead', 'asset_72001', 'partner'])
    expect(task?.materialBindings.map(binding => binding.material_key)).toEqual(task?.materialKeys)
    expect(task?.materialBindings.map(binding => binding.asset_id)).toEqual(['70001', '72001', '71002'])
    expect(task?.prompt).not.toContain('](alternate)')
    expect(task?.materialBindings.filter(binding => binding.asset_id === '70001')).toHaveLength(1)
  })

  it('refuses a prompt marker for a scene that the shot did not bind', () => {
    const { compiled, manifest } = bind({ ...source('苏晚'), visual: source('苏晚').visual + '\n@[客厅](living)' }, [
      assetRow('苏晚', '角色'), scene, assetRow('客厅', '场景'),
    ])
    expect(materialReferenceIssues([compiled], manifest)).toMatchObject([{ code: 'material_reference_mismatch' }])
    expect(() => packEpisode([compiled], 29)).toThrow('本镜选定资产不一致')
  })
})
