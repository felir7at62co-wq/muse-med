/** Private, login-bound storage for explicitly distributed supplier credentials. */
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { readMuseSession } from './session.ts'

async function readAccess(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/**
 * Publish supplier access only while the requesting account revision remains current.
 * @param sessionFile - Account session whose writer lock serializes login changes.
 * @param baseUrl - Account gateway origin.
 * @param revision - Login revision that authorized the response.
 * @param providers - Validated supplier access, never a Session-log payload.
 * @param signal - Owner lifetime; cancellation prevents or removes this write before releasing the account lock.
 * @returns Whether the current account accepted the private file.
 */
export async function saveModelAccess(
  sessionFile: string, baseUrl: string, revision: string,
  providers: readonly { readonly id: string; readonly access: { readonly baseURL: string; readonly apiKey: string } }[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false
  return await withFileLock(sessionFile, async () => {
    const current = await readMuseSession(sessionFile, baseUrl)
    if (signal?.aborted || current?.revision !== revision) return false
    const file = join(dirname(sessionFile), 'model-access.json')
    await writeFileAtomic(file, `${JSON.stringify({ baseUrl, revision, providers })}\n`,
      { mode: 0o600, dirMode: 0o700 })
    if (signal?.aborted) {
      await rm(file, { force: true })
      return false
    }
    return true
  })
}

/**
 * Delete only this login's supplier file, or an orphan after sign-out.
 * @param sessionFile - Account session whose writer lock protects a newer login.
 * @param baseUrl - Account gateway origin.
 * @param revision - Previous login revision; omission removes only a signed-out orphan.
 * @param signal - Owner lifetime; cancellation leaves access intact if deletion has not started.
 */
export async function clearModelAccess(sessionFile: string, baseUrl: string, revision?: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  const file = join(dirname(sessionFile), 'model-access.json')
  if (await readAccess(file) === null) return
  await withFileLock(sessionFile, async () => {
    const text = await readAccess(file)
    if (text === null) return
    const stored: unknown = JSON.parse(text)
    const current = await readMuseSession(sessionFile, baseUrl)
    if (signal?.aborted) return
    if (typeof stored === 'object' && stored !== null && Reflect.get(stored, 'baseUrl') === baseUrl
      && (revision === undefined ? !current : Reflect.get(stored, 'revision') === revision)) {
      await rm(file, { force: true })
    }
  })
}
