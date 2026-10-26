/** Advisory review preserves authored work while operational failures remain errors. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { DramaShotReport } from '../src/types.ts'
import { assetRow, cleanup, manifestDocument, speakingShot, tempDir } from './harness.ts'
import { registeredShot } from './fixtures/registered-shot.ts'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose()
})

async function fixture(options: { script?: string; assets?: Record<string, unknown>[]; reviewMode?: 'strict' | 'advisory' } = {}) {
  const root = await tempDir()
  cleanups.push(() => cleanup(root))
  const script = join(root, 'authored.txt')
  const assets = join(root, 'assets.json')
  const original = options.script ?? speakingShot(1, '苏晚：等一下……我想把这句话说完。', [
    '出镜人物：苏晚', '核心场景：后厨', '时长：20秒',
  ])
  await writeFile(script, original)
  await writeFile(assets, JSON.stringify(manifestDocument(...options.assets ?? [assetRow('苏晚', '角色'), assetRow('后厨', '场景')])))
  const tool = await registeredShot(root, { reviewMode: options.reviewMode ?? 'advisory' })
  cleanups.push(tool.dispose)
  return { root, script, assets, original, tool,
    args: { script, assets, project: root, episode: 1, max_submit_seconds: 15 } }
}

function warningCodes(report: DramaShotReport): string[] {
  return report.warnings.map(issue => issue.code)
}

it('reports an undersized performance plan as advice without accepting it for generation', async () => {
  const f = await fixture({ script: speakingShot(1, '苏晚：等我回来。', [
    '出镜人物：苏晚', '核心场景：后厨', '时长：4秒', '动作预算：6秒',
    '发声预算：3秒', '反应预算：2秒', '表演顺序：先动作后台词',
  ]) })
  const report = await f.tool.report({ ...f.args, method: 'preview' })
  expect(report.ok).toBe(true)
  expect(report.failures).toEqual([])
  expect(warningCodes(report)).toContain('timing_plan_exceeds_duration')
  expect(report.shots[0]?.duration_seconds).toBe(4)
})

it.each(['validate', 'preview', 'compile'] as const)('reports content issues without blocking %s or altering speech and duration', async (method) => {
  const f = await fixture()
  await writeFile(join(f.root, 'project_config.json'), JSON.stringify({ delivery: { max_effective_chars_per_shot: 3 } }))
  const report = await f.tool.report({ ...f.args, method })
  expect(report).toMatchObject({ ok: true, review_mode: 'advisory', failures: [] })
  expect(report.warnings.length).toBeGreaterThan(0)
  expect(report.warnings.every(issue => issue.severity === 'warning')).toBe(true)
  expect(report.shots[0]).toMatchObject({ speaker: '苏晚', text: '等一下……我想把这句话说完。', duration_seconds: 20 })
  expect(await readFile(f.script, 'utf8')).toBe(f.original)
  if (method === 'validate') {
    expect(report.packages).toEqual([])
    expect(report.written).toEqual([])
  } else {
    expect(warningCodes(report)).toContain('shot_exceeds_package_budget')
    expect(report.packages).toHaveLength(1)
    expect(report.packages[0]).toMatchObject({ shots: [1], content_seconds: 20, submit_seconds: 21 })
  }
  if (method === 'preview') expect(report.written).toEqual([])
})

it('writes only a review draft and leaves formal prompts, matches and episode packages byte-for-byte unchanged', async () => {
  const f = await fixture()
  const formal = ['prompts/01.txt', 'matches/01.matched.json', 'episode_packages/01/manifest.json']
  for (const name of formal) {
    const path = join(f.root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `existing formal artifact: ${name}\n`)
  }
  const before = await Promise.all(formal.map(name => readFile(join(f.root, name))))
  const report = await f.tool.report({ ...f.args, method: 'compile' })
  expect(report.written.slice().sort()).toEqual([
    join(f.root, 'shot_reviews/01/review.json'), join(f.root, 'shot_reviews/01/shot_script.txt'),
  ])
  expect(await readFile(join(f.root, 'shot_reviews/01/shot_script.txt'), 'utf8')).toBe(f.original)
  const saved: unknown = JSON.parse(await readFile(join(f.root, 'shot_reviews/01/review.json'), 'utf8'))
  expect(saved).toMatchObject({ review_mode: 'advisory', ok: true, failures: [],
    shots: [{ text: '等一下……我想把这句话说完。', duration_seconds: 20 }] })
  expect(await Promise.all(formal.map(name => readFile(join(f.root, name))))).toEqual(before)
  expect((await readdir(join(f.root, 'shot_reviews/01'))).sort()).toEqual(['review.json', 'shot_script.txt'])
})

it('warns about ambiguous identity without choosing either same-title character or inventing remote identifiers', async () => {
  const f = await fixture({ script: speakingShot(1, '王总：等一下', ['出镜人物：王总', '核心场景：后厨']).replaceAll('苏晚', '王总'), assets: [
    assetRow('王明', '角色', { aliases: ['王总'], jubian_asset_id: '71001' }),
    assetRow('王强', '角色', { aliases: ['王总'], jubian_asset_id: '71002' }), assetRow('后厨', '场景'),
  ] })
  const report = await f.tool.report({ ...f.args, method: 'preview' })
  expect(report.ok).toBe(true)
  expect(warningCodes(report)).toContain('asset_binding_ambiguous')
  expect(report.shots[0]?.bindings.filter(asset => asset.type === '角色')).toEqual([])
  expect(report.packages.flatMap(pkg => pkg.material_bindings).some(asset => ['71001', '71002'].includes(asset.asset_id))).toBe(false)
  expect(await readFile(f.script, 'utf8')).toBe(f.original)
})

it('keeps missing assets and local images as warnings without adding assets or generating replacements', async () => {
  const f = await fixture({ script: speakingShot(1, '苏晚：把奶瓶给我', [
    '出镜人物：苏晚、孩子', '核心场景：后厨', '关键道具：奶瓶',
  ]), assets: [assetRow('苏晚', '角色', { image_path: 'missing-portrait.png' }), assetRow('后厨', '场景')] })
  const manifestBefore = await readFile(f.assets)
  const report = await f.tool.report({ ...f.args, method: 'compile' })
  expect(report.ok).toBe(true)
  expect(report.failures).toEqual([])
  expect(report.warnings.length).toBeGreaterThan(0)
  expect(report.shots[0]?.bindings.map(asset => asset.name)).not.toContain('孩子')
  expect(report.packages.flatMap(pkg => pkg.material_names)).not.toContain('奶瓶')
  expect(await readFile(f.assets)).toEqual(manifestBefore)
  expect((await readdir(f.root)).some(name => /\.png$|\.jpg$|\.webp$/u.test(name))).toBe(false)
  expect(report.written.every(path => path.startsWith(join(f.root, 'shot_reviews/01/')))).toBe(true)
})

it('keeps unstructured authored text intact in a review draft rather than requiring a numbered-shot rewrite', async () => {
  const f = await fixture({ script: '苏晚停在门口，轻声说：“我等你回来。”\n停留，让情绪自然收束。\n' })
  const report = await f.tool.report({ ...f.args, method: 'compile' })
  expect(report).toMatchObject({ ok: true, review_mode: 'advisory', failures: [] })
  expect(warningCodes(report)).toContain('no_shots')
  expect(await readFile(join(f.root, 'shot_reviews/01/shot_script.txt'), 'utf8')).toBe(f.original)
})

it('preserves every authored speech line and warns that first-line metadata is not a complete subtitle transcript', async () => {
  const f = await fixture({ script: speakingShot(1, '苏晚：我等你回来。', [
    '台词：苏晚：这一次，我不走了。', '核心场景：后厨', '出镜人物：苏晚',
  ]) })
  const report = await f.tool.report({ ...f.args, method: 'compile' })
  expect(report.ok).toBe(true)
  expect(report.shots[0]?.text).toBe('我等你回来。')
  expect(report.warnings.find(issue => issue.code === 'multiple_speech_lines')?.message).toContain('字幕')
  expect(report.packages[0]?.prompt).toContain('这一次，我不走了。')
  expect(await readFile(join(f.root, 'shot_reviews/01/shot_script.txt'), 'utf8')).toBe(f.original)
})

it('retains strict mode failure behavior for the same content and does not create a review directory', async () => {
  const f = await fixture({ reviewMode: 'strict' })
  const report = await f.tool.report({ ...f.args, method: 'compile' })
  expect(report).toMatchObject({ ok: false, review_mode: 'strict', written: [] })
  expect(report.failures.map(issue => issue.code)).toContain('shot_exceeds_package_budget')
  expect(await readdir(f.root)).not.toContain('shot_reviews')
})

it('keeps required arguments, file reads, JSON parsing and draft write failures in the tool error path', async () => {
  const f = await fixture()
  for (const args of [
    { method: 'validate' }, { method: 'preview', script: f.script },
    { ...f.args, method: 'compile', episode: 0 }, { ...f.args, method: 'preview', max_submit_seconds: 0 },
    { ...f.args, method: 'validate', script: join(f.root, 'missing.txt') },
  ]) expect((await f.tool.execute(args)).isError).toBe(true)
  await writeFile(join(f.root, 'project_config.json'), JSON.stringify({ delivery: { max_effective_chars_per_shot: 0 } }))
  expect((await f.tool.execute({ ...f.args, method: 'preview' })).isError).toBe(true)
  await writeFile(join(f.root, 'project_config.json'), '{}')
  await writeFile(f.assets, '{invalid JSON')
  expect((await f.tool.execute({ ...f.args, method: 'preview' })).isError).toBe(true)
  await writeFile(f.assets, JSON.stringify(manifestDocument(assetRow('苏晚', '角色'), assetRow('后厨', '场景'))))
  await writeFile(join(f.root, 'shot_reviews'), 'existing file blocks draft directory creation\n')
  expect((await f.tool.execute({ ...f.args, method: 'compile' })).isError).toBe(true)
  expect(await readFile(join(f.root, 'shot_reviews'), 'utf8')).toBe('existing file blocks draft directory creation\n')
  expect(await readFile(f.script, 'utf8')).toBe(f.original)
})

it('removes the advisory tool when its Loader owner is disposed', async () => {
  const f = await fixture()
  const registry = f.tool.registry
  expect(registry.get('drama_shot')).toBeDefined()
  await f.tool.dispose()
  expect(registry.get('drama_shot')).toBeUndefined()
})
