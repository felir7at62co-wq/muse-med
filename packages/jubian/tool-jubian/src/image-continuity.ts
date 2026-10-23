/** Adopted character images used as omitted regeneration references. */
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readMaterialList } from '@deepseek-ai/dsh-jubian-api'
import { productionRows } from './production.ts'

/** Complete project-inventory acquisition limits. */
export interface ImageReferenceScanOptions { pageSize: number; pageLimit: number }

/** The source of this call's references, not a visual identity assessment. */
export interface IdentityReference {
  status: 'inherited' | 'explicit' | 'explicit_none' | 'missing' | 'not_applicable' | 'unknown'
  asset_id: number | null
  material_id: number | null
  url: string | null
  reason: string | null
}

/** One resolved ordered reference list and its attributable source. */
export interface ImageReferenceResolution {
  references: string[]
  identity_reference: IdentityReference
}

/** The caller fields needed to resolve omitted image references. */
export interface ImageReferenceInput {
  scriptId: number
  assetType: number
  parentAssetId?: number
  references?: string[]
}

/**
 * Resolve adopted-reference inventory acquisition bounds.
 * @param config - Deployment limits for complete image-reference inventory reads.
 * @returns Validated page size and maximum pages.
 */
export function resolveImageReferenceScanOptions(config: {
  imageReferencePageSize?: number
  imageReferencePageLimit?: number
} = {}): ImageReferenceScanOptions {
  const pageSize = config.imageReferencePageSize ?? 1000
  const pageLimit = config.imageReferencePageLimit ?? 100
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
    || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new JubianError('INVALID_ARGUMENT', 'imageReferencePageSize must be 1..1000 and imageReferencePageLimit must be 1..100')
  }
  return { pageSize, pageLimit }
}

function resolution(status: IdentityReference['status'], reason: string,
  references: string[] = [], assetId: number | null = null): ImageReferenceResolution {
  return { references, identity_reference: { status, asset_id: assetId, material_id: null, url: null, reason } }
}

/**
 * Report that a replay does not establish the original call's reference source.
 * @returns Unattributed reference metadata without a continuity claim.
 */
export function unknownIdentityReference(): IdentityReference {
  return resolution('unknown', '原 key 已有记录，本次未生成；不把当前采用图冒报为原请求参考。').identity_reference
}

/**
 * Resolve each image call against one complete project snapshot shared by its batch.
 * @param client - Existing authenticated read transport.
 * @param limits - Validated inventory acquisition bounds.
 * @param signal - Optional foreground cancellation passed to each inventory page.
 * @returns Resolver preserving explicit references and inheriting only a unique adopted character image.
 */
export function createImageReferenceResolver(
  client: JubianClient, limits: ImageReferenceScanOptions, signal?: AbortSignal,
): (input: ImageReferenceInput) => Promise<ImageReferenceResolution> {
  const projects = new Map<number, Promise<{ assets: Record<string, unknown>[]; materials: ReturnType<typeof readMaterialList>['rows'] }>>()
  const inventory = (scriptId: number) => {
    let pending = projects.get(scriptId)
    if (pending === undefined) {
      pending = (async () => {
        const assets = await productionRows(client, scriptId, 'asset', limits.pageSize, limits.pageLimit, signal)
        const rows = await productionRows(client, scriptId, 'material', limits.pageSize, limits.pageLimit, signal)
        return { assets, materials: readMaterialList({ rows, total: rows.length }).rows }
      })()
      projects.set(scriptId, pending)
    }
    return pending
  }
  return async (input) => {
    signal?.throwIfAborted()
    if (input.references !== undefined) return resolution(input.references.length ? 'explicit' : 'explicit_none',
      input.references.length ? '使用调用者提供的有序参考图，不自动添加或替换身份图。'
        : '调用者明确选择无参考图；这不保证人物身份连续。', [...input.references])
    if (input.assetType !== 1) return resolution('not_applicable', '非角色图片不自动继承人物参考。')
    if (input.parentAssetId === undefined) return resolution('missing', '新父资产没有可自动识别的同角色图；本次无身份参考，不保证面孔连续。')
    const { assets, materials } = await inventory(input.scriptId)
    signal?.throwIfAborted()
    const parent = assets.find(row => Number(row.id) === input.parentAssetId)
    if (parent === undefined || Number(parent.assetType) !== 1 || String(parent.delFlag) !== '0') {
      throw new JubianError('CONTRACT_CHANGED', 'Cannot inherit an adopted character image: parent is not a character in this project; no paid request was sent')
    }
    const selected = materials.filter(row => row.asset_id === input.parentAssetId && row.is_used
      && row.status?.trim().toLowerCase() === 'active')
    if (selected.length > 1) throw new JubianError('CONTRACT_CHANGED',
      'Cannot inherit an adopted character image: multiple Active adopted materials; inspect the parent and provide explicit references; no paid request was sent')
    const material = selected[0]
    if (material === undefined) return resolution('missing', '本角色没有已采用且 Active 的身份参考；保留无参考请求，不保证面孔连续。', [], input.parentAssetId)
    const sourceUrl = material.url ?? ''
    let address: URL
    try { address = new URL(sourceUrl) } catch (_error) {
      throw new JubianError('CONTRACT_CHANGED', 'Adopted character image requires a valid HTTPS reference URL; no paid request was sent')
    }
    if (address.protocol !== 'https:' || address.username || address.password || /[\s\\#]/u.test(sourceUrl)) {
      throw new JubianError('CONTRACT_CHANGED', 'Adopted character image requires a safe HTTPS reference URL; no paid request was sent')
    }
    return { references: [sourceUrl], identity_reference: { status: 'inherited', asset_id: input.parentAssetId,
      material_id: material.material_id, url: sourceUrl, reason: '使用本项目该角色唯一已采用的 Active 图作参考；生成结果仍须审图后确认出演。' } }
  }
}
