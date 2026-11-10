/** Streaming digest for an already opened episode file; callers own version checks and closing. */
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'

/**
 * Hash every remaining byte of one descriptor without changing its ownership.
 * @param file - Regular-file descriptor positioned by the caller.
 * @param signal - When supplied, cancellation is checked before each read; absent means no cancellation.
 * @returns SHA-256 and the exact number of bytes read.
 */
export async function readEpisodeFileDigest(file: FileHandle, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
  let bytes = 0
  while (true) {
    signal?.throwIfAborted()
    const read = await file.read(buffer, 0, buffer.length, null)
    if (read.bytesRead === 0) break
    hash.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead
  }
  return { sha256: hash.digest('hex'), bytes }
}
