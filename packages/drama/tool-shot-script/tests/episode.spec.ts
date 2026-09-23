import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindShot, parseAssetManifest } from '../src/assets.ts'
import {
  buildMatchedPayload,
  HOLD_INSTRUCTION,
  materialKeys,
  MATCHED_VERSION,
  MIN_CONTENT_SECONDS,
  NATURAL_HOLD_SECONDS,
  packEpisode,
  writeEpisode,
} from '../src/episode.ts'
import { parseShotScript } from '../src/script.ts'
import type { CompiledShot } from '../src/types.ts'
import { actionShot, assetRow, cleanup, manifestDocument, scriptOf, speakingShot, tempDir } from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  for (const dir of temporary.splice(0)) await cleanup(dir)
})

/** Compile one script and its manifest into the shots the packer consumes. */
function fixture(blocks: readonly string[], rows: readonly Record<string, unknown>[]): CompiledShot[] {
  const parsed = parseShotScript(scriptOf(...blocks), { actionShotSeconds: 2 })
  const assets = parseAssetManifest(manifestDocument(...rows), 'manifest.json')
  let cursor = 0
  return parsed.shots.map((shot) => {
    const binding = bindShot(shot, assets)
    const compiled: CompiledShot = {
      shot,
      characters: binding.characters,
      scene: binding.scene,
      props: binding.props,
      assets: binding.assets,
      start: cursor,
      end: cursor + shot.durationSeconds,
    }
    cursor += shot.durationSeconds
    return compiled
  })
}

/** The default manifest: one character, one scene, one prop, all official. */
const DEFAULT_ASSETS = [assetRow('苏晚', '角色'), assetRow('后厨', '场景'), assetRow('客厅', '场景'), assetRow('奶瓶', '道具')]

/** Create one temporary project with its episode text already split. */
async function project(episode = '01'): Promise<string> {
  const root = await tempDir()
  temporary.push(root)
  await mkdir(join(root, 'episodes'), { recursive: true })
  await writeFile(join(root, 'episodes', `${episode}.txt`), '第一集正文', 'utf8')
  return root
}

describe('material keys', () => {
  it('keeps first-appearance order and drops repeats', () => {
    expect(materialKeys('雨夜街头 @[陆沉舟](lead) 与 @[苏晚](guest)，@[陆沉舟](lead) 回头。'))
      .toEqual(['lead', 'guest'])
  })

  it('returns nothing when the prompt carries no placeholder', () => {
    expect(materialKeys('真人短剧写实风格\n【镜头1】')).toEqual([])
  })
})

