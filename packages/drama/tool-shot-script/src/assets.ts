/**
 * Asset-manifest reading and the shot-to-asset binding rules.
 *
 * An explicit `出镜人物` list owns human selection; without it, visual
 * directions supply the names while spoken lines are excluded. Registered
 * animals also bind from visual directions independently of the human list.
 * aliases resolve to canonical assets, longer mentions suppress contained
 * short names, and episode coverage plus declared state must identify one
 * character version. Ambiguity is a repairable failure. Every bound asset must be official and must carry a Jubian
 * parent asset id, a Jubian material id, and a URL — a shot that would submit
 * work for an unconfirmed asset fails instead of compiling.
 *
 * A bound character also has to agree with the shot's own `身体状态` declaration:
 * the pregnancy stage, age band, injury or illness the shot states must be the
 * ones the asset registers in `state_or_costume` (together with its name), and
 * the registration must say which episodes that version serves. An asset whose
 * board is a late-pregnancy body must not be bound to a shot that reads 孕八周,
 * and a state no asset registers produces a restock request instead of a binding.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/assets
 */

import {
  CONFLICT,
  costumeNeedle,
  coversEpisode,
  describeEpisodes,
  hasBodyDimension,
  readEpisodes,
  readStateFacts,
} from './state.ts'
import type { StateFacts } from './state.ts'
import type { BoundAsset, IssueSeverity, ManifestAsset, ParsedShot, ShotIssue } from './types.ts'

/** Manifest types that bind as an on-screen character. */
const CHARACTER_TYPES = new Set(['角色', 'character'])

/** Manifest types for animal subjects, which retain asset and episode checks. */
const ANIMAL_TYPES = new Set(['动物', 'animal'])

/** Manifest types that bind as a scene. */
const SCENE_TYPES = new Set(['场景', 'scene'])

/** Manifest types that bind as a prop. */
const PROP_TYPES = new Set(['道具', 'prop'])

/** The `关键道具` placeholder that means "this shot binds no prop". */
const NO_PROPS = new Set(['', '无'])

/**
 * Every `type` spelling a manifest row may declare, in the order a failure names
 * them.
 *
 * This is exactly the set {@link bindShot} can act on, and no wider: a spelling
 * added here without a matching binding rule would pass validation and then be
 * skipped at binding, which is the silent green `validate` this list exists to
 * prevent.
 */
const TYPE_SPELLINGS = [...CHARACTER_TYPES, ...ANIMAL_TYPES, ...SCENE_TYPES, ...PROP_TYPES]

/** Read one manifest field as a trimmed string, or an empty string when absent. */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * What reading one manifest produced: the declared assets, and every row defect
 * the caller has to report.
 *
 * A row defect is an issue rather than a rejection because this manifest is
 * authored by a model and read by three tools: failing the whole read would turn
 * one row into a parse failure that hides every other finding, and the caller
 * would never see the issue list it has to repair. Every issue here is a
 * failure-severity one, so a read carrying any of them cannot answer `ok`.
 */
export interface ManifestRead {
  /** Every declared asset, in manifest order, including a row whose `type` no binding rule matches. */
  assets: ManifestAsset[]
  /** Every row defect found while reading, in manifest order. */
  issues: ShotIssue[]
}

/**
 * The failure one row's unusable `type` produces: the row, the name, the value
 * read, the accepted spellings, and the repair.
 */
function assetTypeIssue(source: string, index: number, name: string, type: string): ShotIssue {
  return { severity: 'failure', code: 'asset_type_unusable', line: 0, shot: 0,
    message: `${source}: 第 ${index + 1} 条资产（${name}）的 type="${type}" 不在允许的取值里：`
      + `只接受 ${TYPE_SPELLINGS.join('、')}。`
      + '别的拼法（例如 role）不绑定任何资产，也不会产生别的失败——'
      + '角色资产被跳过时 drama_shot validate 会误报 ok:true、0 failures。'
      + '请把这行的 type 改成上面的拼法之一后重跑。' }
}

