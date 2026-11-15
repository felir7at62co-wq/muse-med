/**
 * Local Electron shell settings, loaded once per process independently of the Host.
 * Ownership: .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopSystemDnsSetResult } from './ipc.ts'

/** Resolved shell preferences; absent fields use the defaults without rewriting existing files. */
export interface DesktopSettings {
  readonly updates: {
    readonly allowTestAuthPopupWindow: boolean
  }
  readonly network: {
    readonly useSystemResolver: boolean
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDocument(raw: string): { document: Record<string, unknown>; settings: DesktopSettings } {
  const value: unknown = JSON.parse(raw)
  if (!record(value) || (value.updates !== undefined && !record(value.updates))
    || (value.network !== undefined && !record(value.network))) {
    throw new Error('expected a JSON object with optional updates and network objects')
  }
  const allow = value.updates?.allowTestAuthPopupWindow
  const resolver = value.network?.useSystemResolver
  if (allow !== undefined && typeof allow !== 'boolean') throw new Error('updates.allowTestAuthPopupWindow must be true or false')
  if (resolver !== undefined && typeof resolver !== 'boolean') throw new Error('network.useSystemResolver must be true or false')
  return {
    document: value,
    settings: { updates: { allowTestAuthPopupWindow: allow ?? false }, network: { useSystemResolver: resolver ?? false } },
  }
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
  try { return parseDocument(await readFile(join(userData, 'desktop', 'settings.json'), 'utf8')).settings.network.useSystemResolver } catch (error) {
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
 * Read shell settings, creating the default document exclusively when missing.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @returns Validated settings, or defaults when reading, creating or validating fails; changes require a restart.
 */
export function readDesktopSettings(userData: string): DesktopSettings {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  const defaults: DesktopSettings = { updates: { allowTestAuthPopupWindow: false }, network: { useSystemResolver: false } }
  try {
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
        // An existing document belongs to the user, including one created during initialization.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      raw = readFileSync(path, 'utf8')
    }
    return parseDocument(raw).settings
  } catch (error) {
    try {
      console.warn(`desktop settings: ${path}: using defaults because settings could not be loaded`, error)
    } catch (_logError) {
      // Diagnostic output is best effort; its failure must not make optional settings fatal.
      // TODO: Persist settings diagnostics when console output is unavailable, without blocking startup.
    }
    return defaults
  }
}
