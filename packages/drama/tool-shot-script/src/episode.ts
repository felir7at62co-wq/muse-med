/**
 * Episode packing: an explicit content budget, the matched JSON, and the files
 * one compiled episode package holds.
 *
 * A package is a run of complete, continuous shots of one scene. The packer
 * never truncates a shot to fill a budget: it closes the current package instead,
 * and every package carries at least one second of natural hold that adds no
 * dialogue.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/episode
 */

import { access, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  BoundAsset,
  CompiledShot,
  DramaShotReport,
  ManifestAsset,
  MaterialBinding,
  MatchedAsset,
  MatchedPayload,
  MatchedShot,
  MatchedVideoTask,
  PackedTask,
  ShotIssue,
} from './types.ts'
import { characterNames } from './assets.ts'
import { continuityPeriod, reviewSceneTimes, reviewShotQuality } from './quality.ts'

/** Seconds of natural reaction, breath, or movement closure every package adds. */
export const NATURAL_HOLD_SECONDS = 1

/**
 * The provider's floor on a requested duration, in its own words on `doubao-seedance-2-5-260628`:
 * a two-second request fails with `火山方舟创建任务失败: 时长仅支持 4~30 秒之间 或 -1`, a four-second one succeeds.
 */
export const MIN_SUBMIT_SECONDS = 4

/** The content that stays legal under {@link MIN_SUBMIT_SECONDS}, once the hold is taken out of the request. */
export const MIN_CONTENT_SECONDS = MIN_SUBMIT_SECONDS - NATURAL_HOLD_SECONDS

/** The hold instruction the submitted prompt carries; it adds no dialogue. */
export const HOLD_INSTRUCTION = '结尾保持自然反应、呼吸或动作收束，不新增台词'

/** Matched-JSON generation this compiler writes. */
export const MATCHED_VERSION = 5

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
  return match[0].slice(match[0].lastIndexOf('](') + 2, -1)
}

/** Label between the brackets of a successful material placeholder match. */
function placeholderLabel(match: RegExpMatchArray): string {
  return match[0].slice(2, match[0].indexOf(']('))
}

/** Resolve a marker against this shot's selected assets, including provider display wrappers. */
function referenceAsset(item: CompiledShot, match: RegExpMatchArray, manifest: readonly ManifestAsset[]): BoundAsset | undefined {
  const label = placeholderLabel(match).replace(/^图片\d+\s*[(（](.*)[)）]$/, '$1')
  return item.assets.find((bound) => {
    if (bound.name === label) return true
    const registration = manifest.find(row => row.name === bound.name && row.assetId === bound.assetId)
    return registration !== undefined && characterNames(registration).includes(label)
  })
}

/** Check authored references against the selected identity before creating packages.
 * @param shots - Bound shots before prompt completion.
 * @param manifest - Registrations supplying exact alternate names.
 * @returns Repairable failures for unknown labels, wrong parent keys or shared keys naming different assets.
 */
