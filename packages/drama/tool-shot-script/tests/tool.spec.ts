import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { Config, inject, name } from '../src/index.ts'
import type { DramaShotReport } from '../src/types.ts'
import { actionShot, assetRow, cleanup, dramaShot, manifestDocument, mount, scriptOf, speakingShot, tempDir } from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  for (const dir of temporary.splice(0)) await cleanup(dir)
})

/** One temporary project carrying a script, its manifest, and the episode text. */
async function project(options: { script?: string; assets?: Record<string, unknown>[]; episodeText?: string } = {}):
Promise<{ root: string; scriptPath: string; manifestPath: string }> {
  const root = await tempDir()
  temporary.push(root)
  await mkdir(join(root, 'episodes'), { recursive: true })
  const scriptPath = join(root, 'source-01.txt')
  const manifestPath = join(root, 'assets_manifest.json')
  await writeFile(scriptPath, options.script ?? scriptOf(
    speakingShot(1, '苏晚：@[苏晚](lead) 站住', ['核心场景：后厨', '关键道具：奶瓶', '出镜人物：苏晚']),
    actionShot(2, ['核心场景：后厨']),
  ), 'utf8')
  await writeFile(manifestPath, JSON.stringify(options.assets === undefined
    ? manifestDocument(assetRow('苏晚', '角色'), assetRow('后厨', '场景'), assetRow('奶瓶', '道具'))
    : { assets: options.assets }), 'utf8')
  await writeFile(join(root, 'episodes', '01.txt'), options.episodeText ?? '第一集正文', 'utf8')
  return { root, scriptPath, manifestPath }
}

/** Run one call and assert its value satisfies the tool's own output schema. */
async function run(args: Record<string, unknown>): Promise<DramaShotReport> {
  const tool = dramaShot()
  const value = await tool.execute(args, {})
  const violations = validateJsonSchemaValue(tool.output.schema, value, '')
  expect(violations).toEqual([])
  return value as DramaShotReport
}

