/**
 * The project's own `assets_manifest.json`, read as the comparison's local side.
 *
 * The manifest is a durable-file boundary, so it is validated where it is read:
 * the document, its two record arrays, its `script_id`, and every
 * `jubian_asset_id`. The id is where the pipeline's own tools disagree with
 * themselves — `_tools/asset_reconcile.py` counts only integer ids and this
 * module keeps that rule, because an id spelled as a string is a manifest defect
 * this comparison must report as missing rather than silently accept as covered.
 *
 * @module @deepseek-ai/dsh-tool-drama-assets/manifest
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { Manifest } from './types.ts'

/** The one file this package reads from a project. */
export const MANIFEST_FILE = 'assets_manifest.json'

/** Read one JSON object, or throw with the path that failed. */
function objectAt(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JubianError('CONTRACT_CHANGED', detail)
  }
  return value as Record<string, unknown>
}

/** Read one record array, treating an absent one as empty. */
function rowsAt(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new JubianError('CONTRACT_CHANGED', '清单里 items / lead_readonly_records 必须是数组')
  return value.map(row => objectAt(row, '清单里有记录不是 JSON 对象'))
}

/** The integer id one manifest record declares, or null when it declares none. */
function assetIdOf(record: Record<string, unknown>): number | null {
  const value = record['jubian_asset_id']
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/**
 * Read one project's manifest.
 * @param projectDir - Resolved project directory holding `assets_manifest.json`.
 * @returns The project id and the two record arrays, in file order.
 * @throws {JubianError} `CONTRACT_CHANGED` when the file is unreadable, is not JSON, is not an object,
 *   carries no integer `script_id`, or carries a record array that is not an array of objects.
 */
export async function readManifest(projectDir: string): Promise<Manifest> {
  const path = join(projectDir, MANIFEST_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch { throw new JubianError('CONTRACT_CHANGED', `${path} 读不到：project_dir 必须是含 ${MANIFEST_FILE} 的项目根目录`) }
  let document: unknown
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
  } catch { throw new JubianError('CONTRACT_CHANGED', `${path} 不是合法 JSON`) }
  const record = objectAt(document, `${path} 顶层不是 JSON 对象`)
  const scriptId = record['script_id']
  if (typeof scriptId !== 'number' || !Number.isSafeInteger(scriptId)) {
    throw new JubianError('CONTRACT_CHANGED',
      `${path} 缺少整数 script_id：远端读什么项目由它决定，不能在本地兜一个默认值`)
  }
  return { script_id: scriptId, items: rowsAt(record['items']),
    lead_readonly_records: rowsAt(record['lead_readonly_records']) }
}

/**
 * Every asset id the manifest declares, from `items` and `lead_readonly_records`.
 * @param manifest - A manifest read by {@link readManifest}.
 * @returns The declared ids; a record without an integer id contributes nothing.
 */
export function manifestAssetIds(manifest: Manifest): Set<number> {
  const ids = new Set<number>()
  for (const record of [...manifest.items, ...manifest.lead_readonly_records]) {
    const id = assetIdOf(record)
    if (id !== null) ids.add(id)
  }
  return ids
}