/**
 * Read the asset array of one project's `assets_manifest.json`.
 *
 * The manifest is a durable-file boundary, so its document, its asset array, and
 * every row's declared name and type are read here. The registration fields a
 * bound asset needs — `episodes`, `state_or_costume` — are read as declared and
 * judged at binding, where the failure names the asset and the repair.
 *
 * A `type` outside {@link TYPE_SPELLINGS} is kept in the returned assets and
 * reported as a failure issue instead of ending the read: the binder matches
 * types by exact spelling, so an unknown one binds nothing without any other
 * rule noticing, and a `validate` that bound no character would otherwise answer
 * `ok: true` over an empty finding list — the silent green this check exists to
 * prevent. Reporting it leaves the caller the rest of the run's findings.
 * @param document - Parsed manifest contents.
 * @param source - Manifest path, named in every failure.
 * @returns The declared assets in manifest order, plus one issue per row whose `type` binds nothing.
 * @throws {Error} When the document, its asset array, or a row is malformed.
 */
export function parseAssetManifest(document: unknown, source: string): ManifestRead {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`${source}: 资产清单必须是 JSON 对象，顶层键 assets 是资产数组`)
  }
  // The project's own manifest spells the array `items`; the shot scripts' older
  // copy spells it `assets`. Both are one file, so either key is read.
  const declared = document as { assets?: unknown; items?: unknown }
  const rows = Array.isArray(declared.assets) ? declared.assets : declared.items
  if (!Array.isArray(rows)) {
    throw new Error(`${source}: 资产清单缺少 assets 数组`)
  }
  const issues: ShotIssue[] = []
  const assets = rows.map((row, index): ManifestAsset => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`${source}: assets[${index}] 不是对象`)
    }
    const record = row as Record<string, unknown>
    const name = text(record.name)
    const type = text(record.type)
    if (name === '') throw new Error(`${source}: assets[${index}] 缺少 name`)
    if (type === '') throw new Error(`${source}: assets[${index}]（${name}）缺少 type`)
    const subjectKind = record.subject_kind
    if (subjectKind !== undefined && subjectKind !== 'animal' && subjectKind !== 'human') {
      throw new Error(`${source}: assets[${index}]（${name}）subject_kind 只接受 animal 或 human`)
    }
    if (!TYPE_SPELLINGS.includes(type)) issues.push(assetTypeIssue(source, index, name, type))
    return {
      name,
      id: text(record.id) || name,
      type,
      ...(subjectKind === undefined ? {} : { subjectKind }),
      official: record.official === true,
      assetId: text(record.jubian_asset_id) || text(record.asset_id),
      materialId: text(record.jubian_material_id) || text(record.material_id),
      url: text(record.url) || text(record.image_url),
      localPath: text(record.image_path),
      aliases: (Array.isArray(record.aliases) ? record.aliases.map(text).filter(Boolean).join('、') : text(record.aliases)) || text(record.alias),
      episodes: readEpisodes(record.episodes),
      stateOrCostume: text(record.state_or_costume) || text(record.state),
    }
  })
  return { assets, issues }
}

/** One shot's resolved binding: which assets it uses and what is wrong with them. */
export interface ShotBinding {
  /** Bound assets in prompt order: characters, then the scene, then props. */
  assets: BoundAsset[]
  /** Bound character asset names, in manifest order. */
  characters: string[]
  /** Resolved scene asset name, or an empty string. */
  scene: string
  /** Bound prop asset names, in manifest order. */
  props: string[]
  /** Every binding failure or warning this shot produced. */
  issues: ShotIssue[]
}

/** Whether one manifest row matches one of the declared type spellings. */
function isType(asset: ManifestAsset, types: ReadonlySet<string>): boolean {
  return types.has(asset.type)
}

/** Whether a registered subject is an animal rather than a human body-state target. */
function isAnimal(asset: ManifestAsset): boolean {
  return isType(asset, ANIMAL_TYPES) || (isType(asset, CHARACTER_TYPES) && asset.subjectKind === 'animal')
}

