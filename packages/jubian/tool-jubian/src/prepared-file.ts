/** Project-bound reads of fingerprint-named prepared edits and deletion plans. */
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { JubianError } from '@deepseek-ai/dsh-jubian'

/**
 * Read JSON only from the named operation's canonical preview in the bound project.
 * @param root - Resolved project directory whose provider binding was verified.
 * @param key - Lowercase SHA-256 preview fingerprint supplied as the idempotency key.
 * @param source - Caller-supplied preview location.
 * @param operation - Operation owning the prepared filename.
 * @returns Parsed JSON for the operation's fingerprint and field validation.
 * @throws {JubianError} `CONTRACT_CHANGED` for a mismatched path/key, linked source or unreadable JSON.
 */
export async function readPreparedJson(root: string, key: string, source: string,
  operation: 'storyboard-edit' | 'storyboard-delete' | 'storyboard-audio' | 'audio-asset-delete' | 'model-settings'): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new JubianError('CONTRACT_CHANGED', 'Prepared preview path/key mismatch')
  const directory = join(root, 'video_tasks')
  const path = join(directory, `${key}.${operation}.prepared.json`)
  if (resolve(source) !== path) throw new JubianError('CONTRACT_CHANGED', 'Prepared preview path/key mismatch')
  try {
    for (const directoryPath of [root, directory]) {
      const entry = await lstat(directoryPath)
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new JubianError('CONTRACT_CHANGED', 'Prepared preview directory must be a real directory')
    }
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isFile()) throw new JubianError('CONTRACT_CHANGED', 'Prepared preview must be a regular file')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof JubianError) throw error
    throw new JubianError('CONTRACT_CHANGED', 'Cannot read canonical prepared preview')
  }
}
