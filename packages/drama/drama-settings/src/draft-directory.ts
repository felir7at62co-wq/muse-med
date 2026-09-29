/** Validated Jianying draft-root access over the same namespace as the Settings page. */
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import type SettingsForms from '@deepseek-ai/dsh-settings'
import { DRAMA_SETTINGS_NAMESPACE, type DramaSettings } from './settings.ts'

/**
 * Read the current root or validate and persist a user-supplied root, then read it back.
 * @param settings - Settings provider owning the drama namespace.
 * @param path - Existing absolute editor root to save; omitted reads without writing.
 * @returns Validated root, or an unconfigured result for an empty setting.
 */
export async function draftDirectory(settings: SettingsForms, path?: string): Promise<{ status: 'ready' | 'unconfigured'; path: string }> {
  const read = () => {
    const row = settings.describe().find(candidate => candidate.ns === DRAMA_SETTINGS_NAMESPACE)
    if (!row) throw new Error('Drama settings are unavailable.')
    return { row, path: (row.value as DramaSettings).jianyingDraftDir }
  }
  const before = read()
  const candidate = path === undefined ? before.path : path.trim()
  if (!candidate && path === undefined) return { status: 'unconfigured', path: '' }
  if (!candidate || !isAbsolute(candidate)) throw new Error('Jianying draft root must be an existing absolute directory.')
  const resolved = normalize(candidate)
  if (!(await stat(resolved)).isDirectory()) throw new Error('Jianying draft root must be a directory.')
  await access(resolved, constants.R_OK | constants.W_OK)
  if (path !== undefined) {
    await settings.update(DRAMA_SETTINGS_NAMESPACE, { jianyingDraftDir: resolved }, before.row.revision)
    if (read().path !== resolved) throw new Error('Jianying draft root was not saved; read Settings and retry.')
  }
  return { status: 'ready', path: resolved }
}
