/**
 * Desktop dependency order for the optional Feishu bridge.
 *
 * The setup service installs its startup activation hook before this entry
 * resolves Config. Only dependency metadata is composed here; the bridge's
 * editable credentials and policy remain in the bundle and user profile.
 * Legacy profile package guards migrate before the profile is loaded.
 *
 * @module @deepseek-ai/dsh-desktop-host/feishu-gate
 */

import type { Inject } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { FEISHU_CHANNEL_ROW_ID } from '@deepseek-ai/dsh-feishu-settings'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'

const NATIVE_IM_PACKAGE = '@xmanrui/dsh-im'
const LEGACY_IM_PACKAGES: ReadonlySet<string> = new Set(['@wenbin_wb/dsh-bridge', '@dsh-feishu/dsh-feishu'])

function legacyFeishuRows(contents: unknown): YAMLMap[] {
  if (!isSeq(contents)) throw new Error('muse-med: profile patch must be a YAML sequence')
  const rows: YAMLMap[] = []
  const inspectRow = (row: unknown): void => {
    if (!isMap(row)) return
    if (row.get('id') === FEISHU_CHANNEL_ROW_ID && LEGACY_IM_PACKAGES.has(String(row.get('name')))) rows.push(row)
    if (row.get('group') === true) {
      const children = row.get('config', true)
      if (isSeq(children)) children.items.forEach(inspectRow)
    }
  }
  for (const patch of contents.items) {
    if (!isMap(patch)) continue
    inspectRow(patch)
    const inserted = patch.get('insert', true)
    if (isSeq(inserted)) inserted.items.forEach(inspectRow)
  }
  return rows
}

async function readPatchDocument(path: string): Promise<{ before: string; document: ReturnType<typeof parseDocument> } | undefined> {
  let before: string
  try { before = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const document = parseDocument(before, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  if (document.errors.length > 0) throw new Error('muse-med: profile patch is not valid YAML')
  return { before, document }
}

/**
 * Migrate known legacy Feishu row names before Loader and ConfigEditor read the profile.
 * Credentials, policies and unrelated YAML nodes remain unchanged. A changed file
 * receives an exclusive owner-only backup before its atomic replacement.
 * @param projectDir - Desktop profile directory whose package manifest coordinates writes.
 * @param homeDir - Optional Harness home; legacy global guards are rejected without editing that shared file.
 * @returns The original-byte backup path, or undefined when no migration was needed.
 * @throws When profile YAML is invalid or its backup or replacement cannot be written.
 */
export async function migrateFeishuProfileName(projectDir: string, homeDir?: string): Promise<string | undefined> {
  return withFileLock(join(projectDir, 'package.json'), async () => {
    if (homeDir !== undefined && homeDir !== projectDir) {
      const homePatch = join(homeDir, 'cordis.patch.yml')
      const loaded = await readPatchDocument(homePatch)
      if (loaded !== undefined && legacyFeishuRows(loaded.document.contents).length > 0) {
        throw new Error(`muse-med: legacy Feishu package name in ${homePatch}; update its feishu-channel name to ${NATIVE_IM_PACKAGE} before starting Muse`)
      }
    }
    const path = join(projectDir, 'cordis.patch.yml')
    const loaded = await readPatchDocument(path)
    if (loaded === undefined) return undefined
    const { before, document } = loaded
    const rows = legacyFeishuRows(document.contents)
    if (rows.length === 0) return undefined
    const replacements = rows.map((row) => {
      const name = row.get('name', true)
      if (!isScalar(name) || name.range === undefined || name.range === null) throw new Error('muse-med: legacy Feishu package name must be a YAML scalar')
      const [start, end] = name.range
      return { start, end, value: before[start] === '"' ? JSON.stringify(NATIVE_IM_PACKAGE) : `'${NATIVE_IM_PACKAGE}'` }
    }).sort((left, right) => right.start - left.start)
    let after = before
    for (const { start, end, value } of replacements) after = after.slice(0, start) + value + after.slice(end)
    const backup = `${path}.muse-im-name.${randomUUID()}.bak`
    await writeFile(backup, before, { flag: 'wx', mode: 0o600 })
    await writeFileAtomic(path, after, { mode: 0o600 })
    return backup
  })
}

/** Entry id of the row holding the product switch. */
export { FEISHU_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-feishu-settings'

/** Entry id of the bundled Feishu bridge. */
export { FEISHU_CHANNEL_ROW_ID } from '@deepseek-ai/dsh-feishu-settings'

/** Entry metadata needed to order the bridge after its setup service. */
export interface FeishuGateRow {
  /** Entry id the composition patches by. */
  readonly id: string
  /** Existing dependencies and their service intercept configs. */
  readonly inject?: Inject<Record<string, unknown>> | null
}

/**
 * Require setup before the bundled IM configuration resolves.
 * @param rows - entries composed from preceding layers.
 * @returns the bridge dependency patch, or no patch when its entry is absent.
 */
export function feishuGateLayer(rows: readonly FeishuGateRow[]): PatchOptions[] {
  const row = rows.find(candidate => candidate.id === FEISHU_CHANNEL_ROW_ID)
  if (row === undefined) return []
  const inject: Inject<Record<string, unknown>> = Array.isArray(row.inject)
    ? [...new Set([...row.inject, 'feishuSetup'])]
    : { ...row.inject, feishuSetup: row.inject?.['feishuSetup'] ?? {} }
  return [{ id: FEISHU_CHANNEL_ROW_ID, inject }]
}