export function materialReferenceIssues(shots: readonly CompiledShot[], manifest: readonly ManifestAsset[]): ShotIssue[] {
  const owners = new Map<string, string>()
  const identities = new Map<string, BoundAsset>()
  const issues: ShotIssue[] = []
  for (const item of shots) {
    for (const asset of item.assets) {
      if (asset.assetId === '') continue
      const prior = identities.get(asset.assetId)
      if (prior !== undefined && (prior.name !== asset.name || prior.materialId !== asset.materialId || prior.url !== asset.url)) {
        issues.push({ severity: 'failure', code: 'material_reference_mismatch', shot: item.shot.shot, line: item.shot.line,
          message: `镜头${item.shot.shot}的父资产 ${asset.assetId} 同时登记了不同人物或素材版本（${prior.name} / ${asset.name}）；`
            + '核对真实父资产与 material ID，不把两个版本合并为一个素材。' })
      } else identities.set(asset.assetId, asset)
    }
    for (const match of item.shot.visual.matchAll(MATERIAL_PLACEHOLDER)) {
      const key = placeholderKey(match)
      const asset = referenceAsset(item, match, manifest)
      const previous = owners.get(key)
      if (asset === undefined || (key.startsWith('asset_') && key !== `asset_${asset.assetId}`)
        || (previous !== undefined && previous !== asset.assetId)) {
        issues.push({ severity: 'failure', code: 'material_reference_mismatch', shot: item.shot.shot, line: item.shot.line,
          message: `镜头${item.shot.shot}的 ${match[0]} 与本镜选定资产不一致或复用了其他人物的 key；`
            + '删除过期引用，按本镜出镜人物、妆造和清单重新 compile，使用返回的 material_bindings。' })
      } else owners.set(key, asset.assetId)
    }
  }
  return issues
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
 * Complete shot prompts with the confirmed assets their visual directions bind.
 * Existing keys are reused across the episode, including registered alias labels;
 * otherwise the parent asset id supplies the stable `asset_<id>` key. Shot directions
 * and dialogue are retained; marker labels and keys are normalized before missing
 * named references are appended. Each shot's selected human identities limit its
 * visible cast without forcing every reference into frame; prior derived cast
 * limits are replaced when the selected identities change. Multi-view references
 * describe one person; identity and prop instructions preserve visible differences
 * without inventing features from an asset name.
 * @param shots - Compiled shots in script order.
 * @param manifest - Registrations supplying story names, aliases and animal classification.
 * @returns New shot rows with inherited scene time, current cast limits and complete material references.
 */
export function prepareShotPrompts(shots: readonly CompiledShot[], manifest: readonly ManifestAsset[] = []): CompiledShot[] {
  const { times } = reviewSceneTimes(shots.map(item => item.shot))
  const keysByAsset = new Map<string, string>()
  for (const item of shots) {
    for (const match of item.shot.visual.matchAll(MATERIAL_PLACEHOLDER)) {
      const asset = referenceAsset(item, match, manifest)
      if (asset !== undefined && !keysByAsset.has(asset.assetId)) {
        keysByAsset.set(asset.assetId, placeholderKey(match))
      }
    }
  }
  return shots.map((item) => {
    const present = new Set<string>()
    const original = item.shot.visual.split('\n').filter(line => !line.startsWith('本镜人物范围：')
      && !/^时段(?:连续性|呈现)[：:]/u.test(line))
      .join('\n').replace(MATERIAL_PLACEHOLDER, (whole: string, label: string, key: string) => {
        const match: RegExpMatchArray = [whole, label, key]
        const asset = referenceAsset(item, match, manifest)
        if (asset === undefined) return whole
        present.add(asset.assetId)
        return `@[${asset.name}](${keysByAsset.get(asset.assetId)})`
      })
    const added: string[] = []
    const people = new Map(item.assets.filter((asset) => {
      if (!item.characters.includes(asset.name) || asset.subjectKind === 'animal'
        || (asset.type !== '角色' && asset.type !== 'character')) return false
      const registration = manifest.find(row => row.name === asset.name && row.assetId === asset.assetId)
      if (registration !== undefined) return registration.subjectKind !== 'animal'
      return item.shot.bodyStates.has(asset.name) || [...item.shot.bodyStates.keys()].some(name =>
        original.split('\n').some(line => line.startsWith(
          `人物参考：${name} → @[${asset.name}](${keysByAsset.get(asset.assetId)})`,
        )))
    }).map(asset => [asset.assetId, asset.name]))
    const castLimit = people.size === 0
      ? '本镜人物范围：0人，无人物入画；画外发声与来源场次的人物表不增加出镜人物。'
      : `本镜人物范围：最多${people.size}人，仅限${[...people.values()].join('、')}；`
        + '可按本镜景别局部入画或遮挡，不强求全员同框；画外发声、来源场次人物表和其他镜头的人物不增加本镜人数。'
    for (const asset of item.assets) {
      if (!asset.official || asset.assetId === '' || asset.materialId === '' || asset.url === '') continue
      const key = keysByAsset.get(asset.assetId) ?? `asset_${asset.assetId}`
      const registration = manifest.find(row => row.name === asset.name && row.assetId === asset.assetId)
      const subject = registration === undefined ? asset.name : [...item.shot.bodyStates.keys()]
        .find(name => characterNames(registration).includes(name)) ?? asset.name
      const purpose = item.characters.includes(asset.name) ? '人物' : item.scene === asset.name ? '场景' : '道具'
      const reference = `${purpose}参考：${subject} → @[${asset.name}](${key})`
      const instruction = asset.referenceScope === 'identity'
        ? '（仅参考本人面孔与身份，保留区分本人的脸型、年龄感与面部特征；正文明确的年龄或妆造变化按本镜正文及对应正式版本，服装、动作和表情以本镜正文为准，不复制参考图的姿态；同一素材中的脸部、服装和多视角属于同一人，同一key在本镜仅一个人物实例，跨镜复用不新增人物）'
        : people.has(asset.assetId)
          ? '（保留本镜正式参考人物的脸型、年龄感和可见妆造差异；正文明确变化时使用对应正式版本，不把不同人物统一成年轻模板；动作和表情以本镜正文为准，不复制参考图的姿态；同一素材中的脸部、服装和多视角属于同一人，同一key在本镜仅一个人物实例，跨镜复用不新增人物）'
          : item.props.includes(asset.name)
            ? '（外形、结构、材质和颜色沿用本镜正式参考图，使用动作以本镜正文为准；不凭道具泛名替换外观，不发明图中未确认的材质或结构）'
            : ''
      if (instruction !== '') {
        const explained = `@[${asset.name}](${key})${instruction}`
        if (!original.includes(explained)) added.push(`${reference}${instruction}`)
      } else if (!present.has(asset.assetId)) added.push(reference)
      present.add(asset.assetId)
    }
    const time = times.get(item.shot.shot)
    const temporal = time === undefined ? [] : [`时段连续性：${time}`,
      '时段呈现：切镜及分包不推进剧情时间；光照按本镜时段，合理调整机位曝光，不因近景自动入夜或恢复白天；场景参考图保留布局与空间锚点，冲突天光不能照搬。']
    const visual = `${original}\n${[...added, ...temporal, castLimit].join('\n')}`
    return { ...item, shot: { ...item.shot, visual } }
  })
}

/**
 * Split shots at the boundaries one package may never cross.
 *
 * A package closes before another scene or explicit source period and after a shot marked
 * `子任务边界：是`. A shot whose scene is not bound carries an empty name, which is a
 * missing declaration rather than a scene of its own: it stays in the run it
 * arrived in and never closes one. Reading it as a scene split an episode whose
 * script declares a scene on every other shot into one package per shot; the
 * missing binding itself is reported as `no_scene_bound` where the script was
 * compiled.
 * @param shots - Compiled shots in script order.
 * @param maxContentSeconds - Content-second ceiling of one package.
 * @returns Nonempty runs of shots, each packable on its own.
 */
function splitContinuityUnits(
  shots: readonly CompiledShot[], maxContentSeconds: number, advisory = false,
): CompiledShot[][] {
  const units: CompiledShot[][] = []
  let current: CompiledShot[] = []
  let scene: string | undefined
  const periods = new Map<string, string>()
  const { times: sceneTimes } = reviewSceneTimes(shots.map(item => item.shot))
  for (const item of shots) {
    const duration = item.shot.durationSeconds
    if (duration > maxContentSeconds) {
      if (advisory) {
        if (current.length > 0) units.push(current)
        units.push([item])
        current = []
        scene = undefined
        continue
      }
      throw new Error(`镜头${item.shot.shot}时长${duration}秒超过内容预算${maxContentSeconds}秒；不能截断镜头。`)
    }
    const period = continuityPeriod(item.shot) || periods.get(item.scene) || ''
    if (item.scene !== '') periods.set(item.scene, period)
    const time = sceneTimes.get(item.shot.shot) ?? ''
    const declared = item.scene === '' ? undefined : JSON.stringify([item.scene, period, time])
    const changedScene = declared !== undefined && scene !== undefined && declared !== scene
    if (current.length > 0 && changedScene) {
      units.push(current)
      current = []
      scene = undefined
    }
    if (scene === undefined) scene = declared
    current.push(item)
    if (item.shot.breakAfter) {
      units.push(current)
      current = []
      scene = undefined
    }
  }
  if (current.length > 0) units.push(current)
  return units
}

/** Optional non-blocking review; strict generation packaging remains the default. */
export interface EpisodeReviewOptions {
  /** Advisory packages preserve authored prompts and may exceed the model duration limit. */
  reviewMode?: 'strict' | 'advisory'
  /** Findings accumulated by the caller, including any package-level warnings. */
  issues?: ShotIssue[]
}

/** Review raw prompts without inventing references or accepting disputed material identities. */
function advisoryPackages(
  shots: readonly CompiledShot[], maxContentSeconds: number, issues: ShotIssue[],
): PackedTask[] {
  const candidates = new Map<string, MaterialBinding>()
  const rejectedKeys = new Set<string>()
  const parents = new Map<string, string>()
  const rejectedParents = new Set<string>()
  const warn = (item: CompiledShot, code: ShotIssue['code'], message: string): void => {
    issues.push({ severity: 'warning', code, shot: item.shot.shot, line: item.shot.line, message })
  }
  for (const item of shots) {
    if (item.shot.durationSeconds > maxContentSeconds) {
      warn(item, 'shot_exceeds_package_budget', `镜头${item.shot.shot}原时长${item.shot.durationSeconds}秒超过内容预算${maxContentSeconds}秒；`
        + '检查草稿保留完整镜头与原时长，未截断，生成前核对模型能力与分包。')
    }
    const referenced = new Set<string>()
    for (const asset of item.assets) {
      if (!asset.official || asset.assetId === '' || asset.materialId === '' || asset.url === '') {
        warn(item, asset.official ? 'incomplete_asset' : 'unconfirmed_asset', `镜头${item.shot.shot}资产「${asset.name}」未确认出演或缺少父资产、material ID、URL；`
          + '原文保留，检查草稿不补造资产或生成该素材绑定。')
      }
      if (asset.assetId !== '') {
        const identity = JSON.stringify([asset.name, asset.type, asset.materialId, asset.url])
        const previous = parents.get(asset.assetId)
        if (previous !== undefined && previous !== identity) {
          rejectedParents.add(asset.assetId)
          warn(item, 'material_reference_mismatch', `镜头${item.shot.shot}父资产${asset.assetId}对应的登记身份不一致；检查草稿不猜选版本，不输出该父资产的素材绑定。`)
        } else parents.set(asset.assetId, identity)
      }
    }
    for (const match of item.shot.visual.matchAll(MATERIAL_PLACEHOLDER)) {
      const key = placeholderKey(match)
      const selected = item.assets.filter(asset => asset.name === placeholderLabel(match))
      const asset = selected.length === 1 ? selected[0] : undefined
      if (asset === undefined || !asset.official || asset.assetId === '' || asset.materialId === '' || asset.url === ''
        || (key.startsWith('asset_') && key !== `asset_${asset.assetId}`)) {
        rejectedKeys.add(key)
        warn(item, 'material_reference_mismatch', `镜头${item.shot.shot}引用${match[0]}没有唯一且完整的已确认资产对应；原文保留，检查草稿不输出该key的素材绑定。`)
        continue
      }
      referenced.add(asset.name)
      const binding: MaterialBinding = { material_key: key, name: asset.name, type: asset.type,
        official: asset.official, asset_id: asset.assetId, material_id: asset.materialId, url: asset.url,
        reference_scope: asset.referenceScope ?? 'appearance' }
      const previous = candidates.get(key)
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(binding)) {
        rejectedKeys.add(key)
        warn(item, 'material_reference_mismatch', `镜头${item.shot.shot}引用key「${key}」对应多个素材；检查草稿保留原文，不猜选其中一个绑定。`)
      } else candidates.set(key, binding)
    }
    for (const asset of item.assets) {
      if (asset.official && asset.assetId !== '' && asset.materialId !== '' && asset.url !== '' && !referenced.has(asset.name)) {
        warn(item, 'material_reference_mismatch', `镜头${item.shot.shot}资产「${asset.name}」没有可核对的内联引用；检查草稿保留原文，不自动补写引用。`)
      }
    }
  }
  const tasks: PackedTask[] = []
  const { openings } = reviewShotQuality(shots.map(item => item.shot))
  for (const unit of splitContinuityUnits(shots, maxContentSeconds, true)) {
    const packs = unit.length === 1 ? [unit] : splitUnitEvenly(unit, maxContentSeconds)
    for (const pack of packs) {
      const contentSeconds = pack.reduce((sum, item) => sum + item.shot.durationSeconds, 0)
      const [first] = pack as readonly [CompiledShot, ...CompiledShot[]]
      const opening = openings.get(first.shot.shot)
      const prompt = [opening, ...pack.map(item => item.shot.visual)].filter(Boolean).join('\n\n')
      const bindings = materialKeys(prompt).flatMap((key) => {
        const binding = candidates.get(key)
        return binding === undefined || rejectedKeys.has(key) || rejectedParents.has(binding.asset_id) ? [] : [binding]
      })
      tasks.push({ index: tasks.length + 1, shots: pack.map(item => item.shot.shot), contentSeconds,
        submitSeconds: Math.max(MIN_SUBMIT_SECONDS, contentSeconds + NATURAL_HOLD_SECONDS), prompt,
        materialKeys: bindings.map(binding => binding.material_key), materialNames: [...new Set(bindings.map(binding => binding.name))],
        materialBindings: bindings })
    }
  }
  return tasks
}