describe('packing an episode', () => {
  it('never emits an indivisible shot above the explicit content bound', () => {
    const shots = fixture([actionShot(1, ['时长：20秒'])], DEFAULT_ASSETS)
    expect(() => packEpisode(shots, 14)).toThrow('20')
    expect(packEpisode(shots, 29)[0]).toMatchObject({ contentSeconds: 20, submitSeconds: 21 })
  })
  it('keeps continuous same-scene shots in one package and adds the natural hold', () => {
    const shots = fixture(
      [speakingShot(1, '苏晚：原文台词', ['核心场景：后厨']), speakingShot(2, '苏晚：第二句台词', ['核心场景：后厨'])],
      DEFAULT_ASSETS,
    )
    const tasks = packEpisode(shots, 14)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      index: 1,
      shots: [1, 2],
      contentSeconds: 2,
      submitSeconds: 2 + NATURAL_HOLD_SECONDS,
      materialKeys: [],
      materialNames: ['苏晚', '后厨'],
    })
  })

  it('closes a package when the scene changes', () => {
    const shots = fixture(
      [speakingShot(1, '苏晚：原文台词', ['核心场景：后厨']), speakingShot(2, '苏晚：第二句台词', ['核心场景：客厅'])],
      DEFAULT_ASSETS,
    )
    expect(packEpisode(shots, 14).map(task => task.shots)).toEqual([[1], [2]])
  })

  it('keeps a shot with no declared scene in the package it arrived in', () => {
    // The alternating shape that broke an episode: every other shot binds the same
    // scene, the rest bind none. A missing binding is not a scene of its own, so
    // the four shots stay one package.
    const shots = fixture([
      speakingShot(1, '苏晚：原文台词'),
      speakingShot(2, '苏晚：第二句台词', ['核心场景：后厨']),
      speakingShot(3, '苏晚：第三句台词'),
      speakingShot(4, '苏晚：第四句台词', ['核心场景：后厨']),
    ], DEFAULT_ASSETS).map((item, index) => index % 2 === 0 ? { ...item, scene: '' } : item)
    expect(shots.map(item => item.scene)).toEqual(['', '后厨', '', '后厨'])
    expect(packEpisode(shots, 14).map(task => task.shots)).toEqual([[1, 2, 3, 4]])
  })

  it('still closes a package when a declared scene replaces another', () => {
    const shots = fixture([
      speakingShot(1, '苏晚：原文台词'),
      speakingShot(2, '苏晚：第二句台词', ['核心场景：后厨']),
      speakingShot(3, '苏晚：第三句台词', ['核心场景：客厅']),
    ], DEFAULT_ASSETS).map((item, index) => index === 0 ? { ...item, scene: '' } : item)
    expect(shots.map(item => item.scene)).toEqual(['', '后厨', '客厅'])
    // The undeclared shot rides along with the first declared scene; the declared
    // change after it still closes the package.
    expect(packEpisode(shots, 14).map(task => task.shots)).toEqual([[1, 2], [3]])
  })

  it('splits a long run evenly instead of leaving a short tail', () => {
    const shots = fixture([
      actionShot(1, ['核心场景：后厨', '动作复杂度：复杂']),
      actionShot(2, ['核心场景：后厨', '动作复杂度：复杂']),
      actionShot(3, ['核心场景：后厨', '动作复杂度：复杂']),
      actionShot(4, ['核心场景：后厨', '动作复杂度：复杂']),
    ], DEFAULT_ASSETS)
    // Sixteen seconds over a fourteen-second ceiling is two packages either way;
    // filling greedily would leave 12+4, and that four-second tail sits exactly on
    // the provider floor. The split is 8+8 instead.
    const tasks = packEpisode(shots, 14)
    expect(tasks.map(task => task.contentSeconds)).toEqual([8, 8])
    expect(tasks.map(task => task.shots)).toEqual([[1, 2], [3, 4]])
  })

  it('explores cuts that leave a suffix too long for the packs that remain', () => {
    const shots = fixture([
      actionShot(1, ['核心场景：后厨', '动作复杂度：复杂']),
      actionShot(2, ['核心场景：后厨', '动作复杂度：复杂']),
      actionShot(3, ['核心场景：后厨', '动作复杂度：复杂']),
      actionShot(4, ['核心场景：后厨', '动作复杂度：复杂']),
      actionShot(5, ['核心场景：后厨', '动作复杂度：复杂']),
    ], DEFAULT_ASSETS)
    // Twenty seconds over a fourteen-second ceiling is two packages. Cutting after
    // the first shot would leave sixteen seconds for one package, which does not
    // fit, so that candidate is dropped and 8+12 wins.
    const tasks = packEpisode(shots, 14)
    expect(tasks.map(task => task.contentSeconds)).toEqual([8, 12])
    expect(tasks.map(task => task.shots)).toEqual([[1, 2], [3, 4, 5]])
  })

  it('leaves the smallest request the provider accepts exactly at the floor', () => {
    // The provider rejects a request below four seconds, and every package spends
    // NATURAL_HOLD_SECONDS of that request on closure, so three seconds of content
    // is the floor itself rather than below it.
    const shots = fixture(
      [speakingShot(1, '苏晚：短', ['核心场景：后厨']), actionShot(2, ['核心场景：后厨'])],
      DEFAULT_ASSETS,
    )
    const tasks = packEpisode(shots, 14)
    expect(tasks.map(task => [task.contentSeconds, task.submitSeconds])).toEqual([[3, 4]])
    expect(tasks[0]!.contentSeconds).toBeGreaterThanOrEqual(MIN_CONTENT_SECONDS)
  })

  it('returns a package below the provider floor for the caller to hint at', () => {
    // One short shot alone in its scene cannot be merged anywhere; the packer still
    // reports it, and `drama_shot` turns it into a `package_below_minimum` hint
    // rather than refusing a run whose request the provider would reject.
    const shots = fixture([speakingShot(1, '苏晚：短', ['核心场景：后厨'])], DEFAULT_ASSETS)
    const tasks = packEpisode(shots, 14)
    expect(tasks.map(task => task.contentSeconds)).toEqual([1])
    expect(tasks[0]!.contentSeconds).toBeLessThan(MIN_CONTENT_SECONDS)
  })

  it('closes a package after a shot that declares the task boundary', () => {
    const shots = fixture(
      [speakingShot(1, '苏晚：原文台词', ['核心场景：后厨', '子任务边界：是']),
        speakingShot(2, '苏晚：第二句台词', ['核心场景：后厨'])],
      DEFAULT_ASSETS,
    )
    expect(packEpisode(shots, 14).map(task => task.shots)).toEqual([[1], [2]])
  })

  it('reads each package material keys out of its own shots in script order', () => {
    const shots = fixture(
      [speakingShot(1, '苏晚：@[苏晚](lead) 你站住', ['核心场景：后厨']),
        speakingShot(2, '苏晚：@[苏晚](lead) 又是 @[奶瓶](prop)', ['核心场景：后厨'])],
      DEFAULT_ASSETS,
    )
    expect(packEpisode(shots, 14)[0]?.materialKeys).toEqual(['lead', 'prop'])
  })

  it('plans no package for an episode with no shots', () => {
    expect(packEpisode([], 14)).toEqual([])
  })
})