/** Build one binding issue. */
function bindingIssue(
  severity: IssueSeverity,
  code: 'unregistered_scene' | 'no_scene_bound' | 'unconfirmed_asset' | 'incomplete_asset'
    | 'shot_body_state_missing' | 'shot_body_state_unusable' | 'asset_state_unregistered'
    | 'asset_state_mismatch' | 'asset_episodes_unregistered' | 'asset_episode_mismatch'
    | 'asset_state_missing' | 'asset_binding_ambiguous' | 'unregistered_character',
  shot: ParsedShot,
  message: string,
): ShotIssue {
  return { severity, code, shot: shot.shot, line: shot.line, message }
}

/** How one asset is named in a failure: its registered name and the ids that identify it remotely. */
function describeAsset(asset: ManifestAsset): string {
  const ids = [
    ...(asset.assetId === '' ? [] : [`jubian_asset_id ${asset.assetId}`]),
    ...(asset.materialId === '' ? [] : [`material ${asset.materialId}`]),
  ]
  return `资产 ${asset.name}${ids.length === 0 ? '' : `（${ids.join(' / ')}）`}`
}

/** What one registration declares: its `state_or_costume` plus the stage its own name spells. */
function registeredFacts(asset: ManifestAsset): StateFacts {
  return readStateFacts(`${asset.stateOrCostume}；${asset.name}`)
}

/** The other names one asset answers to, as the registration spelled them. */
function aliasNames(asset: ManifestAsset): string[] {
  return asset.aliases.split(/[、,，;；/|｜\s]+/).filter(name => name.trim() !== '')
}

/** One registered name or alias at a location in the shot's declared or visual text. */
interface Mention { label: string; start: number; end: number; candidates: ManifestAsset[] }

