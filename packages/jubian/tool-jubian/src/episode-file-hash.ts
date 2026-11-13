/** SHA-256 reads for caller-owned episode file handles. */
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'

/**
 * Hash from the current offset through EOF without closing the handle.
 * Callers verify file identity and metadata before and after the read.
 * @param file - Open handle retained by the caller.
 * @param signal - When present, cancellation is checked before each read; absent means no cancellation.
 * @returns Hexadecimal SHA-256 and the number of bytes read.
 */
export async function hashEpisodeFileHandle(file: FileHandle, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
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
