/** Shared digest loop for episode files already opened and checked by their owner. */
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'

/**
 * Hash bytes from the descriptor's current position without closing it.
 * @param file - Caller-owned descriptor positioned at the beginning of the file.
 * @param signal - Cancellation checked before every read.
 * @returns SHA-256 hex and the exact number of bytes read.
 */
export async function hashEpisodeContents(file: FileHandle, signal?: AbortSignal): Promise<{ digest: string; bytes: number }> {
  const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
  let bytes = 0
  for (;;) {
    signal?.throwIfAborted()
    const read = await file.read(buffer, 0, buffer.length, null)
    if (read.bytesRead === 0) break
    hash.update(buffer.subarray(0, read.bytesRead))
    bytes += read.bytesRead
  }
  return { digest: hash.digest('hex'), bytes }
}
