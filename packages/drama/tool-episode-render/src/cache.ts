/** Content identities for prepared sources and successful per-shot encodes. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'

/**
 * Hash a local media file without buffering the whole video.
 * @param path - File whose bytes identify the selected source.
 * @returns Lowercase SHA-256 digest.
 */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Read an optional cache identity; unreadable files remain errors.
 * @param path - The identity sidecar.
 * @returns The saved identity, or empty on a cache miss.
 */
export async function readCacheIdentity(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}
