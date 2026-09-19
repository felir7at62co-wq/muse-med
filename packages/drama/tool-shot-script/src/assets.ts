/**
 * Asset-manifest reading and the shot-to-asset binding rules.
 *
 * Binding follows the compiler's substring semantics: a shot binds every
 * manifest character whose name appears in its `出镜人物` field or in its prompt
 * text, every prop named by `关键道具` (falling back to the prompt text), and the
 * scene named by `核心场景` (falling back to the first manifest scene named in
 * the prompt text). Every bound asset must be official and must carry a Jubian
 * parent asset id, a Jubian material id, and a URL — a shot that would submit
 * work for an unconfirmed asset fails instead of compiling.
 *
 * @module @deepseek-ai/dsh-tool-shot-script/assets
 */

import type { BoundAsset, IssueSeverity, ManifestAsset, ParsedShot, ShotIssue } from './types.ts'

/** Manifest types that bind as an on-screen character. */
const CHARACTER_TYPES = new Set(['角色', 'character'])

/** Manifest types that bind as a scene. */
const SCENE_TYPES = new Set(['场景', 'scene'])

/** Manifest types that bind as a prop. */
const PROP_TYPES = new Set(['道具', 'prop'])

/** The `关键道具` placeholder that means "this shot binds no prop". */
const NO_PROPS = new Set(['', '无'])

/** Read one manifest field as a trimmed string, or an empty string when absent. */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Read the asset array of one project's `assets_manifest.json`.
 *
 * The manifest is a wire boundary: its document, its `assets` array, and every
 * row's declared name and type are validated here, because a malformed manifest
 * must fail loud instead of silently binding nothing.
 * @param document - Parsed manifest contents.
 * @param source - Manifest path, named in every failure.
 * @returns The declared assets in manifest order.
 * @throws {Error} When the document, its `assets` array, or a row is malformed.
 */
export function parseAssetManifest(document: unknown, source: string): ManifestAsset[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`${source}: 资产清单必须是 JSON 对象，顶层键 assets 是资产数组`)
  }
  const rows = (document as { assets?: unknown }).assets
  if (!Array.isArray(rows)) {
    throw new Error(`${source}: 资产清单缺少 assets 数组`)
  }
  return rows.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`${source}: assets[${index}] 不是对象`)
    }
    const record = row as Record<string, unknown>
    const name = text(record.name)
    const type = text(record.type)
    if (name === '') throw new Error(`${source}: assets[${index}] 缺少 name`)
    if (type === '') throw new Error(`${source}: assets[${index}]（${name}）缺少 type`)
    return {
      name,
      id: text(record.id) || name,
      type,
      official: record.official === true,
      assetId: text(record.jubian_asset_id) || text(record.asset_id),
      materialId: text(record.jubian_material_id) || text(record.material_id),
      url: text(record.url) || text(record.image_url),
      localPath: text(record.image_path),
    }
  })
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

/** Build one binding issue. */
function bindingIssue(
  severity: IssueSeverity,
  code: 'unregistered_scene' | 'no_scene_bound' | 'unconfirmed_asset' | 'incomplete_asset',
  shot: ParsedShot,
  message: string,
): ShotIssue {
  return { severity, code, shot: shot.shot, line: shot.line, message }
}

/**
 * Bind one parsed shot to the manifest's official assets.
 *
 * The scene has one extra rule: `核心场景` must name a registered asset, because a
 * scene name is free text a model can invent, while characters and props are
 * matched against the manifest and therefore always resolve.
 * @param shot - One parsed shot.
 * @param assets - Every declared asset, in manifest order.
 * @returns The shot's bound assets, its resolved scene, and every issue found.
 */
export function bindShot(shot: ParsedShot, assets: readonly ManifestAsset[]): ShotBinding {
  const issues: ShotIssue[] = []
  const byName = new Map<string, ManifestAsset>()
  for (const asset of assets) byName.set(asset.name, asset)

  const characters = assets.filter(asset => isType(asset, CHARACTER_TYPES)
    && (shot.charactersField.includes(asset.name) || shot.visual.includes(asset.name)))
  const fromField = NO_PROPS.has(shot.propsField)
    ? []
    : assets.filter(asset => isType(asset, PROP_TYPES) && shot.propsField.includes(asset.name))
  const props = fromField.length > 0
    ? fromField
    : assets.filter(asset => isType(asset, PROP_TYPES) && shot.visual.includes(asset.name))

  let scene = shot.sceneField
  if (scene === '') {
    const fromVisual = assets.find(asset => isType(asset, SCENE_TYPES) && shot.visual.includes(asset.name))
    scene = fromVisual?.name ?? ''
  }
  if (scene !== '' && !byName.has(scene)) {
    issues.push(bindingIssue('failure', 'unregistered_scene', shot,
      `镜头${shot.shot}的 核心场景：${scene} 未登记在资产清单：`
      + '先把它提取成正式场景资产并确认出演，或改写成本集已登记的正式场景名。'))
  }
  if (scene === '') {
    issues.push(bindingIssue('warning', 'no_scene_bound', shot,
      `镜头${shot.shot}没有绑定任何场景资产（核心场景 空缺，画面文字里也没有已登记的场景名）：`
      + '成片会缺少场景一致性锚点，补一行 核心场景：<正式场景名> 更安全。'))
  }

  const names = [...new Set([...characters.map(asset => asset.name), ...(scene === '' ? [] : [scene]),
    ...props.map(asset => asset.name)])]
  const bound: ManifestAsset[] = []
  for (const name of names) {
    const asset = byName.get(name)
    if (asset === undefined) continue
    bound.push(asset)
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
