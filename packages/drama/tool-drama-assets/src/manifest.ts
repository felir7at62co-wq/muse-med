/**
 * The project's own `assets_manifest.json`, read as the comparison's local side.
 *
 * The manifest is a durable-file boundary. The document itself, and the
 * `script_id` that decides what can be compared at all, still fail the call with
 * the path that failed — nothing can be read past them. Everything below them is
 * reported instead: the asset array, the lead-record array, and any record that
 * is not an object come back as issues beside every declaration that could be
 * read. This file is authored by a model and read by three tools, so refusing the
 * whole read would hide every other finding in it, and a caller cannot repair
 * what it cannot see.
 *
 * The id rule is the pipeline's own: `_tools/asset_reconcile.py` counts only
 * integer ids and this module keeps that rule, because an id spelled as a string
 * is a manifest defect this comparison must report as missing rather than
 * silently accept as covered.
 *
 * @module @deepseek-ai/dsh-tool-drama-assets/manifest
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JubianError, describePayload } from '@deepseek-ai/dsh-jubian'
import type { Manifest, ManifestIssue } from './types.ts'

/** The one file this package reads from a project. */
export const MANIFEST_FILE = 'assets_manifest.json'

/** The key names a manifest's asset array is read under, the project's own spelling first. */
const ASSET_ARRAY_KEYS = ['items', 'assets'] as const

/** The key a manifest's lead-character records are read under. */
const LEAD_ARRAY_KEY = 'lead_readonly_records'

/** Read one JSON object, or throw with the path that failed. */
function objectAt(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JubianError('CONTRACT_CHANGED', detail)
  }
  return value as Record<string, unknown>
}

/**
 * Read the object rows of one manifest array, reporting a record that is not an object.
 *
 * The record is skipped rather than thrown on: one unreadable row would otherwise
 * hide every other finding in the file, and its asset id counts for nothing here
 * either way.
 * @param value - The array read from the manifest.
 * @param key - The key it was read under, named in the issue.
 * @param path - Manifest path, named in every issue.
 * @param issues - The list every defect is appended to.
 * @returns The object rows, in file order.
 */
function rowsOf(value: readonly unknown[], key: string, path: string,
  issues: ManifestIssue[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  value.forEach((row, index) => {
    if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
      rows.push(row as Record<string, unknown>)
      return
    }
    issues.push({ code: 'manifest_record_unreadable',
      message: `${path} 的 ${key} 第 ${String(index + 1)} 条不是 JSON 对象（${describePayload(row)}）：`
        + '这一条被跳过，它声明的 jubian_asset_id 不计入清单，远端已有的同名资产会被报成未登记。'
        + '请把这一条改成对象，或从该数组里删掉。' })
  })
  return rows
}

/**
 * The asset rows one manifest declares, with the issue that names the key when it
 * declares none, or the spelling when it declares them under the older key.
 * @param record - The manifest's top level.
 * @param path - Manifest path, named in every issue.
 * @param issues - The list every defect is appended to.
 * @returns The declared asset rows, in file order.
 */
function assetRows(record: Record<string, unknown>, path: string,
  issues: ManifestIssue[]): Record<string, unknown>[] {
  // Both spellings are one file. `items` is the project's own key and the one the
  // pipeline's other readers were extended to accept; `assets` is the older
  // spelling the shot scripts wrote, read here so the comparison runs on the rows
  // the file actually declares instead of reporting every remote asset as
  // unregistered.
  const key = ASSET_ARRAY_KEYS.find(candidate => Array.isArray(record[candidate]))
  if (key === undefined) {
    issues.push({ code: 'manifest_items_missing',
      message: `${path} 缺少 items 资产数组（${describePayload(record)}）：资产数组接受 `
        + `${ASSET_ARRAY_KEYS.join(' / ')} 两个键名，本次两个键都不是数组——读成"一条资产都没有"会把远端已经存在的资产整批报成未登记。`
        + '把声明这些资产的数组写在 items 下后重跑。' })
    return []
  }
  const rows = rowsOf(record[key] as unknown[], key, path, issues)
  if (key !== ASSET_ARRAY_KEYS[0]) {
    issues.push({ code: 'manifest_items_spelling',
      message: `${path} 的资产数组写在 ${key} 键下：本次已按该键读入 ${String(rows.length)} 条记录继续对账，`
        + `但这份清单的规范键名是 ${ASSET_ARRAY_KEYS[0]}（${ASSET_ARRAY_KEYS.join(' / ')} 都读得到）。`
        + `把该数组改名为 ${ASSET_ARRAY_KEYS[0]} 后重跑，证据才会 ready。` })
  }
  return rows
}

