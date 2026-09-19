/**
 * Episode packing: the 14-second content budget, the matched JSON, and the files
 * one compiled episode package holds.
 *
 * A package is a run of complete, continuous shots of one scene. The packer
 * never truncates a shot to fill a budget: it closes the current package instead,
 * and every package carries one extra second of natural hold that adds no
 * dialogue.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/episode
 */

import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  CompiledShot,
  MatchedAsset,
  MatchedPayload,
  MatchedShot,
  MatchedVideoTask,
  PackedTask,
} from './types.ts'

/** Content seconds one package may hold; the provider's whole-thousand-millisecond ceiling. */
export const MAX_CONTENT_SECONDS = 14

/** Seconds of natural reaction, breath, or movement closure every package adds. */
export const NATURAL_HOLD_SECONDS = 1

/** The hold instruction the submitted prompt carries; it adds no dialogue. */
export const HOLD_INSTRUCTION = '结尾保持自然反应、呼吸或动作收束，不新增台词'

/** Matched-JSON generation this compiler writes. */
export const MATCHED_VERSION = 4

/** The `@[name](key)` placeholder the prompt binds material keys with. */
const MATERIAL_PLACEHOLDER = /@\[([^\]]+)\]\(([^()\s]+)\)/g

/** A remote asset reference, which the episode package does not copy. */
const REMOTE_REFERENCE = /^https?:\/\//i

/**
 * Read the material key of one successful placeholder match.
 * @param match - A successful match of {@link MATERIAL_PLACEHOLDER}.
 * @returns The captured key.
 */
function placeholderKey(match: RegExpMatchArray): string {
  /* v8 ignore next -- the placeholder pattern always captures the key it matches. */
  return match[2] ?? ''
}

/**
 * Read one prompt's ordered material keys.
 *
 * `select_assets` must receive the keys in exactly this order, so the order is
 * the contract: first appearance in the concatenated shot prompts, duplicates
 * dropped after their first position.
 * @param prompt - One package's prompt text, its shots joined in script order.
 * @returns Distinct placeholder keys in first-appearance order.
 */
export function materialKeys(prompt: string): string[] {
  const keys = new Set<string>()
  for (const match of prompt.matchAll(MATERIAL_PLACEHOLDER)) keys.add(placeholderKey(match))
  return [...keys]
}

/**
 * Pack an episode's shots into the packages one submission each renders.
 *
 * A package closes before a shot that would exceed the content budget, before a
 * shot of another scene, and after a shot marked `子任务边界：是`.
 * @param shots - Compiled shots in script order.
 * @param maxContentSeconds - Content-second ceiling of one package.
 * @returns Packages in submission order.
 */
export function packEpisode(shots: readonly CompiledShot[], maxContentSeconds: number): PackedTask[] {
  const tasks: PackedTask[] = []
  let current: CompiledShot[] = []
  let seconds = 0
  let scene: string | undefined
  const flush = (): void => {
    if (current.length === 0) return
    tasks.push({
      index: tasks.length + 1,
      shots: current.map(item => item.shot.shot),
      contentSeconds: seconds,
      submitSeconds: seconds + NATURAL_HOLD_SECONDS,
      materialKeys: materialKeys(current.map(item => item.shot.visual).join('\n')),
      materialNames: [...new Set(current.flatMap(item => item.assets.map(asset => asset.name)))],
    })
    current = []
    seconds = 0
    scene = undefined
  }
  for (const item of shots) {
    const duration = item.shot.durationSeconds
    if (current.length > 0 && (item.scene !== scene || seconds + duration > maxContentSeconds)) flush()
    if (scene === undefined) scene = item.scene
    current.push(item)
    seconds += duration
    if (item.shot.breakAfter) flush()
  }
  flush()
  return tasks
}

/** One bound asset as the matched JSON records it. */
function matchedAsset(asset: CompiledShot['assets'][number]): MatchedAsset {
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    image_path: asset.localPath === '' ? asset.url : asset.localPath,
    jubian_asset_id: asset.assetId,
    jubian_material_id: asset.materialId,
    official: asset.official,
  }
}

/** One compiled shot as the matched JSON records it. */
function matchedShot(item: CompiledShot, index: number): MatchedShot {
  return {
    shot: item.shot.shot,
    segment: index + 1,
    production_mode: 'live_action',
    start: item.start,
    end: item.end,
    duration: item.end - item.start,
    script_duration: item.shot.durationSeconds,
    voice_type: item.shot.voiceType,
    speaker: item.shot.speaker,
    text: item.shot.text,
    characters: item.characters,
    task_break_after: item.shot.breakAfter,
    scene: item.scene,
    props: item.props,
    visual: item.shot.visual,
    director_format: item.shot.directorFormat,
    assets: item.assets.map(matchedAsset),
  }
}

