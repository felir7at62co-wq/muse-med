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
        .replace('台词：温雨：先把门关上。\n发声类型：dialogue', '说话人：温雨\n台词：温雨：先把门关上。\n发声类型：vo')
        .replace('抬头回应画外声音', '回忆周明曾经的声音，不按该句对口型')
        .replace('动作状态：【停下手里的工作，抬头听】；', '动作状态：【记忆音：回忆中的周明声音，不是当前场景正在说话；不新增周明出镜】；')
      await writeFile(join(root, 'shot-script.txt'), text)
      await writeFile(join(root, 'assets_manifest.json'), assets)
      const preview = await call(argumentsFor(previewArgs, root))
      expect(preview).toMatchObject({ ok: true, failures: [], written: [] })
      expect(preview.shots[0]).toMatchObject({ voice_type: 'vo', speaker: '温雨', text: '先把门关上。' })
      expect(preview.shots[2]).toMatchObject({ voice_type: 'vo', speaker: '周明', text: '雨停了再走。' })
      expect(preview.packages[0]!.prompt).toContain('OS/心声，通过内心独白表达；画面人物不对这句发声，不按该句对口型')
      expect(preview.packages[0]!.prompt).toContain('情绪状态：【嘴唇微张，呼吸平稳】；')
      const memoryPrompt = preview.packages.map(pack => pack.prompt).find(prompt => prompt.includes('记忆音：'))
      expect(memoryPrompt).toContain('回忆中的周明声音，不是当前场景正在说话；不新增周明出镜')
      expect(preview.packages.flatMap(pack => pack.material_bindings).some(asset => asset.asset_id === '71005')).toBe(false)
    } finally {
      await cleanup(root)
    }
  })
})