/**
 * Cut one run into the fewest packages that each fit the ceiling, as evenly as the
 * shots allow.
 *
 * Balancing targets the arithmetic minimum package count. Whole-shot boundaries
 * can require more packages; a greedy partition then retains the ceiling and
 * source order. Short tails remain visible for the caller to report.
 * @param unit - One nonempty run of continuous shots.
 * @param ceiling - Content-second ceiling of one package.
 * @returns Nonempty consecutive packs covering the run in order.
 */
function splitUnitEvenly(unit: readonly CompiledShot[], ceiling: number): readonly (readonly CompiledShot[])[] {
  const secondsOf = (shots: readonly CompiledShot[]): number =>
    shots.reduce((sum, item) => sum + item.shot.durationSeconds, 0)
  const total = secondsOf(unit)
  const count = Math.max(1, Math.ceil(total / ceiling))
  const fair = total / count

  /** Best split of one suffix into `packs` packages; `undefined` when impossible. */
  const solve = (
    packs: number, shots: readonly CompiledShot[],
  ): { packs: readonly (readonly CompiledShot[])[]; cost: number } | undefined => {
    let winner: { packs: readonly (readonly CompiledShot[])[]; cost: number } | undefined
    if (packs === 1) {
      const only = secondsOf(shots)
      if (only <= ceiling) winner = { packs: [shots], cost: (only - fair) ** 2 }
    } else {
      let run = 0
      for (const [index, item] of shots.entries()) {
        run += item.shot.durationSeconds
        if (run > ceiling) break
        const rest = solve(packs - 1, shots.slice(index + 1))
        if (rest === undefined) continue
        const cost = (run - fair) ** 2 + rest.cost
        if (winner === undefined || cost < winner.cost) {
          winner = { packs: [shots.slice(0, index + 1), ...rest.packs], cost }
        }
      }
    }
    return winner
  }

  const balanced = solve(count, unit)
  if (balanced !== undefined) return balanced.packs
  const packs: CompiledShot[][] = []
  let current: CompiledShot[] = []
  let seconds = 0
  for (const item of unit) {
    if (seconds + item.shot.durationSeconds > ceiling && current.length > 0) {
      packs.push(current)
      current = []
      seconds = 0
    }
    current.push(item)
    seconds += item.shot.durationSeconds
  }
  packs.push(current)
  return packs
}

