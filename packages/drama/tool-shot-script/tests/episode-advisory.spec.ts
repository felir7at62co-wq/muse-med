import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packEpisode, writeAdvisoryReview } from '../src/episode.ts'
import { buildReport } from '../src/report.ts'
import type { BoundAsset, CompiledShot, ShotIssue } from '../src/types.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** One explicit authored shot without automatic prompt completion. */
function shot(number: number, visual: string, assets: BoundAsset[] = [], seconds = 5): CompiledShot {
  return { shot: { shot: number, line: number * 3, voiceType: 'dialogue', speaker: '苏晚', text: '原文第一句。',
    effectiveChars: 5, durationSeconds: seconds, durationSource: 'declared', offscreen: false,
    charactersField: '苏晚', sceneField: '庭院', propsField: '', visual, directorFormat: true,
    breakAfter: false, bodyStates: new Map() },
  characters: assets.map(asset => asset.name), scene: '庭院', props: [], assets, start: 0, end: seconds }
}

/** A declared complete asset; overrides deliberately model incomplete registrations. */
function asset(name: string, overrides: Partial<BoundAsset> = {}): BoundAsset {
  return { name, id: name, type: '角色', official: true, assetId: name, materialId: `material-${name}`,
    url: `https://example.test/${name}.png`, localPath: '', ...overrides }
}

/** Isolated review project with no required delivery files. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shot-review-'))
  directories.push(root)
  return root
}

/** One report supplied to the draft writer; formal compilation is not invoked. */
function report(script: string) {
  return buildReport({ method: 'compile', reviewMode: 'advisory', script, assetsManifest: '', assetsChecked: false,
    shots: [], issues: [], tasks: [], written: [] })
}

describe('advisory episode packaging', () => {
  it('keeps all raw speech, selected duration and shot order while isolating an oversized complete shot', () => {
    const visual = '【镜头7】\n时长：35秒\n台词：苏晚：原文第一句。\n台词：陆沉舟：原文第二句。'
    const authored = shot(7, visual, [], 35)
    const issues: ShotIssue[] = []
    const tasks = packEpisode([shot(6, '前镜'), authored, shot(8, '后镜')], 14, { reviewMode: 'advisory', issues })
    expect(tasks.map(task => task.shots)).toEqual([[6], [7], [8]])
    expect(tasks[1]).toMatchObject({ contentSeconds: 35, submitSeconds: 36, prompt: visual })
    expect(authored.shot.text).toBe('原文第一句。')
    expect(authored.shot.durationSeconds).toBe(35)
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'shot_exceeds_package_budget', shot: 7, line: 21 }))
    expect(() => packEpisode([authored], 14)).toThrow('超过内容预算')
  })

  it('retains incomplete and unconfirmed references as text without fabricating generation bindings', () => {
    const visual = '@[苏晚](lead) 看向 @[陆沉舟](other)，拿起 @[信封](prop)。'
    const issues: ShotIssue[] = []
    const tasks = packEpisode([shot(2, visual, [asset('苏晚'), asset('陆沉舟', { official: false }), asset('信封', { materialId: '' })])], 14,
      { reviewMode: 'advisory', issues })
    expect(tasks[0]?.prompt).toBe(visual)
    expect(tasks[0]?.materialKeys).toEqual(['lead'])
    expect(tasks[0]?.materialBindings).toEqual([expect.objectContaining({ material_key: 'lead', asset_id: '苏晚', material_id: 'material-苏晚' })])
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', code: 'unconfirmed_asset', shot: 2 }),
      expect.objectContaining({ severity: 'warning', code: 'incomplete_asset', shot: 2 }),
    ]))
    expect(() => packEpisode([shot(2, visual, [asset('陆沉舟', { official: false })])], 14)).toThrow('未确认出演')
  })

  it('omits every disputed key instead of silently choosing its latest asset', () => {
    const issues: ShotIssue[] = []
    const tasks = packEpisode([shot(1, '@[苏晚](shared)', [asset('苏晚')], 10), shot(2, '@[陆沉舟](shared)', [asset('陆沉舟')], 10)], 14,
      { reviewMode: 'advisory', issues })
    expect(tasks.map(task => task.prompt)).toEqual(['@[苏晚](shared)', '@[陆沉舟](shared)'])
    expect(tasks.flatMap(task => task.materialBindings)).toEqual([])
    expect(tasks.flatMap(task => task.materialKeys)).toEqual([])
    expect(issues).toContainEqual(expect.objectContaining({ code: 'material_reference_mismatch', shot: 2 }))
  })

  it('omits a conflicting parent identity under every key', () => {
    const tasks = packEpisode([shot(1, '@[苏晚](first)', [asset('苏晚', { assetId: 'same' })]),
      shot(2, '@[苏晚](second)', [asset('苏晚', { assetId: 'same', materialId: 'different-version' })])], 14, { reviewMode: 'advisory' })
    expect(tasks.flatMap(task => task.materialBindings)).toEqual([])
  })

  it('does not add assets, cast limits or replacement references to an authored prompt', () => {
    const visual = '@[未知角色](missing) 走进庭院。'
    const issues: ShotIssue[] = []
    const tasks = packEpisode([shot(4, visual, [asset('苏晚')])], 14, { reviewMode: 'advisory', issues })
    expect(tasks[0]?.prompt).toBe(visual)
    expect(tasks[0]?.materialBindings).toEqual([])
    expect(issues.every(issue => issue.shot === 4 && issue.line === 12)).toBe(true)
    expect(issues.some(issue => issue.message.includes('未知角色'))).toBe(true)
    expect(issues.some(issue => issue.message.includes('苏晚'))).toBe(true)
  })

  it('still rejects an unusable numeric package budget', () => {
    expect(() => packEpisode([], 0, { reviewMode: 'advisory' })).toThrow('内容预算至少为')
    expect(() => packEpisode([], Number.NaN, { reviewMode: 'advisory' })).toThrow('内容预算至少为')
  })
})