describe('the matched payload', () => {
  it('records the timeline, every shot field, and one video task per package', () => {
    const shots = fixture([
      speakingShot(1, '苏晚：@[苏晚](lead) 站住', ['核心场景：后厨', '关键道具：奶瓶', '出镜人物：苏晚']),
      actionShot(2, ['核心场景：后厨', '动作复杂度：复杂']),
    ], [...DEFAULT_ASSETS, assetRow('奶瓶', '道具', { image_path: 'assets/props/bottle.png' })])
    const tasks = packEpisode(shots, 14)
    const payload = buildMatchedPayload({ episode: '03', promptFile: 'C:/p/03.txt', shots, tasks })
    expect(payload.version).toBe(MATCHED_VERSION)
    expect(payload).toMatchObject({
      episode: '03',
      production_mode: 'live_action',
      prompt_file: 'C:/p/03.txt',
      timeline_file: null,
      timing_source: 'integer_shot_script',
    })
    expect(payload.shots[0]).toMatchObject({
      shot: 1,
      segment: 1,
      start: 0,
      end: 1,
      duration: 1,
      script_duration: 1,
      voice_type: 'dialogue',
      speaker: '苏晚',
      characters: ['苏晚'],
      scene: '后厨',
      props: ['奶瓶'],
      task_break_after: false,
      director_format: true,
    })
    expect(payload.shots[0]?.assets.map(asset => asset.name)).toEqual(['苏晚', '后厨', '奶瓶'])
    expect(payload.shots[0]?.assets.find(asset => asset.name === '奶瓶')?.image_path)
      .toBe('assets/props/bottle.png')
    expect(payload.shots[0]?.assets.find(asset => asset.name === '苏晚')?.image_path)
      .toBe('https://cdn.example.test/asset.png')
    expect(payload.video_tasks).toEqual([
      { shots: [1, 2], content_duration: 5, natural_hold_duration: 1, requested_duration: 6,
        hold_instruction: HOLD_INSTRUCTION },
    ])
  })
})

