/** SHA-256 reads for caller-owned episode file handles. */
import type { FileHandle } from 'node:fs/promises'
import { readEpisodeDigest } from './episode-digest.ts'

/**
 * Hash from the current offset through EOF without closing the handle.
 * Callers verify file identity and metadata before and after the read.
 * @param file - Open handle retained by the caller.
 * @param signal - When present, cancellation is checked before each read; absent means no cancellation.
 * @returns Hexadecimal SHA-256 and the number of bytes read.
 */
export async function hashEpisodeFileHandle(file: FileHandle, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  return await readEpisodeDigest(file, signal)
}
