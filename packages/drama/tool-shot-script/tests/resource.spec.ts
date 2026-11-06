/** Historical director-format examples for compiler compatibility checks. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { MatchedPayload } from '../src/types.ts'
import { parseShotScript } from '../src/script.ts'
import { call, cleanup, dramaShot, tempDir } from './harness.ts'

const resource = new URL('./director-format.fixture.txt', import.meta.url)

/** Extract the retained legacy compiler examples. */
async function examples(): Promise<string[]> {
  const markdown = await readFile(resource, 'utf8')
  return [...markdown.matchAll(/```(?:json|text)\n([\s\S]*?)\n```/g)].map(match => match[1]!)
}

/** Resolve the example's workspace-relative paths without mutating process cwd. */
function argumentsFor(text: string, root: string): Record<string, unknown> {
  const args = JSON.parse(text) as Record<string, unknown>
  for (const field of ['script', 'assets']) {
    const path = args[field]
    if (typeof path !== 'string') throw new Error(`Example needs ${field}`)
    args[field] = join(root, path)
  }
  args.project = root
  expect(validateJsonSchemaValue(dramaShot().parameters, args, '')).toEqual([])
  return args
}

describe('packaged director-format examples', () => {
  it.each(['真人短剧写实风格', '写实3D CG渲染风格'])('compiles the %s example through the actual tool', async (style) => {
    const [assets, source, previewArgs, compileArgs] = await examples()
    if (assets === undefined || source === undefined || previewArgs === undefined || compileArgs === undefined) {
      throw new Error('The resource needs manifest, script, preview and compile examples')
    }
    const root = await tempDir()
    try {
      const text = source.replaceAll('真人短剧写实风格', style)
      await mkdir(join(root, 'episodes'), { recursive: true })
      await writeFile(join(root, 'episodes', '01.txt'), '温雨请人关门，换上雨衣。温雪听见周明在画外说雨停再走。\n')
      await writeFile(join(root, 'shot-script.txt'), text)
      await writeFile(join(root, 'assets_manifest.json'), assets)
      const preview = await call(argumentsFor(previewArgs, root))
      expect(preview.ok).toBe(true)
      expect(preview.failures).toEqual([])
      expect(preview.written).toEqual([])
      expect(preview.shots.map(shot => shot.voice_type)).toEqual(['dialogue', 'action', 'vo'])
      expect(preview.shots.map(shot => shot.bindings.filter(asset => asset.type === '角色').map(asset => asset.asset_id)))
        .toEqual([['71001'], ['71002'], ['71003']])
      expect(preview.shots[2]).toMatchObject({ speaker: '周明', text: '雨停了再走。', offscreen: true })
      expect(preview.packages.flatMap(pack => pack.material_bindings).some(asset => asset.asset_id === '71005')).toBe(false)
      expect(preview.packages.every(pack => !pack.prompt.includes('时长：'))).toBe(true)
      expect(preview.packages.flatMap(pack => pack.material_bindings)).toEqual(expect.arrayContaining([
        expect.objectContaining({ asset_id: '71001', reference_scope: 'identity' }),
        expect.objectContaining({ asset_id: '71002', reference_scope: 'appearance' }),
      ]))
      const compiled = await call(argumentsFor(compileArgs, root))
      expect(compiled.ok).toBe(true)
      expect(compiled.failures).toEqual([])
      const payload = JSON.parse(await readFile(join(root, 'matches', '01.matched.json'), 'utf8')) as MatchedPayload
      expect(payload.version).toBe(5)
      expect(payload.video_tasks.flatMap(task => task.material_bindings)).toEqual(preview.packages.flatMap(pack => pack.material_bindings))
      expect(payload.video_tasks.every(task => !task.prompt.includes('时长：'))).toBe(true)
      expect(await readFile(join(root, 'episode_packages', '01', 'episode.txt'), 'utf8'))
        .toBe('温雨请人关门，换上雨衣。温雪听见周明在画外说雨停再走。\n')
    } finally {
      await cleanup(root)
    }
  })

  it('rejects adding the silent action declaration to the speaking example', async () => {
    const [, source] = await examples()
    if (source === undefined) throw new Error('Missing director text example')
    const invalid = source.replace('发声类型：dialogue', '发声类型：action')
    expect(parseShotScript(invalid, { actionShotSeconds: 2 }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'action_voice_with_dialogue', shot: 1 })]))
  })

  it('keeps indoor and outdoor scene bindings separate when the depicted action moves outside', async () => {
    const [assets, source, previewArgs] = await examples()
    if (assets === undefined || source === undefined || previewArgs === undefined) throw new Error('Missing compiler examples')
    const root = await tempDir()
    try {
      const manifest = JSON.parse(assets) as { assets: Record<string, unknown>[] }
      manifest.assets.push({ name: '后厨门外', type: '场景', id: 'kitchen-outside', official: true,
        jubian_asset_id: '71006', jubian_material_id: '81006',
        url: 'https://example.invalid/kitchen-outside.png', episodes: ['all'] })
      const outside = source.replace(/(【镜头2】[\s\S]*?)(?=\n真人短剧写实风格\n【镜头3】)/, block => block
        .replace('核心场景：后厨', '核心场景：后厨门外')
        .replaceAll('门框内', '门外')
        .replace('后厨左侧门外', '后厨门外雨棚下'))
      await writeFile(join(root, 'shot-script.txt'), outside)
      await writeFile(join(root, 'assets_manifest.json'), JSON.stringify(manifest))
      const preview = await call(argumentsFor(previewArgs, root))
      expect(preview).toMatchObject({ ok: true, failures: [], written: [] })
      expect(preview.shots.map(shot => shot.bindings.filter(asset => asset.type === '场景').map(asset => asset.asset_id)))
        .toEqual([['71004'], ['71006'], ['71004']])
      expect(preview.packages).toHaveLength(3)
      expect(preview.packages[1]!.prompt).toContain('核心场景：后厨门外')
      expect(preview.packages[1]!.material_bindings.filter(asset => asset.type === '场景'))
        .toEqual([expect.objectContaining({ asset_id: '71006' })])
    } finally {
      await cleanup(root)
    }
  })

  it('preserves inner speech and remembered voice semantics beside the vo machine value', async () => {
    const [assets, source, previewArgs] = await examples()
    if (assets === undefined || source === undefined || previewArgs === undefined) throw new Error('Missing compiler examples')
    const root = await tempDir()
    try {
      const text = source
        .replace('动作状态：【抬头回应，嘴唇微张】；', '动作状态：【OS/心声，通过内心独白表达；画面人物不对这句发声，不按该句对口型，表情动作按原文】；')
        .replace('台词：温雨：先把门关上。\n发声类型：dialogue', '说话人：温雨\n台词：温雨：先把门关上。\n发声类型：vo\n发声说明：温雨的内心声音，仅配音，不对口型。')
        .replace('抬头回应画外声音', '回忆周明曾经的声音，不按该句对口型')
        .replace('动作状态：【停下手里的工作，抬头听】；', '动作状态：【记忆音：回忆中的周明声音，不是当前场景正在说话；不新增周明出镜】；\n发声说明：周明的记忆音，原文未交代传声方式。')
      await writeFile(join(root, 'shot-script.txt'), text)
      await writeFile(join(root, 'assets_manifest.json'), assets)
      const preview = await call(argumentsFor(previewArgs, root))
      expect(preview).toMatchObject({ ok: true, failures: [], written: [] })
      expect(preview.shots[0]).toMatchObject({ voice_type: 'vo', speaker: '温雨', text: '先把门关上。' })
      expect(preview.shots[2]).toMatchObject({ voice_type: 'vo', speaker: '周明', text: '雨停了再走。' })
      expect(preview.packages[0]!.prompt).toContain('OS/心声，通过内心独白表达；画面人物不对这句发声，不按该句对口型')
      expect(preview.packages[0]!.prompt).toContain('情绪状态：【嘴唇微张，呼吸平稳】；')
      expect(preview.packages[0]!.prompt).toContain('发声说明：温雨的内心声音，仅配音，不对口型。')
      const memoryPrompt = preview.packages.map(pack => pack.prompt).find(prompt => prompt.includes('记忆音：'))
      expect(memoryPrompt).toContain('回忆中的周明声音，不是当前场景正在说话；不新增周明出镜')
      expect(memoryPrompt).toContain('发声说明：周明的记忆音，原文未交代传声方式。')
      expect(preview.packages.flatMap(pack => pack.material_bindings).some(asset => asset.asset_id === '71005')).toBe(false)
    } finally {
      await cleanup(root)
    }
  })

  it('keeps a person mentioned in a conditional thought out of the current shot and its image bindings', async () => {
    const [assets, source, , compileArgs] = await examples()
    if (assets === undefined || source === undefined || compileArgs === undefined) throw new Error('Missing compiler examples')
    const root = await tempDir()
    try {
      const thought = '我要是喊出来，周明就会冲进来。'
      const director = source
        .replace('动作状态：【抬头回应，嘴唇微张】；', '动作状态：【保持站姿，双手按着台沿；内心独白，不对这句发声，不按该句对口型】；')
        .replace('台词：温雨：先把门关上。\n发声类型：dialogue', `说话人：温雨\nOS：${thought}\n发声类型：心声`)
      const parsed = parseShotScript(director, { actionShotSeconds: 2 })
      expect(parsed.issues.filter(issue => issue.severity === 'failure')).toEqual([])
      expect(parsed.shots[0]).toMatchObject({ voiceType: 'vo', speaker: '温雨', text: thought, charactersField: '温雨' })
      await mkdir(join(root, 'episodes'), { recursive: true })
      const original = `温雨站在后厨台面边，手掌按着台沿。温雨OS：${thought}\n`
      await writeFile(join(root, 'episodes', '01.txt'), original)
      await writeFile(join(root, 'shot-script.txt'), director)
      await writeFile(join(root, 'assets_manifest.json'), assets)
      const compiled = await call(argumentsFor(compileArgs, root))
      expect(compiled).toMatchObject({ ok: true, failures: [] })
      expect(compiled.shots[0]?.bindings.filter(asset => asset.type === '角色').map(asset => asset.asset_id)).toEqual(['71001'])
      const payload = JSON.parse(await readFile(join(root, 'matches', '01.matched.json'), 'utf8')) as MatchedPayload
      expect(payload.shots[0]).toMatchObject({ voice_type: 'vo', speaker: '温雨', text: thought })
      const prompt = payload.video_tasks.find(task => task.shots.includes(1))?.prompt
      expect(prompt).toContain(`OS：${thought}`)
      expect(prompt).toContain('不对这句发声，不按该句对口型')
      expect(prompt).not.toContain('【周明】-位置')
      expect(prompt).not.toMatch(/出镜人物：[^\n]*周明/u)
      expect(payload.video_tasks.flatMap(task => task.material_bindings).some(binding => binding.asset_id === '71005')).toBe(false)
      expect(payload.video_tasks.map(task => task.prompt)).toEqual(compiled.packages.map(pack => pack.prompt))
      expect(await readFile(join(root, 'episode_packages', '01', 'episode.txt'), 'utf8')).toBe(original)
    } finally {
      await cleanup(root)
    }
  })

  it('keeps intercom reception separate from a later direct spoken reply outside the room', async () => {
    const [assets, source, , compileArgs] = await examples()
    if (assets === undefined || source === undefined || compileArgs === undefined) throw new Error('Missing compiler examples')
    const root = await tempDir()
    try {
      const manifest = JSON.parse(assets) as { assets: Record<string, unknown>[] }
      manifest.assets.push({ name: '对讲机', type: '道具', id: 'offline-intercom', official: true,
        jubian_asset_id: '71006', jubian_material_id: '81006', url: 'https://example.invalid/intercom.png', episodes: ['all'] })
      const director = source
        .replace('动作状态：【抬头回应，嘴唇微张】；', '动作状态：【温雨低声自语，对讲机通话键按下；门外的周明从对讲机听见这句话】；')
        .replace('台词：温雨：先把门关上。', '台词：温雨：钥匙到底放哪了？')
        .replace('关键道具：无', '关键道具：对讲机')
        .replace('抬头回应画外声音', '抬头回应门外直接说话的声音')
        .replace('动作状态：【停下手里的工作，抬头听】；', '动作状态：【温雪停下手里的工作；周明在后厨门外直接朝屋内答话，她听见门口的声音】；\n发声说明：周明在门外现场说话，朝后厨答复，原文未交代设备回传。')
        .replace('台词：周明（画外音）：雨停了再走。', '台词：周明（画外音）：在柜子下面。')
      const parsed = parseShotScript(director, { actionShotSeconds: 2 })
      expect(parsed.issues.filter(issue => issue.severity === 'failure')).toEqual([])
      expect(parsed.shots[0]).toMatchObject({ voiceType: 'dialogue', speaker: '温雨', text: '钥匙到底放哪了？' })
      expect(parsed.shots[2]).toMatchObject({ voiceType: 'vo', speaker: '周明', text: '在柜子下面。' })
      await mkdir(join(root, 'episodes'), { recursive: true })
      const original = '温雨低声自语：钥匙到底放哪了？对讲机通话键按下。门外的周明从对讲机听见后，直接朝屋内答话：在柜子下面。\n'
      await writeFile(join(root, 'episodes', '01.txt'), original)
      await writeFile(join(root, 'shot-script.txt'), director)
      await writeFile(join(root, 'assets_manifest.json'), JSON.stringify(manifest))
      const compiled = await call(argumentsFor(compileArgs, root))
      expect(compiled).toMatchObject({ ok: true, failures: [] })
      const payload = JSON.parse(await readFile(join(root, 'matches', '01.matched.json'), 'utf8')) as MatchedPayload
      const prompts = payload.video_tasks.map(task => task.prompt)
      expect(prompts).toEqual(compiled.packages.map(pack => pack.prompt))
      expect(prompts.join('\n')).toContain('门外的周明从对讲机听见这句话')
      expect(prompts.join('\n')).toContain('周明在后厨门外直接朝屋内答话')
      expect(prompts.join('\n')).toContain('台词：周明（画外音）：在柜子下面。')
      expect(prompts.join('\n')).toContain('发声说明：周明在门外现场说话，朝后厨答复，原文未交代设备回传。')
      expect(prompts.join('\n')).not.toContain('对讲机里传回')
      expect(prompts.join('\n')).not.toContain('对讲机中传回')
      expect(await readFile(join(root, 'episode_packages', '01', 'episode.txt'), 'utf8')).toBe(original)
    } finally {
      await cleanup(root)
    }
  })

  it.each([
    { name: 'unspecified hand assignments', action: '站回台面边，手扶台沿',
      hands: '手扶台沿；原文未指定左右手、持物方式或放置位置',
      original: '温雨站回台面边，手扶台沿，在心里默念：先把门关上。' },
    { name: 'successive hand states', action: '先右手扶住台沿，随后右手离开台沿，双手整理围裙',
      hands: '起初右手扶台沿，随后双手整理围裙；两阶段依次发生',
      original: '温雨先右手扶住台沿，随后松开，双手整理围裙，在心里默念：先把门关上。' },
  ])('preserves $name and its inner voice explanation in the persisted compiled prompt', async (example) => {
    const [assets, source, , compileArgs] = await examples()
    if (assets === undefined || source === undefined || compileArgs === undefined) throw new Error('Missing compiler examples')
    const root = await tempDir()
    try {
      const sound = '发声说明：温雨的内心声音，仅作配音，不按这句对口型，动作按上述先后进行。'
      const action = `动作状态：【${example.action}】；`, hands = `手部状态：【${example.hands}】；`
      const director = source
        .replace('动作状态：【抬头回应，嘴唇微张】；', action)
        .replace('手部状态：【双手放在台面上】；', hands)
        .replace('台词：温雨：先把门关上。\n发声类型：dialogue', `说话人：温雨\n台词：温雨：先把门关上。\n发声类型：vo\n${sound}`)
      await mkdir(join(root, 'episodes'), { recursive: true })
      await writeFile(join(root, 'episodes', '01.txt'), example.original + '\n')
      await writeFile(join(root, 'shot-script.txt'), director)
      await writeFile(join(root, 'assets_manifest.json'), assets)
      const compiled = await call(argumentsFor(compileArgs, root))
      expect(compiled).toMatchObject({ ok: true, failures: [] })
      const payload = JSON.parse(await readFile(join(root, 'matches', '01.matched.json'), 'utf8')) as MatchedPayload
      const prompt = payload.video_tasks.find(task => task.shots.includes(1))?.prompt
      expect(prompt).toContain(action)
      expect(prompt).toContain(hands)
      expect(prompt).toContain(sound)
      expect(prompt).toContain('台词：温雨：先把门关上。')
      expect(payload.video_tasks.map(task => task.prompt)).toEqual(compiled.packages.map(pack => pack.prompt))
      expect(await readFile(join(root, 'episode_packages', '01', 'episode.txt'), 'utf8')).toBe(example.original + '\n')
    } finally {
      await cleanup(root)
    }
  })

  it.each([
    {
      name: 'an inner thought without adding a reflection, listener or prone action', voice: 'vo', declaration: '心声',
      speech: 'OS：先把门关上。', prop: null,
      action: 'OS/心声，内心独白；双手仍按着台面边缘，保持站姿；不对这句发声，不按该句对口型',
      original: '温雨站在后厨台面前，双手按着台面边缘。温雨OS：先把门关上。',
      retained: ['内心独白', '保持站姿', '不对这句发声', '不按该句对口型'],
      absent: ['镜子', '倒影', '趴地', '趴在地上'],
    },
    {
      name: 'audible self-talk heard through a live intercom', voice: 'dialogue', declaration: 'dialogue',
      speech: '台词：温雨：先把门关上。', prop: '对讲机',
      action: '温雨站在台面前低声自语；对讲机通话键保持按下，画外的周明从对讲机听见这句话',
      original: '温雨站在台面前低声自语：先把门关上。对讲机通话键保持按下，画外的周明听见了。',
      retained: ['低声自语', '通话键保持按下', '周明从对讲机听见这句话'],
      absent: ['内心独白', '不对这句发声', '不按该句对口型'],
    },
    {
      name: 'explicit speech to the character\'s own mirror reflection', voice: 'dialogue', declaration: 'dialogue',
      speech: '台词：温雨：先把门关上。', prop: '镜子',
      action: '温雨站在柜门前，对着镜子里的自己低声说话',
      original: '温雨站在柜门前，对着镜子里的自己低声说：先把门关上。',
      retained: ['站在柜门前', '对着镜子里的自己低声说话'],
      absent: ['不对这句发声', '趴在地上'],
    },
    {
      name: 'an explicit silent prone action', voice: 'action', declaration: 'action',
      speech: '', prop: '钥匙', action: '温雨趴在地上，伸手够柜底的钥匙',
      original: '温雨趴在地上，伸手够柜底的钥匙；没有发声。',
      retained: ['趴在地上', '伸手够柜底的钥匙'], absent: ['内心独白', '对着镜子'],
    },
  ])('compiles $name into the actual persisted episode/video prompt', async (example) => {
    const [assets, source, , compileArgs] = await examples()
    if (assets === undefined || source === undefined || compileArgs === undefined) throw new Error('Missing compiler examples')
    const root = await tempDir()
    try {
      const manifest = JSON.parse(assets) as { assets: Record<string, unknown>[] }
      if (example.prop !== null) manifest.assets.push({ name: example.prop, type: '道具', id: 'voice-scene-prop', official: true,
        jubian_asset_id: '71006', jubian_material_id: '81006',
        url: 'https://example.invalid/voice-scene-prop.png', episodes: ['all'] })
      const voiceFields = example.voice === 'action' ? '发声类型：action'
        : `说话人：温雨\n${example.speech}\n发声类型：${example.declaration}`
      const director = source
        .replace('动作状态：【抬头回应，嘴唇微张】；', `动作状态：【${example.action}】；`)
        .replace('台词：温雨：先把门关上。\n发声类型：dialogue', voiceFields)
        .replace('关键道具：无', `关键道具：${example.prop ?? '无'}`)
      const parsed = parseShotScript(director, { actionShotSeconds: 2 })
      expect(parsed.issues.filter(issue => issue.severity === 'failure')).toEqual([])
      expect(parsed.shots[0]).toMatchObject({ voiceType: example.voice, speaker: example.voice === 'action' ? '' : '温雨',
        text: example.voice === 'action' ? '' : '先把门关上。' })
      await mkdir(join(root, 'episodes'), { recursive: true })
      await writeFile(join(root, 'episodes', '01.txt'), example.original + '\n')
      await writeFile(join(root, 'shot-script.txt'), director)
      await writeFile(join(root, 'assets_manifest.json'), JSON.stringify(manifest))
      const compiled = await call(argumentsFor(compileArgs, root))
      expect(compiled).toMatchObject({ ok: true, failures: [] })
      const payload = JSON.parse(await readFile(join(root, 'matches', '01.matched.json'), 'utf8')) as MatchedPayload
      expect(payload.video_tasks.map(task => task.prompt)).toEqual(compiled.packages.map(pack => pack.prompt))
      const prompt = payload.video_tasks.find(task => task.shots.includes(1))?.prompt
      expect(prompt).toBeDefined()
      for (const fragment of example.retained) expect(prompt).toContain(fragment)
      for (const fragment of example.absent) expect(prompt).not.toContain(fragment)
      expect(payload.shots[0]).toMatchObject({ voice_type: example.voice, speaker: example.voice === 'action' ? '' : '温雨',
        text: example.voice === 'action' ? '' : '先把门关上。' })
      expect(await readFile(join(root, 'episode_packages', '01', 'episode.txt'), 'utf8')).toBe(example.original + '\n')
      expect(await readFile(join(root, 'shot-script.txt'), 'utf8')).toBe(director)
    } finally {
      await cleanup(root)
    }
  })
})
