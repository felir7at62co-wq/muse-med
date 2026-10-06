/** Packaged update sources and byte identities used when retrying through a mirror. */
import { existsSync, readFileSync } from 'node:fs'
import type { AppUpdater, UpdateInfo } from 'electron-updater'

/** Public feed options accepted by the pinned Electron updater. */
export type DesktopUpdateSource = Parameters<AppUpdater['setFeedURL']>[0]

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop update: packaged source record must be an object')
  }
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error('desktop update: packaged source identifier is invalid')
  }
  return value
}

/**
 * Read a sealed two-source record; older applications without this record retain their existing feed.
 * @param path - Application resources file, never a renderer-selected path.
 * @param version - Installed application version required by the record.
 * @returns Primary generic feed followed by its GitHub fallback, or no override for older packages.
 */
export function loadDesktopUpdateSources(path: string, version: string): readonly DesktopUpdateSource[] {
  if (!existsSync(path)) return []
  const record = object(JSON.parse(readFileSync(path, 'utf8')))
  if (record.schemaVersion !== 1 || record.version !== version) {
    throw new Error('desktop update: packaged source record does not match the installed version')
  }
  const primary = object(record.primary)
  const fallback = object(record.fallback)
  const channel = text(primary.channel)
  if (primary.provider !== 'generic' || fallback.provider !== 'github' || fallback.channel !== channel
    || typeof primary.url !== 'string') throw new Error('desktop update: packaged sources are invalid')
  const url = new URL(primary.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
    throw new Error('desktop update: primary feed must use a public HTTPS directory')
  }
  return [
    { provider: 'generic', url: url.href, channel, useMultipleRangeRequest: false },
    { provider: 'github', owner: text(fallback.owner), repo: text(fallback.repo), channel },
  ]
}

/**
 * Identify the exact payload bytes described by a feed, independent of the mirror's URLs.
 * @param info - Version and file metadata returned by the updater.
 * @returns Comparable version, SHA-512 and size record.
 */
export function desktopUpdateIdentity(info: Pick<UpdateInfo, 'version'> & Partial<Pick<UpdateInfo, 'files'>>): string {
  if (!info.files?.length) throw new Error('desktop update: mirror metadata has no payload files')
  const files = info.files.map((file) => {
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(file.sha512) || !Number.isSafeInteger(file.size) || (file.size ?? 0) < 1) {
      throw new Error('desktop update: mirror metadata has invalid SHA-512 or size')
    }
    return `${file.sha512}:${file.size}`
  }).sort()
  return `${info.version}:${files.join(',')}`
}

/**
 * Classify availability failures without treating integrity, disk, or preparation errors as mirror failures.
 * @param error - Rejected updater operation.
 * @returns Whether another sealed source may be tried.
 */
export function isDesktopUpdateSourceUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && typeof error.code === 'string' && [
    'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
    'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  ].includes(error.code)) return true
  return 'statusCode' in error && typeof error.statusCode === 'number'
    && ([403, 404, 408, 429].includes(error.statusCode) || error.statusCode >= 500 && error.statusCode <= 599)
}