describe('writing a separate advisory review', () => {
  it('copies exact source bytes and writes only a review without episode text or local asset images', async () => {
    const root = await project()
    const script = join(root, 'original.txt')
    const bytes = Buffer.from('\uFEFF【镜头1】\r\n台词：苏晚：第一句。\r\n台词：陆沉舟：第二句。\r\n')
    await writeFile(script, bytes)
    const sentinels = ['prompts/01.txt', 'matches/01.matched.json', 'episode_packages/01/package.json']
    for (const path of sentinels) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), `formal:${path}`)
    }
    const written = await writeAdvisoryReview({ project: root, episode: '01', scriptPath: script, report: report(script) })
    expect(written).toEqual([join(root, 'shot_reviews', '01', 'shot_script.txt'), join(root, 'shot_reviews', '01', 'review.json')])
    expect(await readFile(written[0] ?? '')).toEqual(bytes)
    expect(JSON.parse(await readFile(written[1] ?? '', 'utf8'))).toMatchObject({ written })
    for (const path of sentinels) expect(await readFile(join(root, path), 'utf8')).toBe(`formal:${path}`)
  })

  it('keeps missing source files and unsafe destinations as actual errors', async () => {
    const root = await project()
    const missing = join(root, 'missing.txt')
    await expect(writeAdvisoryReview({ project: root, episode: '01', scriptPath: missing, report: report(missing) })).rejects.toThrow()
    const script = join(root, 'source.txt')
    await writeFile(script, 'original')
    await expect(writeAdvisoryReview({ project: root, episode: '../formal', scriptPath: script, report: report(script) })).rejects.toThrow('shot_reviews')
    await writeFile(join(root, 'shot_reviews'), 'directory blocked by a file')
    await expect(writeAdvisoryReview({ project: root, episode: '01', scriptPath: script, report: report(script) })).rejects.toThrow('文件类型')
  })

  it('does not follow an existing review-directory link outside the project', async (context) => {
    const root = await project()
    const outside = await project()
    const script = join(root, 'source.txt')
    await writeFile(script, 'original')
    await writeFile(join(outside, 'shot_script.txt'), 'private sentinel')
    try {
      await symlink(outside, join(root, 'shot_reviews'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (process.platform === 'win32' && error instanceof Error && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) {
        context.skip('Creating a directory link requires Windows symlink permission')
        return
      }
      throw error
    }
    await expect(writeAdvisoryReview({ project: root, episode: '01', scriptPath: script, report: report(script) })).rejects.toThrow('符号链接')
    expect(await readFile(join(outside, 'shot_script.txt'), 'utf8')).toBe('private sentinel')
  })
})