/**
 * Pack an episode's shots into the packages one submission each renders.
 *
 * A package holds a run of complete, continuous shots of one scene and is split
 * as evenly as the run allows. Strict packages stay within the content budget;
 * advisory drafts preserve overlong complete shots and report their budgets. A package below
 * {@link MIN_CONTENT_SECONDS} receives enough natural hold to meet the four-second
 * request floor, without adding dialogue or crossing a scene boundary.
 * @param shots - Compiled shots in script order.
 * @param maxContentSeconds - Content-second ceiling of one package.
 * @param options - Advisory draft review and its findings; omitted options retain strict packaging.
 * @returns Packages in submission order.
 * @throws {Error} When the budget is unusable, or in strict mode when a bound
 *   asset is unconfirmed or incomplete, references disagree, or a shot exceeds the budget.
 */
export function packEpisode(shots: readonly CompiledShot[], maxContentSeconds: number, options: EpisodeReviewOptions = {}): PackedTask[] {
  if (!Number.isSafeInteger(maxContentSeconds) || maxContentSeconds < MIN_CONTENT_SECONDS) {
    throw new Error(`内容预算至少为${MIN_CONTENT_SECONDS}秒，提交总时长至少为${MIN_SUBMIT_SECONDS}秒。`)
  }
  if (options.reviewMode === 'advisory') return advisoryPackages(shots, maxContentSeconds, options.issues ?? [])
  for (const item of shots) {
    for (const asset of item.assets) {
      if (!asset.official || asset.assetId === '' || asset.materialId === '' || asset.url === '') {
        throw new Error(`镜头${item.shot.shot}的 ${asset.name} 未确认出演或缺少父资产、material ID、URL，不能生成视频素材绑定。`)
      }
    }
  }
  const prepared = prepareShotPrompts(shots)
  const invalid = materialReferenceIssues(prepared, [])
  if (invalid.length > 0) throw new Error(invalid.map(issue => issue.message).join('\n'))
  const tasks: PackedTask[] = []
  const { openings } = reviewShotQuality(prepared.map(item => item.shot))
  for (const unit of splitContinuityUnits(prepared, maxContentSeconds)) {
    for (const pack of splitUnitEvenly(unit, maxContentSeconds)) {
      const contentSeconds = pack.reduce((sum, item) => sum + item.shot.durationSeconds, 0)
      const [first] = pack as readonly [CompiledShot, ...CompiledShot[]]
      const opening = openings.get(first.shot.shot)
      const prompt = `${[opening, ...pack.map(item => item.shot.visual)].filter(Boolean).join('\n\n')}\n${HOLD_INSTRUCTION}`
      const bindings = new Map<string, MaterialBinding>()
      for (const item of pack) {
        for (const match of item.shot.visual.matchAll(MATERIAL_PLACEHOLDER)) {
          const key = placeholderKey(match)
          for (const asset of item.assets.filter(bound => bound.name === placeholderLabel(match))) {
            bindings.set(key, { material_key: key, name: asset.name, type: asset.type,
              official: asset.official, asset_id: asset.assetId, material_id: asset.materialId, url: asset.url,
              reference_scope: asset.referenceScope ?? 'appearance' })
          }
        }
      }
      const materialBindings = [...bindings.values()]
      tasks.push({
        index: tasks.length + 1,
        shots: pack.map(item => item.shot.shot),
        contentSeconds,
        submitSeconds: Math.max(MIN_SUBMIT_SECONDS, contentSeconds + NATURAL_HOLD_SECONDS),
        prompt,
        materialKeys: materialKeys(prompt),
        materialNames: [...new Set(pack.flatMap(item => item.assets.map(asset => asset.name)))],
        materialBindings,
      })
    }
  }
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
    shots: prepareShotPrompts(input.shots).map(matchedShot),
    video_tasks: input.tasks.map((task): MatchedVideoTask => ({
      shots: task.shots,
      content_duration: task.contentSeconds,
      natural_hold_duration: task.submitSeconds - task.contentSeconds,
      requested_duration: task.submitSeconds,
      hold_instruction: HOLD_INSTRUCTION,
      prompt: task.prompt,
      material_keys: task.materialKeys,
      material_bindings: task.materialBindings,
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

/** Inputs for a review draft, separate from generation prompts and delivery packages. */
export interface AdvisoryReviewWrite {
  /** Existing project root receiving only its `shot_reviews/<episode>/` draft. */
  project: string
  /** Episode directory name resolved from the requested positive integer. */
  episode: string
  /** Source script copied byte-for-byte into the review directory. */
  scriptPath: string
  /** Findings and draft packaging; its saved written list names the two review files. */
  report: DramaShotReport
}

/**
 * Write a source copy and findings without changing formal episode outputs or copying assets.
 * @param input - Source script, project episode and review report.
 * @returns The two review paths after both files have been written.
 * @throws When a source cannot be read, a destination uses a symlink or unsafe path, or any write fails.
 */
export async function writeAdvisoryReview(input: AdvisoryReviewWrite): Promise<string[]> {
  const root = resolve(input.project)
  const reviewRoot = join(root, 'shot_reviews')
  const directory = resolve(reviewRoot, input.episode)
  const source = await readFile(input.scriptPath)
  const suffix = relative(reviewRoot, directory)
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('检查草稿目标必须位于项目的 shot_reviews 目录内。')
  }
  const scriptCopy = join(directory, 'shot_script.txt')
  const reviewPath = join(directory, 'review.json')
  const written = [scriptCopy, reviewPath]
  const directories = [root, reviewRoot, directory]
  for (const path of [...directories, ...written]) {
    const info = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (info !== undefined && (info.isSymbolicLink() || (directories.includes(path) ? !info.isDirectory() : !info.isFile()))) {
      throw new Error(`${path}: 检查草稿目标不允许符号链接或不匹配的文件类型。`)
    }
  }
  const json = `${JSON.stringify({ ...input.report, written }, null, 2)}\n`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(scriptCopy, source, { mode: 0o600 })
  await writeFile(reviewPath, json, { encoding: 'utf8', mode: 0o600 })
  return written
}
