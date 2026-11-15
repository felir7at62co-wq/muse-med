/** Streaming digest shared by the episode input and publication readers. */
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Sha256 } from './episode-delivery.ts'

/**
 * Read an opened episode input without changing descriptor ownership.
 * @param file - Descriptor positioned at the start, closed by its caller.
 * @param signal - Optional cancellation between reads.
 * @returns Exact SHA and byte count of the consumed input.
 */
export async function readEpisodeDigest(file: FileHandle, signal?: AbortSignal): Promise<{ sha256: Sha256; bytes: number }> {
  const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
  let bytes = 0
  while (true) {
    signal?.throwIfAborted()
    const read = await file.read(buffer, 0, buffer.length, null)
    if (read.bytesRead === 0) break
    hash.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead
  }
  return { sha256: brandString<Sha256>(hash.digest('hex')), bytes }
}