/**
 * The lead-character rows one manifest declares, with the issue that names the
 * missing key when it declares none.
 * @param record - The manifest's top level.
 * @param path - Manifest path, named in every issue.
 * @param issues - The list every defect is appended to.
 * @returns The lead-character rows, in file order.
 */
function leadRows(record: Record<string, unknown>, path: string,
  issues: ManifestIssue[]): Record<string, unknown>[] {
  const value = record[LEAD_ARRAY_KEY]
  if (value === undefined) {
    issues.push({ code: 'lead_records_missing',
      message: `${path} 没有 ${LEAD_ARRAY_KEY} 数组：领读角色的资产同样算清单里声明过的资产，`
        + '缺了它会把远端已有的领读资产报成未登记（它们不是新资产，重新生成会重复付费）。'
        + `确实没有领读角色就写 "${LEAD_ARRAY_KEY}": []，再重跑。` })
    return []
  }
  if (!Array.isArray(value)) {
    issues.push({ code: 'lead_records_missing',
      message: `${path} 的 ${LEAD_ARRAY_KEY} 不是数组（${describePayload(value)}）：`
        + '读不成记录就把远端已有的领读资产报成未登记。'
        + `请写成数组，没有领读角色就写 "${LEAD_ARRAY_KEY}": []。` })
    return []
  }
  return rowsOf(value, LEAD_ARRAY_KEY, path, issues)
}

/**
 * Read one project's manifest.
 * @param projectDir - Resolved project directory holding `assets_manifest.json`.
 * @returns The project id and the two record arrays in file order, plus every declaration defect
 *   found while reading them.
 * @throws {JubianError} `CONTRACT_CHANGED` when the file is unreadable, is not JSON, is not an object,
 *   or carries no integer `script_id`.
 */
export async function readManifest(projectDir: string): Promise<ManifestRead> {
  const path = join(projectDir, MANIFEST_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch { throw new JubianError('CONTRACT_CHANGED', `${path} 读不到：project_dir 必须是含 ${MANIFEST_FILE} 的项目根目录`) }
  let document: unknown
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch { throw new JubianError('CONTRACT_CHANGED', `${path} 不是合法 JSON`) }
  const record = objectAt(document, `${path} 顶层不是 JSON 对象`)
  const scriptId = record['script_id']
  if (typeof scriptId !== 'number' || !Number.isSafeInteger(scriptId)) {
    throw new JubianError('CONTRACT_CHANGED',
      `${path} 缺少整数 script_id：远端读什么项目由它决定，不能在本地兜一个默认值`)
  }
  const issues: ManifestIssue[] = []
  const items = assetRows(record, path, issues)
  return { manifest: { script_id: scriptId, items, lead_readonly_records: leadRows(record, path, issues) }, issues }
}

/**
 * One project's manifest as the comparison reads it, with the defects it reports
 * instead of refusing the call.
 */
export interface ManifestRead {
  /** The declarations the comparison reads; a defect below leaves its array empty. */
  manifest: Manifest
  /** Every declaration defect found, in the order they were read; non-empty keeps the report unready. */
  issues: ManifestIssue[]
}

/** The integer id one manifest record declares, or null when it declares none. */
function assetIdOf(record: Record<string, unknown>): number | null {
  const value = record['jubian_asset_id']
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
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