/** Everything the matched JSON records about one episode. */
export interface MatchedInput {
  /** Two-digit episode number. */
  episode: string
  /** Absolute path of the compiled prompt file. */
  promptFile: string
  /** Compiled shots in script order. */
  shots: readonly CompiledShot[]
  /** Packages in submission order. */
  tasks: readonly PackedTask[]
}

/**
 * Build the matched JSON one episode compiles to.
 * @param input - Episode identity, prompt path, compiled shots, and packages.
 * @returns The payload written to `matches/<episode>.matched.json`.
 */
export function buildMatchedPayload(input: MatchedInput): MatchedPayload {
  return {
    version: MATCHED_VERSION,
    episode: input.episode,
    production_mode: 'live_action',
    prompt_file: input.promptFile,
    timeline_file: null,
    timing_source: 'integer_shot_script',
    shots: input.shots.map(matchedShot),
    video_tasks: input.tasks.map((task): MatchedVideoTask => ({
      shots: task.shots,
      content_duration: task.contentSeconds,
      natural_hold_duration: NATURAL_HOLD_SECONDS,
      requested_duration: task.submitSeconds,
      hold_instruction: HOLD_INSTRUCTION,
    })),
  }
}

/** Everything one episode write needs. */
export interface EpisodeWrite {
  /** Project root holding `episodes/`, `prompts/`, `matches/`, and `episode_packages/`. */
  project: string
  /** Two-digit episode number. */
  episode: string
  /** Absolute path of the source shot script. */
  scriptPath: string
  /** Absolute path of the compiled prompt file. */
  promptPath: string
  /** Absolute path of the matched JSON. */
  matchedPath: string
  /** The matched payload to write into both JSON files. */
  payload: MatchedPayload
  /** Compiled shots whose bound assets are copied into the package. */
  shots: readonly CompiledShot[]
}

/** One local asset file the package copies, with its destination. */
interface AssetCopy {
  /** Absolute source path. */
  source: string
  /** Absolute destination path inside `episode_packages/<episode>/assets/`. */
  target: string
}

/**
 * Write one episode package.
 *
 * Every input is checked before the first byte is written — the episode text and
 * each local asset image must exist — so a refused compile leaves the project
 * exactly as it was. A remote asset reference (an `http`/`https` URL) is recorded
 * in the matched JSON and not copied.
 * @param input - Project root, episode number, paths, payload, and shots.
 * @returns Absolute paths this call created or overwrote, in write order.
 * @throws {Error} When the episode text or a local asset image is missing.
 */
export async function writeEpisode(input: EpisodeWrite): Promise<string[]> {
  const packageDir = join(input.project, 'episode_packages', input.episode)
  const packageAssets = join(packageDir, 'assets')
  const episodeText = join(input.project, 'episodes', `${input.episode}.txt`)
  try {
    await access(episodeText)
  } catch (error) {
    throw new Error(`${episodeText}: 项目缺少分集正文。先把剧本拆成本集正文，再编译单集 package。`,
      { cause: error })
  }

  const copies: AssetCopy[] = []
  const copied = new Set<string>()
  for (const item of input.shots) {
    for (const asset of item.assets) {
      if (asset.localPath === '' || REMOTE_REFERENCE.test(asset.localPath) || copied.has(asset.id)) continue
      copied.add(asset.id)
      const source = isAbsolute(asset.localPath) ? asset.localPath : resolve(input.project, asset.localPath)
      try {
        await access(source)
      } catch (error) {
        throw new Error(`${source}: 资产「${asset.name}」的本地图片不存在。`
          + '修正 assets_manifest.json 的 image_path，或重新生成该资产，再编译。', { cause: error })
      }
      copies.push({ source, target: join(packageAssets, asset.type, basename(source)) })
    }
  }

  const json = JSON.stringify(input.payload, null, 2)
  const written: string[] = []
  await mkdir(dirname(input.promptPath), { recursive: true })
  await mkdir(dirname(input.matchedPath), { recursive: true })
  await mkdir(packageAssets, { recursive: true })
  if (resolve(input.scriptPath) !== resolve(input.promptPath)) {
    await copyFile(input.scriptPath, input.promptPath)
    written.push(input.promptPath)
  }
  await writeFile(input.matchedPath, json, 'utf8')
  written.push(input.matchedPath)
  const packageJson = join(packageDir, 'package.json')
  await writeFile(packageJson, json, 'utf8')
  written.push(packageJson)
  for (const copy of [
    { source: input.promptPath, target: join(packageDir, 'shot_script.txt') },
    { source: input.matchedPath, target: join(packageDir, 'matched.json') },
    { source: episodeText, target: join(packageDir, 'episode.txt') },
    ...copies,
  ]) {
    await mkdir(dirname(copy.target), { recursive: true })
    await copyFile(copy.source, copy.target)
    written.push(copy.target)
  }
  return written
}
