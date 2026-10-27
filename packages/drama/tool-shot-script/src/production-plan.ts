/** Source-preserving packaging and per-shot candidate comparison for Muse. */
import { createHash } from 'node:crypto'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { materialFieldLabel } from './assets.ts'
import { MIN_CONTENT_SECONDS, packEpisode } from './episode.ts'
import { DEFAULT_SPEECH_CHARS_PER_SECOND, parseShotScript } from './script.ts'
import type { CompiledShot, ShotIssue } from './types.ts'
import type { ProductionAsset, ProductionChoice, ProductionKind, ProductionMatch, ProductionPlan,
  ProductionRequirement, ProductionWarning } from './production-types.ts'

/** Hash exact UTF-8 source bytes or a serialized local value.
 * @param text - Text whose version is being retained.
 * @returns SHA256 in lowercase hexadecimal.
 */
export function productionHash(text: string | Uint8Array): string { return createHash('sha256').update(text).digest('hex') }

/** Read the story name without treating a costume suffix as another person.
 * @param name - A provider label or authored inline reference.
 * @returns Normalized identity text, retaining distinct complete names.
 */
export function productionName(name: string): string {
  return materialFieldLabel(name).split(/[｜|]/u).slice(-1).join('')
    .replace(/[（(].*$/u, '').replace(/^(图片\d+\s*)/u, '').trim()
}

/** Stable per-shot requirement key, independent of package boundaries.
 * @param value - Identity and shot being compared.
 * @returns A collision-free serialized key.
 */
export function requirementKey(value: ProductionRequirement): string {
  return JSON.stringify([value.shot, value.kind, value.name])
}

function names(field: string): string[] {
  return [...new Set(field.split(/[、,，;；]/u).map(productionName).filter(name => name && name !== '无'))]
}

function sameName(asset: ProductionAsset, req: ProductionRequirement): boolean {
  return asset.name === req.name || asset.name.split(/[｜|]/u).some(part => productionName(part) === productionName(req.name))
    || asset.aliases?.some(name => productionName(name) === productionName(req.name)) === true
    || req.character_id !== undefined && asset.character_id === req.character_id
}

function comparison(asset: ProductionAsset, req: ProductionRequirement): string[] {
  const reasons: string[] = []
  if (!asset.usable) reasons.push('asset_unavailable')
  if (req.character_id && asset.character_id && asset.character_id !== req.character_id) reasons.push('character_identity_mismatch')
  if (req.kind === 'voice') {
    if (!req.character_id || !req.voice_period_id) reasons.push('voice_identity_or_period_unverified')
    if (asset.character_id !== req.character_id || asset.voice_period_id !== req.voice_period_id) reasons.push('voice_slot_unverified')
    if (asset.duration_seconds === undefined) reasons.push('audio_duration_unverified')
  } else {
    const conditions = [...(req.conditions ?? []), ...(req.state ? req.state.split(/[；;、，,]/u) : [])]
      .map(item => item.trim()).filter(Boolean)
    if (req.kind === 'character' && conditions.length === 0) reasons.push('appearance_unspecified')
    const description = [asset.name, asset.state_or_costume ?? '', ...(asset.scene_conditions ?? [])].join('；')
    for (const condition of conditions) if (!description.includes(condition)) reasons.push(`condition_unverified:${condition}`)
  }
  return reasons
}

function match(req: ProductionRequirement, assets: ProductionAsset[], choices: ProductionChoice[],
  candidateLimit: number, warnings: ProductionWarning[]): ProductionMatch {
  const candidates = assets.filter(asset => asset.kind === req.kind && sameName(asset, req)).map((asset) => {
    const reasons = comparison(asset, req)
    return { ...asset, reasons, compatible: reasons.length === 0 }
  }).sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.reasons.length - b.reasons.length || a.asset_id - b.asset_id)
  const choice = choices.find(item => requirementKey(item) === requirementKey(req))
  const eligible = candidates.filter(item => item.compatible)
  const selected = choice?.asset_id === null ? undefined : choice
    ? assets.find(asset => asset.kind === req.kind && asset.asset_id === choice.asset_id) : eligible.length === 1 ? eligible[0] : undefined
  if (choice?.asset_id !== undefined && choice.asset_id !== null && selected === undefined) {
    throw new Error(`镜头${req.shot}选择的资产${choice.asset_id}不在当前项目的${req.kind}库存中；重新读取候选。`)
  }
  if (selected && (!sameName(selected, req) || comparison(selected, req).length)) warnings.push({
    code: 'selected_asset_needs_review', shot: req.shot, name: req.name,
    message: `所选${selected.asset_id}「${selected.name}」与本镜要求「${req.name}；${req.state ?? ''}」存在未核条件；请实际看图或听音核对。保留你的选择。`,
  })
  if (!selected && choice?.asset_id !== null) warnings.push({ code: candidates.length ? 'asset_candidates_ambiguous' : 'asset_missing',
    shot: req.shot, name: req.name, message: `${req.name}：${candidates.length ? '存在未唯一核实的候选，按本镜剧情选择版本。' : '没有同项目候选；普通细节可保留文字，关键参考由Muse判断是否需要补充。'}` })
  const shown = candidates.slice(0, candidateLimit)
  if (selected && !shown.some(item => item.asset_id === selected.asset_id)) shown.push({ ...selected,
    reasons: comparison(selected, req), compatible: sameName(selected, req) && comparison(selected, req).length === 0 })
  return { ...req, candidates: shown, candidate_count: candidates.length,
    candidates_truncated: candidates.length > candidateLimit, selected_asset_id: selected?.asset_id ?? null,
    selection_basis: choice ? choice.asset_id === null ? 'omitted' : 'explicit' : selected ? 'unique_metadata' : 'unresolved',
    review_required: true }
}

