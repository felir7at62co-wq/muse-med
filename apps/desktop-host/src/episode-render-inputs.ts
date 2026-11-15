/** Stable regular-file capture and exclusive private staging for episode renders. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as nodeFs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Sha256 } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'

// Descriptor identity requires physical metadata, including when Electron has patched node:fs.
const { lstat, open, readdir, realpath, unlink } = process.versions.electron === undefined ? nodeFs
  : (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises

/** Exact bytes captured from one canonical regular file. */
export interface EpisodeFileFact {
  readonly path: string
  readonly sha256: Sha256
  readonly bytes: number
}

/**
 * Hash a complete regular file without a provider download-size ceiling.
 * @param path - Canonical local file selected by its owning project or runtime.
 * @param signal - Owning capture lifetime.
 * @returns Actual file bytes and SHA-256 after stable descriptor/path checks.
 */
export async function inspectEpisodeFile(path: string, signal: AbortSignal): Promise<EpisodeFileFact> {
  return await transfer(path, signal)
}

/**
 * Copy verified bytes into one new private stage path, refusing occupied targets.
 * @param source - Exact input facts captured by the owning project or runtime.
 * @param target - New file inside the caller-owned private execution directory.
 * @param signal - Owning execution lifetime.
 * @returns The staged file's actual facts after source identity and hash checks.
 */
export async function stageEpisodeFile(source: EpisodeFileFact, target: string, signal: AbortSignal): Promise<EpisodeFileFact> {
  return await transfer(source.path, signal, { target, expected: source })
}

async function transfer(path: string, signal: AbortSignal,
  copy?: { readonly target: string; readonly expected: EpisodeFileFact }): Promise<EpisodeFileFact> {
  signal.throwIfAborted()
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('Episode input must be a canonical regular file')
  }
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output: Awaited<ReturnType<typeof open>> | undefined
  let complete = false
  try {
    const opened = await input.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Episode input changed while opening')
    if (copy !== undefined) output = await open(copy.target, 'wx', 0o600)
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let bytes = 0
    for (;;) {
      signal.throwIfAborted()
      const part = await input.read(buffer, 0, buffer.length, null)
      if (part.bytesRead === 0) break
      const chunk = buffer.subarray(0, part.bytesRead)
      hash.update(chunk); bytes += chunk.length
      if (output !== undefined) await output.writeFile(chunk)
    }
    const after = await input.stat(), current = await lstat(path)
    if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) {
      throw new Error('Episode input changed while reading')
    }
    const sha256 = brandString<Sha256>(hash.digest('hex'))
    if (copy !== undefined && (sha256 !== copy.expected.sha256 || bytes !== copy.expected.bytes)) {
      throw new Error('Episode input differs from its captured facts')
    }
    complete = true
    return { path: copy?.target ?? path, sha256, bytes }
  } finally {
    await input.close()
    if (output !== undefined) {
      await output.close()
      if (!complete && copy !== undefined) await unlink(copy.target)
    }
  }
}

/**
 * Capture all regular runtime font files; links and changed directory entries fail.
 * @param root - Captured deployment font directory, independent of the project root.
 * @param maxEntries - Validated deployment limit for this directory traversal.
 * @param signal - Owning capture lifetime.
 * @returns Sorted exact facts for every file the staged font directory exposes.
 */
export async function captureEpisodeDirectory(root: string, maxEntries: number, signal: AbortSignal): Promise<readonly EpisodeFileFact[]> {
  const directory = await realpath(root), facts: EpisodeFileFact[] = []
  let entries = 0
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    const before = await lstat(path)
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(path) !== path) throw new Error('Episode runtime directory must be canonical')
    const names = (await readdir(path)).sort()
    for (const name of names) {
      if (++entries > maxEntries) throw new Error('Episode runtime directory exceeds the configured entry limit')
      const child = join(path, name), info = await lstat(child)
      if (info.isDirectory() && !info.isSymbolicLink()) await visit(child)
      else facts.push(await inspectEpisodeFile(child, signal))
    }
    const after = await lstat(path)
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Episode runtime directory changed while reading')
    }
  }
  await visit(directory)
  if (facts.length === 0) throw new Error('Episode runtime font directory is empty')
  return facts
}
