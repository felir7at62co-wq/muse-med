/** Startup policy for optional Electron shell preferences, independent of the Host. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopSystemDnsSetResult } from './ipc.ts'
import { DesktopSettingsFile, type DesktopUpdatePreferences } from './settings-file.ts'

/** Resolved startup preferences; individual field failures do not disable unrelated choices. */
export interface DesktopSettings {
  readonly updates: Pick<DesktopUpdatePreferences, 'allowTestAuthPopupWindow'>
  readonly network: { readonly useSystemResolver: boolean }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSettingsDocument(value: unknown): { document: Record<string, unknown>; useSystemResolver: boolean } {
  if (!record(value) || (value.updates !== undefined && !record(value.updates))
    || (value.network !== undefined && !record(value.network))) {
    throw new Error('expected a JSON object with optional updates and network objects')
  }
  const resolver = value.network?.useSystemResolver
  if (resolver !== undefined && typeof resolver !== 'boolean') throw new Error('network.useSystemResolver must be true or false')
  return { document: value, useSystemResolver: resolver ?? false }
}

function parseDocument(raw: string): { document: Record<string, unknown>; useSystemResolver: boolean } {
  const value: unknown = JSON.parse(raw)
  return parseSettingsDocument(value)
}

/**
 * Prefer the system resolver when selected after Electron is ready.
 * @param settings - startup settings snapshot.
 * @param configure - Electron host resolver configuration.
 */
export function configureDesktopHostResolver(settings: DesktopSettings,
  configure: (options: { enableBuiltInResolver: boolean }) => void): void {
  if (settings.network.useSystemResolver) configure({ enableBuiltInResolver: false })
}

/**
 * Store the DNS preference without replacing unrelated user settings.
 * @param userData - Electron-owned userData directory.
 * @param enabled - whether the next process prefers the system resolver.
 */
export async function setDesktopSystemDns(userData: string, enabled: boolean): Promise<void> {
  const directory = join(userData, 'desktop'), path = join(directory, 'settings.json')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    let raw: string
    try { raw = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      raw = '{}'
    }
    const { document } = parseDocument(raw)
    const network = record(document.network) ? document.network : {}
    document.network = { ...network, useSystemResolver: enabled }
    await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  })
}

/**
 * Read the persisted DNS preference without hiding malformed or inaccessible files.
 * @param userData - Electron-owned userData directory.
 * @returns The preference to apply at the next startup.
 */
export async function readDesktopSystemDns(userData: string): Promise<boolean> {
  try { return parseDocument(await readFile(join(userData, 'desktop', 'settings.json'), 'utf8')).useSystemResolver } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Save a DNS preference and distinguish confirmed failure from an unknown outcome.
 * @param userData - Electron-owned userData directory.
 * @param active - resolver preference applied at this startup.
 * @param enabled - preference to store for the next startup.
 * @returns The committed or read-back value, or an unknown outcome if it cannot be read.
 */
export async function setDesktopSystemDnsStatus(userData: string, active: boolean, enabled: boolean): Promise<DesktopSystemDnsSetResult> {
  try {
    await setDesktopSystemDns(userData, enabled)
    return { saved: enabled, active }
  } catch (_error) {
    try {
      const saved = await readDesktopSystemDns(userData)
      return saved === enabled ? { saved, active } : { saved, active, saveFailed: true }
    } catch (_readError) {
      return { unknown: true }
    }
  }
}

/**
 * Initialize the shared document explicitly at startup, then resolve popup and DNS preferences.
 * @param userData - Electron userData, independent of DSH_HOME.
 * @returns Validated preferences, defaulting each failed field with a diagnostic; changes require restart.
 */
export async function readDesktopSettings(userData: string): Promise<DesktopSettings> {
  const file = new DesktopSettingsFile(userData)
  const result = await file.initialize()
  const preference = result.kind === 'ready' ? result.fields.allowTestAuthPopupWindow : undefined
  const error = result.kind === 'error' ? result.error : preference?.kind === 'invalid' ? preference.error : undefined
  const report = (failure: Error): void => {
    try { console.warn(`desktop settings: ${file.path}: using defaults because settings could not be loaded`, failure) } catch (_logError) {
      // Optional preferences retain safe defaults even when diagnostic output is unavailable.
    }
  }
  if (error) report(error)
  let useSystemResolver = false
  if (result.kind === 'ready') {
    try { useSystemResolver = parseSettingsDocument(result.document).useSystemResolver } catch (failure) {
      if (!(failure instanceof Error)) throw failure
      report(failure)
    }
  }
  return {
    updates: { allowTestAuthPopupWindow: preference?.kind === 'valid' ? preference.value : false },
    network: { useSystemResolver },
  }
}