/** Build a complete advisory plan without altering authored dialogue or writing remote cards.
 * @param input - Actual source, session model, live inventory and optional per-shot decisions.
 * @param candidateLimit - Maximum ordinary candidates returned for each requirement.
 * @param actionShotSeconds - Estimated duration for unlabelled silent shots.
 * @param speechCharsPerSecond - Resolved spoken-character rate shared with the compiler.
 * @returns All shots, candidate evidence, complete packages and advisory findings.
 */
export function buildProductionPlan(input: Omit<ProductionPlan, 'version' | 'operation' | 'matches' | 'packages' | 'warnings' | 'fingerprint'>,
  candidateLimit: number, actionShotSeconds: number, speechCharsPerSecond = DEFAULT_SPEECH_CHARS_PER_SECOND): ProductionPlan {
  const parsed = parseShotScript(input.source, { actionShotSeconds, speechCharsPerSecond })
  const warnings: ProductionWarning[] = parsed.issues.map(issue => ({ code: issue.code, shot: issue.shot || null, message: issue.message }))
  const requirements = new Map<string, ProductionRequirement>()
  for (const shot of parsed.shots) {
    const add = (kind: ProductionKind, name: string, state?: string): void => {
      const req = { shot: shot.shot, kind, name, ...(state ? { state } : {}) }
      requirements.set(requirementKey(req), req)
    }
    for (const name of names(shot.charactersField)) add('character', name, shot.bodyStates.get(name))
    if (shot.sceneField) add('scene', productionName(shot.sceneField.replace(/（空间与陈设参考.*$/u, '')))
    for (const name of names(shot.propsField)) add('prop', name)
    if (shot.speaker && shot.text) add('voice', productionName(shot.speaker))
  }
  for (const req of input.requirements) {
    const sourceShot = parsed.shots.find(shot => shot.shot === req.shot)
    if (sourceShot === undefined) throw new Error(`素材要求引用不存在的镜头${req.shot}。`)
    if (req.kind === 'scene' && productionName(sourceShot.sceneField) !== productionName(req.name)) warnings.push({
      code: 'source_scene_requirement_changed', shot: req.shot, name: req.name,
      message: `原镜核心场景「${sourceShot.sceneField}」与本次要求「${req.name}」不同；对照原剧本、实际场景图和完整提示词核对，不能只改绑定。` })
    const state = req.kind === 'character' ? sourceShot.bodyStates.get(req.name) : undefined
    if (req.state && state && !state.includes(req.state)) warnings.push({ code: 'source_state_requirement_changed', shot: req.shot,
      name: req.name, message: `原镜身体状态「${state}」与本次要求「${req.state}」存在文字差异；核对完整人物状态，避免提示词与服装候选矛盾。` })
    if (req.kind === 'scene') for (const [key, current] of requirements) {
      if (current.shot === req.shot && current.kind === 'scene') requirements.delete(key)
    }
    requirements.set(requirementKey(req), req)
  }
  for (const choice of input.choices) if (!requirements.has(requirementKey(choice))) throw new Error(`素材选择没有对应镜头要求：${requirementKey(choice)}`)
  const matches = [...requirements.values()].map(req => match(req, input.assets, input.choices, candidateLimit, warnings))
  let cursor = 0
  const compiled: CompiledShot[] = parsed.shots.map((shot) => {
    const selected = matches.filter(item => item.shot === shot.shot && item.kind !== 'voice' && item.selected_asset_id !== null)
      .flatMap((item) => {
        const asset = input.assets.find(asset => asset.asset_id === item.selected_asset_id)
        return asset?.usable && asset.url && asset.material_id ? [{ ...asset, url: asset.url, material_id: asset.material_id }] : []
      })
    let visual = shot.visual
    // Existing markers are references, never dialogue text. Their resolved identities replace them only outside speech lines.
    visual = visual.split('\n').map(line => /^(台词|OS|VO|旁白|画外音|心声)[：:]/u.test(line.trim()) ? line
      : line.replace(/@\[([^\]]+)\]\([^)]*\)/gu, (_marker, label: string) => {
        const matching = selected.filter(asset => productionName(asset.name) === productionName(label)
          || asset.aliases?.some(name => productionName(name) === productionName(label)))
        const asset = matching[0]
        if (matching.length !== 1 || asset === undefined) {
          warnings.push({ code: 'source_reference_unresolved', shot: shot.shot, message: `原引用「${label}」未唯一对应本镜选择，保留文字并列出待核项，不沿用旧key绑定。` })
          return label
        }
        if (asset.name !== label) warnings.push({ code: 'reference_binding_changed', shot: shot.shot,
          message: `本镜引用「${label}」将对应${asset.asset_id}「${asset.name}」；对照剧情和实际图片核对，原稿文件保留。` })
        return `@[${asset.name}](asset_${asset.asset_id})`
      })).join('\n')
    const refs = [...new Map(selected.map(asset => [asset.asset_id, asset])).values()]
    if (refs.length) visual += '\n本镜素材：' + refs.map(asset => `@[${asset.name}](asset_${asset.asset_id})`).join('、')
    const result: CompiledShot = { shot: { ...shot, visual }, characters: refs.filter(item => item.kind === 'character').map(item => item.name),
      scene: refs.find(item => item.kind === 'scene')?.name ?? shot.sceneField, props: refs.filter(item => item.kind === 'prop').map(item => item.name),
      assets: refs.map(asset => ({ name: asset.name, id: String(asset.asset_id), type: asset.kind,
        official: true, assetId: String(asset.asset_id), materialId: asset.material_id, url: asset.url, localPath: '' })),
      start: cursor, end: cursor + shot.durationSeconds }
    cursor = result.end
    return result
  })
  const issues: ShotIssue[] = []
  const ceiling = input.model.maxDurationSeconds
  const packed = ceiling === null ? compiled.flatMap((shot, index) => packEpisode([shot],
    Math.max(MIN_CONTENT_SECONDS, shot.shot.durationSeconds), { reviewMode: 'advisory', issues })
    .map(task => ({ ...task, index: index + 1 }))) : packEpisode(compiled, ceiling - 1, { reviewMode: 'advisory', issues })
  if (ceiling === null) warnings.push({ code: 'model_duration_unknown', shot: null,
    message: '当前模型没有可核实的时长上限；先保留每个完整镜头为独立草稿包，不借用其他模型上限，也不宣称可提交。Muse核实能力后自主调整分包。' })
  warnings.push(...issues.map(issue => ({ code: issue.code, shot: issue.shot, message: issue.message })))
  const packages = packed.map(task => ({ index: task.index, name: `EP${String(input.episode).padStart(2, '0')}-P${task.index}`,
    shots: task.shots, duration: task.submitSeconds, prompt: task.prompt,
    images: task.materialBindings.map(binding => ({ asset_id: Number(binding.asset_id), material_key: binding.material_key })),
    voices: [...new Set(matches.filter(item => task.shots.includes(item.shot) && item.kind === 'voice')
      .flatMap(item => item.selected_asset_id === null ? [] : [item.selected_asset_id]))]
      .flatMap(id => input.assets.filter(asset => asset.asset_id === id && asset.kind === 'voice')),
    storyboard_id: null, expected_snapshot_sha256: null, current_assets: [], target_candidates: [] }))
  const plan = { ...input, version: 1 as const, operation: 'muse_production' as const,
    matches, packages, warnings }
  return { ...plan, fingerprint: stableSha256(plan) }
}