describe('writing an episode package', () => {
  /** Compile the default two-shot episode against one project directory. */
  async function writeDefault(root: string, options: { assets?: Record<string, unknown>[] } = {}):
  Promise<string[]> {
    const scriptPath = join(root, 'source', '01.txt')
    await mkdir(join(root, 'source'), { recursive: true })
    await writeFile(scriptPath, '脚本原文', 'utf8')
    const shots = fixture(
      [speakingShot(1, '苏晚：原文台词', ['核心场景：后厨', '关键道具：奶瓶', '出镜人物：苏晚']),
        actionShot(2, ['核心场景：后厨'])],
      options.assets ?? [...DEFAULT_ASSETS, assetRow('奶瓶', '道具')],
    )
    const tasks = packEpisode(shots, 14)
    return await writeEpisode({
      project: root,
      episode: '01',
      scriptPath,
      promptPath: join(root, 'prompts', '01.txt'),
      matchedPath: join(root, 'matches', '01.matched.json'),
      payload: buildMatchedPayload({
        episode: '01',
        promptFile: join(root, 'prompts', '01.txt'),
        shots,
        tasks,
      }),
      shots,
    })
  }

  it('writes the prompt, the matched JSON, and a self-contained package', async () => {
    const root = await project()
    const written = await writeDefault(root)
    const packageDir = join(root, 'episode_packages', '01')
    expect(written).toEqual([
      join(root, 'prompts', '01.txt'),
      join(root, 'matches', '01.matched.json'),
      join(packageDir, 'package.json'),
      join(packageDir, 'shot_script.txt'),
      join(packageDir, 'matched.json'),
      join(packageDir, 'episode.txt'),
    ])
    expect(await readFile(join(packageDir, 'shot_script.txt'), 'utf8')).toBe('脚本原文')
    expect(await readFile(join(packageDir, 'episode.txt'), 'utf8')).toBe('第一集正文')
    expect(JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')))
      .toEqual(JSON.parse(await readFile(join(root, 'matches', '01.matched.json'), 'utf8')))
  })

  it('leaves the prompt file alone when the script already is the prompt', async () => {
    const root = await project()
    const shots = fixture([speakingShot(1, '苏晚：原文台词', ['核心场景：后厨'])], DEFAULT_ASSETS)
    const promptPath = join(root, 'prompts', '01.txt')
    await mkdir(join(root, 'prompts'), { recursive: true })
    await writeFile(promptPath, '脚本原文', 'utf8')
    const written = await writeEpisode({
      project: root,
      episode: '01',
      scriptPath: promptPath,
      promptPath,
      matchedPath: join(root, 'matches', '01.matched.json'),
      payload: buildMatchedPayload({ episode: '01', promptFile: promptPath, shots, tasks: [] }),
      shots,
    })
    expect(written).not.toContain(promptPath)
    expect(await readFile(promptPath, 'utf8')).toBe('脚本原文')
  })

  it('copies a local asset image once per asset and skips remote references', async () => {
    const root = await project()
    await mkdir(join(root, 'assets', 'roles'), { recursive: true })
    await writeFile(join(root, 'assets', 'roles', 'su.png'), 'png', 'utf8')
    const written = await writeDefault(root, {
      assets: [
        assetRow('苏晚', '角色', { image_path: 'assets/roles/su.png' }),
        assetRow('后厨', '场景', { image_path: 'https://cdn.example.test/kitchen.png' }),
        assetRow('奶瓶', '道具', { image_path: '' }),
      ],
    })
    expect(written).toEqual([
      join(root, 'prompts', '01.txt'),
      join(root, 'matches', '01.matched.json'),
      join(root, 'episode_packages', '01', 'package.json'),
      join(root, 'episode_packages', '01', 'shot_script.txt'),
      join(root, 'episode_packages', '01', 'matched.json'),
      join(root, 'episode_packages', '01', 'episode.txt'),
      join(root, 'episode_packages', '01', 'assets', '角色', 'su.png'),
    ])
    expect(await readFile(join(root, 'episode_packages', '01', 'assets', '角色', 'su.png'), 'utf8')).toBe('png')
  })

  it('copies an asset that the manifest points at with an absolute path', async () => {
    const root = await project()
    const source = join(root, 'outside', 'su.png')
    await mkdir(join(root, 'outside'), { recursive: true })
    await writeFile(source, 'png', 'utf8')
    await writeDefault(root, {
      assets: [assetRow('苏晚', '角色', { image_path: source }), assetRow('后厨', '场景')],
    })
    expect(await readFile(join(root, 'episode_packages', '01', 'assets', '角色', 'su.png'), 'utf8')).toBe('png')
  })

  it('refuses to write anything when the episode text is missing', async () => {
    const root = await tempDir()
    temporary.push(root)
    await expect(writeDefault(root)).rejects.toThrow('项目缺少分集正文')
  })

  it('refuses to write anything when a local asset image is missing', async () => {
    const root = await project()
    await expect(writeDefault(root, {
      assets: [assetRow('苏晚', '角色', { image_path: 'assets/roles/missing.png' }), assetRow('后厨', '场景')],
    })).rejects.toThrow('本地图片不存在')
  })
})
