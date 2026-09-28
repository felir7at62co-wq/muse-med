/** Product-home session storage shared by the Host and its read-only MCP child. */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { MuseAccountIdentity } from './gateway.ts'

/** Stored gateway cookie and confirmed account identity for one origin. */
export interface MuseStoredSession extends MuseAccountIdentity {
  readonly baseUrl: string
  readonly cookie: string
  readonly revision: string
}

/**
 * Read one origin-bound session, ignoring a session from a different origin.
 * @param file - Product-home account session path.
 * @param baseUrl - Current gateway origin.
 * @returns Stored session or null when absent or bound to another origin.
 */
export async function readMuseSession(file: string, baseUrl: string): Promise<MuseStoredSession | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('muse-account: stored session is not an object')
  }
  const fields = value as Record<string, unknown>
  if (fields.baseUrl !== baseUrl) return null
  if (typeof fields.cookie !== 'string' || !/^__Host-muse=[^;\s]+$/u.test(fields.cookie)
    || typeof fields.username !== 'string' || fields.username.length === 0
    || typeof fields.revision !== 'string' || fields.revision.length === 0) {
    throw new Error('muse-account: stored session has invalid account fields')
  }
  return {
    baseUrl,
    cookie: fields.cookie,
    revision: fields.revision,
    username: fields.username,
    ...(typeof fields.environment === 'string' ? { environment: fields.environment } : {}),
    ...(typeof fields.workspaceLabel === 'string' ? { workspaceLabel: fields.workspaceLabel } : {}),
  }
}

/**
 * Serialize replacement with conditional deletion across Host processes.
 * @param file - Product-home account session path.
 * @param session - Confirmed account identity and gateway cookie.
 */
export async function writeMuseSession(file: string, session: Omit<MuseStoredSession, 'revision'>): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await withFileLock(file, async () => {
    await writeFileAtomic(file, `${JSON.stringify({ ...session, revision: randomUUID() })}\n`, { mode: 0o600, dirMode: 0o700 })
  })
}

/**
 * Remove only the session read before a network operation, under the writer lock.
 * @param file - Product-home account session path.
 * @param expected - Session whose cookie was rejected or signed out.
 * @returns Whether that exact session was removed.
 */
export async function clearMuseSessionIfUnchanged(file: string, expected: MuseStoredSession): Promise<boolean> {
  return await withFileLock(file, async () => {
    const current = await readMuseSession(file, expected.baseUrl)
    if (current?.revision !== expected.revision) return false
    await rm(file, { force: true })
    return true
  })
}
