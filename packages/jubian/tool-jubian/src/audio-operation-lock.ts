/** Project audio deletion excludes local voice-binding writers while references are inspected. */
import { lstat, open, readdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { JubianError } from '@deepseek-ai/dsh-jubian'

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
function busy(): never {
  throw new JubianError('CONTRACT_CHANGED', 'Another project audio/bible writer holds a lock; wait for that writer before retrying the original operation')
}

/**
 * Refuse a card audio write while a project audio deletion holds its exclusion flag.
 * Call both before and after acquiring the card lock to cover competing acquisitions.
 * @param root - Validated canonical project directory shared by the writers.
 */
export async function assertNoAudioDeletion(root: string): Promise<void> {
  try { await lstat(join(root, '.audio-asset-delete.lock')) }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  busy()
}

async function acquire(path: string): Promise<FileHandle> {
  try { return await open(path, 'wx', 0o600) }
  catch (error) {
    if (hasCode(error, 'EEXIST')) busy()
    throw error
  }
}

/**
 * Exclude local card audio edits and project-bible changes through the full deletion readback.
 * Existing card writers cause refusal; different projects remain independent. The provider
 * console and other tools that do not participate in these locks are outside this exclusion.
 * @param root - Validated canonical project directory.
 * @param scriptId - Bound project whose card locks must be idle.
 * @param operation - Reference revalidation, one DELETE and actual absence readback.
 * @returns The completed operation result after releasing both owned locks.
 */
export async function withAudioDeletionLock<T>(root: string, scriptId: number, operation: () => Promise<T>): Promise<T> {
  const held: { path: string; file: FileHandle }[] = []
  const deletionPath = join(root, '.audio-asset-delete.lock')
  held.push({ path: deletionPath, file: await acquire(deletionPath) })
  try {
    const biblePath = join(root, '.project-bible.lock')
    held.push({ path: biblePath, file: await acquire(biblePath) })
    const prefix = `${scriptId}.`
    if ((await readdir(join(root, 'video_tasks'))).some(name => name.startsWith(prefix) && name.endsWith('.storyboard-audio.lock'))) busy()
    return await operation()
  } finally {
    const released = await Promise.allSettled(held.map(async ({ path, file }) => {
      try { await file.close() } finally { await unlink(path) }
    }))
    const failed = released.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