/** A character's canonical name, aliases and unqualified name before its version suffix. */
function characterNames(asset: ManifestAsset): string[] {
  return [...new Set([asset.name, ...aliasNames(asset), asset.name.replace(/[（(].*$/, '').trim()])].filter(Boolean)
}

/** Match the longest registered names at each text location, retaining alias collisions. */
function characterMentions(source: string, assets: readonly ManifestAsset[]): Mention[] {
  const byLabel = new Map<string, ManifestAsset[]>()
  for (const asset of assets) {
    if (!isType(asset, CHARACTER_TYPES) && !isType(asset, ANIMAL_TYPES)) continue
    for (const label of characterNames(asset)) byLabel.set(label, [...(byLabel.get(label) ?? []), asset])
  }
  const mentions: Mention[] = []
  for (const [label, candidates] of byLabel) {
    let start = source.indexOf(label)
    while (start >= 0) {
      mentions.push({ label, start, end: start + label.length, candidates })
      start = source.indexOf(label, start + label.length)
    }
  }
  const longest = mentions.filter(mention => !mentions.some(other => other.start <= mention.start
    && other.end >= mention.end && other.label.length > mention.label.length))
  const seen = new Set<string>()
  return longest.sort((a, b) => a.start - b.start).filter((mention) => {
    if (seen.has(mention.label)) return false
    seen.add(mention.label)
    return true
  })
}

/** Visual inference excludes the speech track and its speaker metadata. */
function visualDirections(shot: ParsedShot): string {
  return shot.visual.split('\n').filter(line => !/^\s*(?:台词|说话人|发声类型|旁白|心声|画外音)\s*[：:]/.test(line)).join('\n')
}

/** Split an on-screen list without splitting costume annotations in parentheses. */
function declaredCharacters(source: string): string[] {
  const result: string[] = []
  let depth = 0; let current = ''
  for (const character of source) {
    if ('（('.includes(character)) depth++
    if ('）)'.includes(character)) depth = Math.max(0, depth - 1)
    if (depth === 0 && /[、,，;；/|｜\n]/.test(character)) {
      if (current.trim()) result.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) result.push(current.trim())
  return result
}

/** Select one version per on-screen mention without defaulting to the manifest's first row. */
function selectCharacters(shot: ParsedShot, assets: readonly ManifestAsset[], episode: number | undefined,
  issues: ShotIssue[]): ManifestAsset[] {
  const source = shot.charactersField || visualDirections(shot)
  const animals = assets.filter(isAnimal)
  const declared = characterMentions(source, assets)
  const mentions = [...declared, ...characterMentions(visualDirections(shot), animals).filter(mention =>
    !declared.some(named => named.candidates.some(asset => mention.candidates.includes(asset))))]
  const selected = new Set<ManifestAsset>()
  for (const mention of mentions) {
    let candidates = [...new Map(mention.candidates.map(asset => [JSON.stringify(asset), asset])).values()]
    if (candidates.length > 1) {
      const covered = candidates.filter(asset => coversEpisode(asset.episodes, episode))
      if (covered.length === 0) {
        issues.push(bindingIssue('failure', 'asset_episode_mismatch', shot,
          `镜头${shot.shot}的 ${mention.label} 没有覆盖第${String(episode)}集的版本：`
          + `${candidates.map(describeRegistration).join('；')}。登记实际适用集数或选本集资产。`))
        continue
      }
      candidates = covered
    }
    if (candidates.length > 1) {
      const compatible = candidates.filter((asset) => {
        if (isAnimal(asset)) return false
        const declared = declaredStateFor(asset, shot.bodyStates)
        if (declared === undefined) return false
        const required = readStateFacts(declared)
        return hasBodyDimension(required) && registrationAgrees(required, registeredFacts(asset))
      })
      if (compatible.length > 0) candidates = compatible
    }
    if (candidates.length !== 1) {
      issues.push(bindingIssue('failure', 'asset_binding_ambiguous', shot,
        `镜头${shot.shot}的 ${mention.label} 无法唯一绑定角色版本：`
        + `${candidates.map(describeAsset).join('；')}。用完整资产名明确本镜版本，或补清 episodes 与身体状态；不按清单顺序猜。`))
      continue
    }
    for (const chosen of candidates) {
      const qualified = chosen.name === mention.label || aliasNames(chosen).includes(mention.label)
      const declared = declaredStateFor(chosen, shot.bodyStates)
      if (!isAnimal(chosen) && !qualified && declared !== undefined) {
        const required = readStateFacts(declared)
        if (hasBodyDimension(required) && !registrationAgrees(required, registeredFacts(chosen))) continue
      }
      selected.add(chosen)
    }
  }
  if (shot.charactersField) {
    for (const name of declaredCharacters(shot.charactersField)) {
      if (characterMentions(name, assets).length || [...shot.bodyStates].some(([character, state]) =>
        name.includes(character) && hasBodyDimension(readStateFacts(state)))) continue
      issues.push(bindingIssue('failure', 'unregistered_character', shot,
        `镜头${shot.shot}的出镜人物 ${name} 未登记正式角色或 aliases：补登记对应资产与版本，或更正本镜出镜名单。`))
    }
  }
  return assets.filter(asset => selected.has(asset))
}

/** Whether one manifest row is a version of the character a state declaration names. */
function isVersionOf(asset: ManifestAsset, character: string): boolean {
  if (!isType(asset, CHARACTER_TYPES) || isAnimal(asset)) return false
  return [asset.name, ...aliasNames(asset)].some(name => name === character
    || name.includes(character) || (name.length >= 2 && character.includes(name)))
}

/** The state declaration that governs one bound asset: the longest declared key that names it. */
function declaredStateFor(asset: ManifestAsset, states: ReadonlyMap<string, string>): string | undefined {
  let found: string | undefined
  let longest = -1
  for (const [character, value] of states) {
    if (!isVersionOf(asset, character) || character.length <= longest) continue
    found = value
    longest = character.length
  }
  return found
}

/** How one declared dimension reads in a failure message. */
function describeDimension(label: string, value: string): string {
  if (value === CONFLICT) return `${label}=同一处写了两个不同取值`
  return `${label}=${value === '' ? '未登记' : value}`
}

/** Everything one declaration requires, as one message fragment. */
function describeRequirement(required: StateFacts): string {
  const parts = [
    ...(required.pregnancy === '' ? [] : [describeDimension('孕期阶段', required.pregnancy)]),
    ...(required.age === '' ? [] : [describeDimension('年龄段', required.age)]),
    ...(required.costume.length === 0 ? [] : [`服装/发型 ${required.costume.join('、')}`]),
  ]
  return parts.join('、')
}

/** The two dimensions that decide a silhouette, as `[label, required, registered]` triples. */
function dimensionsOf(required: StateFacts, registered: StateFacts): readonly (readonly [string, string, string])[] {
  return [
    ['孕期阶段', required.pregnancy, registered.pregnancy],
    ['年龄段', required.age, registered.age],
  ]
}

/** The dimensions a shot declares and one registration does not, or declares differently. */
function stateDifferences(required: StateFacts, registered: StateFacts): {
  unregistered: string[]
  mismatched: string[]
} {
  const unregistered: string[] = []
  const mismatched: string[] = []
  for (const [label, wanted, actual] of dimensionsOf(required, registered)) {
    if (wanted === '' || wanted === actual) continue
    const line = `${label}：镜头 ${describeDimension(label, wanted)} / 资产 ${actual === '' ? '未登记' : actual}`
    if (actual === '') unregistered.push(line)
    else mismatched.push(line)
  }
  return { unregistered, mismatched }
}

/** The dimensions one registration declares and a shot does not. */
function undeclaredByShot(required: StateFacts, registered: StateFacts): string[] {
  return dimensionsOf(required, registered)
    .filter(([, wanted, actual]) => wanted === '' && actual !== '')
    .map(([label, , actual]) => `${label}=${actual}`)
}

/** The costume and hair a shot requires that one registration does not name. */
function missingCostume(required: StateFacts, registered: StateFacts): string[] {
  const haystack = costumeNeedle(registered.costume.join(''))
  return required.costume.filter(item => !haystack.includes(costumeNeedle(item)))
}

/**
 * Whether one registration states everything one shot requires.
 *
 * A restock request is about the requirement the manifest cannot meet, so a
 * registration that declares more than the shot did does not suppress it — that
 * disagreement is its own failure, repaired in the shot rather than by an asset.
 */
function registrationAgrees(required: StateFacts, registered: StateFacts): boolean {
  const { unregistered, mismatched } = stateDifferences(required, registered)
  return unregistered.length === 0 && mismatched.length === 0
    && missingCostume(required, registered).length === 0
}

/** How one asset's registration reads in a restock request: its name and the stage it declares. */
function describeRegistration(asset: ManifestAsset): string {
  const registered = registeredFacts(asset)
  const stage = describeDimension('孕期阶段', registered.pregnancy)
  return `${asset.name}（${stage}，${describeEpisodes(asset.episodes)}）`
}

/** The episode-coverage failures of every asset this shot binds. */
function episodeIssues(bound: readonly ManifestAsset[], shot: ParsedShot, episode: number | undefined): ShotIssue[] {
  const issues: ShotIssue[] = []
  for (const asset of bound) {
    if (asset.episodes.kind === 'missing' || asset.episodes.kind === 'invalid') {
      issues.push(bindingIssue('failure', 'asset_episodes_unregistered', shot,
        `镜头${shot.shot}的${describeAsset(asset)}没有登记用于哪几集：${describeEpisodes(asset.episodes)}。`
        + '请在 assets_manifest.json 的该行写清 episodes——具体集号数组如 [25]，'
        + '或全剧通用母版写 ["all"]；登记了才允许被镜头绑定。'))
      continue
    }
    if (coversEpisode(asset.episodes, episode)) continue
    issues.push(bindingIssue('failure', 'asset_episode_mismatch', shot,
      `镜头${shot.shot}的${describeAsset(asset)}登记用于${describeEpisodes(asset.episodes)}，但本次是第${String(episode)}集：`
      + '换成本集登记覆盖的资产，或把该行的 episodes 改成这个版本真正适用的集号。'))
  }
  return issues
}

/**
 * The body-state failures of every character this shot binds, plus a restock
 * request for every declared state the manifest holds no asset for.
 *
 * The rule is symmetric: a dimension declared on one side and not the other is an
 * unregistered state rather than agreement, because nothing then proves the
 * asset's board renders the state the script wrote.
 */
function bodyStateIssues(
  shot: ParsedShot,
  bound: readonly ManifestAsset[],
  assets: readonly ManifestAsset[],
  episode: number | undefined,
): ShotIssue[] {
  const issues: ShotIssue[] = []
  const states = shot.bodyStates
  const matched = new Set<string>()
  for (const asset of bound) {
    if (!isType(asset, CHARACTER_TYPES) || isAnimal(asset)) continue
    const declared = declaredStateFor(asset, states)
    if (declared === undefined) {
      issues.push(bindingIssue('failure', 'shot_body_state_missing', shot,
        `镜头${shot.shot}的${describeAsset(asset)}没有对应的身体状态声明：这个入画角色在本镜需要什么阶段/体型没有写下来，`
        + '无法证明所挂资产是对的版本。请在该角色自己的 主体状态追踪 段落里补一行 '
        + '身体状态：【阶段（孕周/年龄段）；服装；发型】；，没有体型变化也要写 非孕期。'))
      continue
    }
    const required = readStateFacts(declared)
    if (!hasBodyDimension(required)) {
      issues.push(bindingIssue('failure', 'shot_body_state_unusable', shot,
        `镜头${shot.shot}的资产 ${asset.name} 对应的身体状态声明是「${declared}」：读不出阶段/体型。`
        + '请写成 身体状态：【孕早期（孕八周）；孕期职场装；长发】；这样的阶段+服装，'
        + '没有体型变化也要写 非孕期。'))
      continue
    }
    const registered = registeredFacts(asset)
    const { unregistered, mismatched } = stateDifferences(required, registered)
    const shotSilent = undeclaredByShot(required, registered)
    const costume = missingCostume(required, registered)
    if (unregistered.length > 0) {
      issues.push(bindingIssue('failure', 'asset_state_unregistered', shot,
        `镜头${shot.shot}的${describeAsset(asset)}没有登记镜头所需的${unregistered.join('、')}：`
        + `state_or_costume 是「${asset.stateOrCostume === '' ? '空' : asset.stateOrCostume}」，无法证明它是这一版。`
        + '在 assets_manifest.json 的该行 state_or_costume 里补上阶段/体型（如「孕早期（孕八周）、孕期职场装、长发」），'
        + '或改挂已登记该阶段的资产；确实没有对应版本就按缺料补资产。'))
    }
    if (shotSilent.length > 0) {
      issues.push(bindingIssue('failure', 'shot_body_state_unusable', shot,
        `镜头${shot.shot}的${describeAsset(asset)}登记了${shotSilent.join('、')}，但镜头的身体状态声明「${declared}」没有写：`
        + '两侧必须写同一组维度。请把该维度补进这一镜的 身体状态，或改挂不声明该维度的资产。'))
    }
    if (mismatched.length > 0 || costume.length > 0) {
      const parts = [
        ...(mismatched.length === 0 ? [] : [mismatched.join('、')]),
        ...(costume.length === 0 ? [] : [`服装/发型未在该资产登记里找到：${costume.join('、')}`]),
      ]
      issues.push(bindingIssue('failure', 'asset_state_mismatch', shot,
        `镜头${shot.shot}需要 ${describeRequirement(required)}（镜头声明：${declared}），`
        + `但${describeAsset(asset)}登记的是「${asset.stateOrCostume === '' ? '空' : asset.stateOrCostume}」：`
        + `${parts.join('；')}。换成本集已登记该状态的同角色资产，或按这个状态补一个资产；不得沿用当前版本提交。`))
    }
  }

  for (const [character, declared] of states) {
    if (assets.some(asset => isAnimal(asset) && characterNames(asset).includes(character))) continue
    const required = readStateFacts(declared)
    if (!hasBodyDimension(required) || matched.has(character)) continue
    // A declaration that contradicts itself names no state an asset could carry, so
    // the mismatch above is the whole finding: the repair is in the shot.
    if ([required.pregnancy, required.age].includes(CONFLICT)) continue
    // `主体状态追踪` also names parts and groups (「小飞右脚和足球」, 「老张双手」).
    // A restock request is only meaningful for a character the shot puts on screen:
    // one named by `出镜人物`, or one whose registered version this shot binds.
    const onScreen = shot.charactersField.includes(character)
      || bound.some(asset => isVersionOf(asset, character))
    if (!onScreen) continue
    const versions = assets.filter(asset => isVersionOf(asset, character))
    // Episode coverage has its own failure above; a restock is about the state no
    // registration carries, so an otherwise matching version suppresses it.
    if (versions.some(asset => registrationAgrees(required, registeredFacts(asset)))) continue
    matched.add(character)
    const costume = required.costume.length === 0 ? '（镜头未写服装）' : required.costume.join('、')
    const episodes = episode === undefined ? '本次调用没给 episode，请在 compile 或 validate 时带上集号' : `第${String(episode)}集`
    issues.push(bindingIssue('failure', 'asset_state_missing', shot,
      `镜头${shot.shot}的 ${character} 需要 ${describeRequirement(required)}（镜头声明：${declared}），`
      + '但资产清单里没有符合这个状态的角色资产。'
      + `已登记的该角色版本：${versions.length === 0 ? '无' : versions.map(describeRegistration).join('；')}。`
      + `补料需求：角色=${character}；阶段=${required.pregnancy === '' ? '按剧本写明' : required.pregnancy}；`
      + `服装=${costume}；用于=${episodes}。`
      + '补料路径：从 jubian-asset-library 复用，或用 jubian_video/jubian_asset 生成/导入该状态资产 → '
      + '在 assets_manifest.json 登记新行（name、type=角色、episodes、state_or_costume、official=true、'
      + 'jubian_asset_id、jubian_material_id、url）→ 跑 drama_assets reconcile 留对账证据 → 重新 drama_shot validate/compile。'))
  }
  return issues
}

/** Same-named assets require one eligible registration; local copy paths do not define another remote version. */
function selectNamedAssets(candidates: readonly ManifestAsset[], shot: ParsedShot, episode: number | undefined,
  issues: ShotIssue[]): ManifestAsset[] {
  const byName = new Map<string, ManifestAsset[]>()
  for (const asset of candidates) byName.set(asset.name, [...(byName.get(asset.name) ?? []), asset])
  const selected: ManifestAsset[] = []
  for (const [name, rows] of byName) {
    let versions = [...new Map(rows.map(asset => [JSON.stringify({ ...asset, localPath: '' }), asset])).values()]
    if (versions.length > 1) {
      const covered = versions.filter(asset => coversEpisode(asset.episodes, episode))
      if (covered.length === 0) {
        issues.push(bindingIssue('failure', 'asset_episode_mismatch', shot,
          `镜头${shot.shot}的 ${name} 没有覆盖第${String(episode)}集的资产版本：`
          + `${versions.map(asset => `${describeAsset(asset)}，${describeEpisodes(asset.episodes)}`).join('；')}。`
          + '登记实际适用集数或选择本集资产。'))
        continue
      }
      versions = covered
    }
    if (versions.length !== 1) {
      issues.push(bindingIssue('failure', 'asset_binding_ambiguous', shot,
        `镜头${shot.shot}的 ${name} 无法唯一绑定资产版本：${versions.map(describeAsset).join('；')}。`
        + '用不同的完整资产名明确本镜版本，或补清 episodes；不按清单顺序猜。'))
      continue
    }
    selected.push(...versions)
  }
  return selected
}

/**
 * Bind one parsed shot to the manifest's official assets.
 *
 * The scene has one extra rule: `核心场景` must name a registered asset, because a
 * scene name is free text a model can invent, while characters and props are
 * matched against the manifest and therefore always resolve.
 * @param shot - One parsed shot, carrying the body state it declares per character.
 * @param assets - Every declared asset, in manifest order.
 * @param episode - The episode being compiled, or undefined when the call names none;
 *   without it a registration still has to declare its episodes, but coverage is not judged.
 * @returns The shot's bound assets, its resolved scene, and every issue found.
 */
export function bindShot(shot: ParsedShot, assets: readonly ManifestAsset[],
  episode?: number): ShotBinding {
  const issues: ShotIssue[] = []
  const characters = selectCharacters(shot, assets, episode, issues)
  const fromField = NO_PROPS.has(shot.propsField)
    ? []
    : assets.filter(asset => isType(asset, PROP_TYPES) && shot.propsField.includes(asset.name))
  const propCandidates = shot.propsField === '无' ? [] : fromField.length > 0
    ? fromField
    : assets.filter(asset => isType(asset, PROP_TYPES) && shot.visual.includes(asset.name))
  const props = selectNamedAssets(propCandidates, shot, episode, issues)

  let scene = shot.sceneField
  if (scene === '') {
    const fromVisual = assets.find(asset => isType(asset, SCENE_TYPES) && shot.visual.includes(asset.name))
    scene = fromVisual?.name ?? ''
  }
  const sceneCandidates = assets.filter(asset => isType(asset, SCENE_TYPES) && asset.name === scene)
  if (scene !== '' && sceneCandidates.length === 0) {
    issues.push(bindingIssue('failure', 'unregistered_scene', shot,
      `镜头${shot.shot}的 核心场景：${scene} 未登记在资产清单：`
      + '先把它提取成正式场景资产并确认出演，或改写成本集已登记的正式场景名。'))
  }
  const scenes = selectNamedAssets(sceneCandidates, shot, episode, issues)
  if (scene === '') {
    issues.push(bindingIssue('warning', 'no_scene_bound', shot,
      `镜头${shot.shot}没有绑定任何场景资产（核心场景 空缺，画面文字里也没有已登记的场景名）：`
      + '成片会缺少场景一致性锚点，补一行 核心场景：<正式场景名> 更安全。'))
  }

  const bound = selectNamedAssets([...characters, ...scenes, ...props], shot, episode, issues)
  for (const asset of bound) {
    if (!asset.official) {
      issues.push(bindingIssue('failure', 'unconfirmed_asset', shot,
        `镜头${shot.shot}引用未确认出演资产：${asset.name}（official 不是 true）。`
        + '先确认出演，或换成本集已登记的正式资产。'))
      continue
    }
    const missing = [
      ...(asset.assetId === '' ? ['jubian_asset_id'] : []),
      ...(asset.materialId === '' ? ['jubian_material_id'] : []),
      ...(asset.url === '' ? ['URL'] : []),
    ]
    if (missing.length > 0) {
      issues.push(bindingIssue('failure', 'incomplete_asset', shot,
        `镜头${shot.shot}的资产 ${asset.name} 缺少剧变绑定信息：${missing.join('、')}。`
        + '只绑定 official=true 且有剧变 asset/material ID 与 URL 的资产。'))
    }
  }
  issues.push(...episodeIssues(bound, shot, episode))
  issues.push(...bodyStateIssues(shot, bound, assets, episode))

  return {
    assets: bound.map(asset => ({
      name: asset.name,
      id: asset.id,
      type: asset.type,
      official: asset.official,
      assetId: asset.assetId,
      materialId: asset.materialId,
      url: asset.url,
      localPath: asset.localPath,
    })),
    characters: [...new Set(characters.map(asset => asset.name))],
    scene,
    props: [...new Set(props.map(asset => asset.name))],
    issues,
  }
}
