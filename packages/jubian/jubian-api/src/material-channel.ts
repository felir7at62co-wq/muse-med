import { JubianError } from '@deepseek-ai/dsh-jubian'

/** IDs from one registration of a subject image in a generation channel. */
export interface MaterialChannelIds {
  extAssetId: string
  extGroupId: string
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new JubianError('CONTRACT_CHANGED', 'Invalid material channel ID')
  return value.trim() || undefined
}

/**
 * Read the stored values independently so an incomplete save can be repaired.
 * @param row - A saved image material.
 * @returns Each nonblank channel ID the row supplies.
 * @throws {JubianError} When a supplied ID is not a string.
 */
export function materialChannelValues(row: Record<string, unknown>): Partial<MaterialChannelIds> {
  const extAssetId = optionalId(row.extAssetId), extGroupId = optionalId(row.extGroupId)
  return { ...(extAssetId === undefined ? {} : { extAssetId }), ...(extGroupId === undefined ? {} : { extGroupId }) }
}

/**
 * Read one complete channel registration.
 * @param row - A channel-capable image material or parent asset.
 * @returns The pair of channel IDs, or undefined when both IDs are absent.
 * @throws {JubianError} When a row supplies only one ID or a nontext ID.
 */
export function readMaterialChannelIds(row: Record<string, unknown>): MaterialChannelIds | undefined {
  const { extAssetId, extGroupId } = materialChannelValues(row)
  if (extAssetId === undefined && extGroupId === undefined) return undefined
  if (extAssetId === undefined || extGroupId === undefined) {
    throw new JubianError('CONTRACT_CHANGED', 'Incomplete material channel IDs')
  }
  return { extAssetId, extGroupId }
}

/**
 * Read the channel registration from the validated current subject and parent asset.
 * @param subject - The selected active subject row.
 * @param parent - The corresponding official parent asset.
 * @returns A complete pair from one source, or undefined if neither supplies one.
 * @throws {JubianError} When a source is malformed or their complete pairs disagree.
 */
export function resolveMaterialChannelIds(subject: Record<string, unknown>,
  parent: Record<string, unknown>): MaterialChannelIds | undefined {
  const subjectIds = readMaterialChannelIds(subject), parentIds = readMaterialChannelIds(parent)
  if (subjectIds !== undefined && parentIds !== undefined
    && (subjectIds.extAssetId !== parentIds.extAssetId || subjectIds.extGroupId !== parentIds.extGroupId)) {
    throw new JubianError('CONTRACT_CHANGED', 'Conflicting material channel IDs on the selected subject and its parent')
  }
  return subjectIds ?? parentIds
}