describe('registration', () => {
  it('declares its identity and the registry it needs', () => {
    expect(name).toBe('tool-shot-script')
    expect(inject).toEqual(['tools'])
  })

  it('registers exactly the drama_shot tool with the rules the model must know', () => {
    const tool = dramaShot()
    expect(tool.name).toBe('drama_shot')
    for (const phrase of ['9 有效字/秒', '36 有效字', '发声类型：action', '动作复杂度', '台词：无',
      '出镜人物：无', '画外音', 'official=true', '14 秒']) {
      expect(tool.description).toContain(phrase)
    }
  })

  it('exposes the method enum and the four path arguments', () => {
    const parameters = dramaShot().parameters as {
      properties: Record<string, { enum?: string[] }>
      required: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual(['assets', 'episode', 'method', 'project', 'script'])
    expect(parameters.properties.method?.enum).toEqual(['validate', 'preview', 'compile'])
    expect(parameters.required.sort()).toEqual(['method', 'script'])
  })

  it('renders the canonical value as pretty JSON', () => {
    const blocks = dramaShot().output.render({}, { ok: true }) as { type: string; text: string }[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toBe('{\n  "ok": true\n}')
  })

  it('defaults the silent-shot budget to two seconds and rejects anything outside 1–4', () => {
    expect(Config({})).toMatchObject({ actionShotSeconds: 2 })
    expect(Config({ actionShotSeconds: 4 })).toMatchObject({ actionShotSeconds: 4 })
    expect(() => Config({ actionShotSeconds: 0 })).toThrow()
    expect(() => Config({ actionShotSeconds: 5 })).toThrow()
    expect(() => Config({ actionShotSeconds: 2.5 })).toThrow()
  })

  it('refuses arguments the schema does not allow', async () => {
    await expect(dramaShot().execute({ method: 'bogus', script: 'x' }, {})).rejects.toThrow()
    await expect(dramaShot().execute({ method: 'validate' }, {})).rejects.toThrow()
  })
})

describe('validate', () => {
  it('reports every shot without touching the manifest or the filesystem', async () => {
    const files = await project()
    const report = await run({ method: 'validate', script: files.scriptPath })
    expect(report).toMatchObject({
      method: 'validate',
      ok: true,
      assets_manifest: '',
      assets_checked: false,
      packages: [],
      failures: [],
      warnings: [],
      written: [],
      summary: { shots: 2, packages: 0, content_seconds: 0, failures: 0, warnings: 0 },
    })
    expect(report.shots.map(shot => shot.shot)).toEqual([1, 2])
    expect(report.shots[0]).toMatchObject({
      voice_type: 'dialogue',
      speaker: '苏晚',
      effective_chars: 8,
      duration_seconds: 1,
      duration_source: 'speech',
      scene: '',
      bindings: [],
    })
    expect(report.shots[1]).toMatchObject({ voice_type: 'action', duration_seconds: 2, duration_source: 'default' })
  })

  it('judges asset binding when the manifest is supplied', async () => {
    const files = await project()
    const report = await run({ method: 'validate', script: files.scriptPath, assets: files.manifestPath })
    expect(report.assets_checked).toBe(true)
    expect(report.assets_manifest).toBe(files.manifestPath)
    expect(report.shots[0]?.bindings.map(binding => binding.name)).toEqual(['苏晚', '后厨', '奶瓶'])
    expect(report.shots[0]?.scene).toBe('后厨')
  })

  it('separates hard failures from warnings', async () => {
    const files = await project({
      script: scriptOf(speakingShot(1, '苏晚：'), speakingShot(2, `苏晚：${'字'.repeat(16)}`, ['核心场景：后厨'])),
      assets: [assetRow('苏晚', '角色'), assetRow('后厨', '场景')],
    })
    const report = await run({ method: 'validate', script: files.scriptPath, assets: files.manifestPath })
    expect(report.ok).toBe(false)
    expect(report.failures.map(issue => issue.code)).toEqual(['empty_dialogue_line'])
    expect(report.warnings.map(issue => issue.code)).toEqual(['speech_above_writing_threshold'])
    expect(report.summary).toMatchObject({ failures: 1, warnings: 1 })
  })

  it('reads a script that starts with a byte-order mark', async () => {
    const files = await project({ script: `\ufeff${scriptOf(speakingShot(1, '苏晚：站住', ['核心场景：后厨']))}` })
    const report = await run({ method: 'validate', script: files.scriptPath })
    expect(report.ok).toBe(true)
    expect(report.shots[0]?.line).toBe(2)
  })

  it('fails when the script does not exist', async () => {
    const files = await project()
    await expect(run({ method: 'validate', script: join(files.root, 'nope.txt') })).rejects.toThrow()
  })
})

describe('preview', () => {
  it('plans the packages without writing anything', async () => {
    const files = await project()
    const report = await run({ method: 'preview', script: files.scriptPath, assets: files.manifestPath })
    expect(report.method).toBe('preview')
    expect(report.ok).toBe(true)
    expect(report.written).toEqual([])
    expect(report.packages).toHaveLength(1)
    expect(report.packages[0]).toMatchObject({
      index: 1,
      shots: [1, 2],
      content_seconds: 3,
      content_duration_ms: 3000,
      submit_seconds: 4,
      natural_hold_seconds: 1,
      material_keys: ['lead'],
      material_names: ['苏晚', '后厨', '奶瓶'],
    })
    expect(report.packages[0]?.hold_instruction).toContain('不新增台词')
    expect(report.summary).toMatchObject({ packages: 1, content_seconds: 3 })
  })

  it('requires the asset manifest', async () => {
    const files = await project()
    await expect(run({ method: 'preview', script: files.scriptPath }))
      .rejects.toThrow('drama_shot preview 需要 assets')
  })

  it('returns no packaging plan while a hard failure stands', async () => {
    const files = await project({ script: scriptOf(actionShot(1, ['出镜人物：无'])) })
    const report = await run({ method: 'preview', script: files.scriptPath, assets: files.manifestPath })
    expect(report.ok).toBe(false)
    expect(report.packages).toEqual([])
  })
})

describe('compile', () => {
  it('writes the matched JSON and the episode package', async () => {
    const files = await project()
    const report = await run({ method: 'compile', script: files.scriptPath, assets: files.manifestPath,
      project: files.root, episode: 1 })
    expect(report.ok).toBe(true)
    expect(report.packages).toHaveLength(1)
    expect(report.written).toEqual([
      join(files.root, 'prompts', '01.txt'),
      join(files.root, 'matches', '01.matched.json'),
      join(files.root, 'episode_packages', '01', 'package.json'),
      join(files.root, 'episode_packages', '01', 'shot_script.txt'),
      join(files.root, 'episode_packages', '01', 'matched.json'),
      join(files.root, 'episode_packages', '01', 'episode.txt'),
    ])
    const matched = JSON.parse(await readFile(join(files.root, 'matches', '01.matched.json'), 'utf8')) as
      { episode: string; video_tasks: { content_duration: number }[] }
    expect(matched.episode).toBe('01')
    expect(matched.video_tasks[0]?.content_duration).toBe(3)
    expect(await readFile(join(files.root, 'prompts', '01.txt'), 'utf8')).toContain('真人短剧写实风格')
  })

  it('writes nothing at all while a hard failure stands', async () => {
    const files = await project({ script: scriptOf(actionShot(1, ['出镜人物：无'])) })
    const report = await run({ method: 'compile', script: files.scriptPath, assets: files.manifestPath,
      project: files.root, episode: 1 })
    expect(report.ok).toBe(false)
    expect(report.written).toEqual([])
    expect(report.packages).toEqual([])
  })

  it('requires the project and the episode number', async () => {
    const files = await project()
    await expect(run({ method: 'compile', script: files.scriptPath, assets: files.manifestPath }))
      .rejects.toThrow('需要 project 与 episode')
    await expect(run({ method: 'compile', script: files.scriptPath, assets: files.manifestPath,
      project: files.root, episode: 0 })).rejects.toThrow('必须是正整数集号')
    await expect(run({ method: 'compile', script: files.scriptPath, assets: files.manifestPath,
      project: files.root, episode: -3 })).rejects.toThrow('必须是正整数集号')
    // The parameter schema owns integrality, so a fractional episode never reaches the compiler.
    await expect(run({ method: 'compile', script: files.scriptPath, assets: files.manifestPath,
      project: files.root, episode: 1.5 })).rejects.toThrow()
  })

  it('refuses a manifest that is not JSON', async () => {
    const files = await project()
    const broken = join(files.root, 'broken.json')
    await writeFile(broken, '{ not json', 'utf8')
    await expect(run({ method: 'preview', script: files.scriptPath, assets: broken }))
      .rejects.toThrow('资产清单不是合法 JSON')
  })

  it('refuses a manifest without an assets array', async () => {
    const files = await project()
    const wrong = join(files.root, 'wrong.json')
    await writeFile(wrong, JSON.stringify({ rows: [] }), 'utf8')
    await expect(run({ method: 'preview', script: files.scriptPath, assets: wrong }))
      .rejects.toThrow('缺少 assets 数组')
  })

  it('takes the silent-shot budget from the plugin config', async () => {
    const files = await project({ script: scriptOf(actionShot(1, ['核心场景：后厨'])),
      assets: [assetRow('苏晚', '角色'), assetRow('后厨', '场景')] })
    const tool = mount({ actionShotSeconds: 3 })[0]
    const report = await tool?.execute({ method: 'validate', script: files.scriptPath }, {}) as DramaShotReport
    expect(report.shots[0]).toMatchObject({ duration_seconds: 3, duration_source: 'default' })
  })
})
