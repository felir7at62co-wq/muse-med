/** Deployment-owned local speech assets, bounded process execution, and project path checks. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

/** Provisioned assets. The model never supplies executable or package paths. */
export interface OfflineSpeechConfig {
  /** Absolute path to the deployment-provisioned Python executable. */
  readonly pythonPath: string
  /** Absolute path to the verified directory containing the local speech runtime dependencies. */
  readonly libraryDir: string
  /** Lowercase SHA-256 digest of the dependency tree, ordered by relative file path. */
  readonly librarySha256: string
  /** Absolute path to the local model directory containing the pinned model files. */
  readonly modelDir: string
}

/** PCM sample rate required by the offline speech models. */
export const sampleRate = 16_000
/** Maximum source media size accepted by offline speech tools. */
export const maxSourceBytes = 512 * 1024 * 1024
const runFile = promisify(execFile)

/**
 * Hash a local file without reading it all into memory.
 * @param path - Local file to read.
 * @param signal - Cancels the file read.
 * @returns Lowercase SHA-256 digest.
 */
export async function digest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash, { signal })
  return hash.digest('hex')
}

function inside(root: string, child: string): boolean {
  const part = relative(root, child)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

/**
 * Resolve an existing regular file or directory and reject symlink aliases.
 * @param path - Local filesystem path to check.
 * @param dir - Whether the path must be a directory.
 * @param parent - Optional canonical directory that must contain the path before and after resolution.
 * @returns Canonical path to the verified entry.
 */
export async function owned(path: string, dir: boolean, parent?: string): Promise<string> {
  const fail = (): Error => new Error('OFFLINE_ASR_SCOPE: Expected an existing regular local file or directory in the selected workspace.')
  if (parent !== undefined && !inside(parent, path)) throw fail()
  const entry = await lstat(path).catch(() => { throw fail() })
  const actual = await realpath(path).catch(() => { throw fail() })
  if (entry.isSymbolicLink() || (dir ? !entry.isDirectory() : !entry.isFile())
    || (parent !== undefined && !inside(parent, actual))) throw fail()
  return actual
}

/**
 * Hash each installed package file in slash-separated relative path order.
 * @param root - Canonical root of the runtime dependency tree.
 * @param signal - Cancels directory traversal and file reads.
 * @returns Lowercase SHA-256 digest of the relative file paths and their digests.
 */
export async function offlineLibraryDigest(root: string, signal: AbortSignal): Promise<string> {
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      signal.throwIfAborted()
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(await owned(path, true, root))
      else files.push(relative(root, await owned(path, false, root)).replaceAll(sep, '/'))
    }
  }
  await visit(root)
  const hash = createHash('sha256')
  for (const file of files.sort()) hash.update(file + '\0' + await digest(join(root, file), signal) + '\n')
  return hash.digest('hex')
}

/**
 * Reject missing, changed or unexpected files in the pinned model directory.
 * @param dir - Canonical local model directory.
 * @param files - Required filenames and their expected SHA-256 digests.
 * @param signal - Cancels file reads.
 */
export async function verifyPinnedSpeechModel(dir: string, files: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> {
  for (const file of await readdir(dir)) {
    if (!Object.hasOwn(files, file) && file !== 'model-version.json') throw new Error('Unexpected file in the pinned model directory')
  }
  for (const [name, expected] of Object.entries(files)) {
    if (await digest(await owned(join(dir, name), false, dir), signal) !== expected) throw new Error('Offline model digest differs')
  }
}

/**
 * Run one local speech program with bounded output and a deadline.
 * @param executable - Deployment-provisioned program path.
 * @param args - Arguments passed directly to the program.
 * @param category - Offline tool error code used for process failures.
 * @param timeout - Maximum process duration in milliseconds.
 * @param signal - Cancels the process and preserves the caller's cancellation reason.
 * @returns Captured UTF-8 standard output.
 */
export async function command(executable: string, args: string[], category: string, timeout: number, signal: AbortSignal): Promise<string> {
  try { return (await runFile(executable, args, { encoding: 'utf8', windowsHide: true, timeout, signal, maxBuffer: 1024 * 1024 })).stdout }
  catch {
    signal.throwIfAborted()
    throw new Error(`${category}: Local speech processing failed or exceeded its limit.`)
  }
}

/**
 * Resolve and verify only deployment-provisioned local speech assets.
 * @param runtime - Trusted paths and dependency-tree digest.
 * @param files - Required model filenames and their expected SHA-256 digests.
 * @param signal - Cancels validation of the speech assets.
 * @returns Canonical paths to Python, its dependency tree and the pinned model.
 */
export async function verifiedSpeechRuntime(runtime: OfflineSpeechConfig, files: Readonly<Record<string, string>>,
  signal: AbortSignal): Promise<{ python: string; library: string; models: string }> {
  if (![runtime.pythonPath, runtime.libraryDir, runtime.modelDir].every(isAbsolute)
    || !/^[a-f0-9]{64}$/u.test(runtime.librarySha256)) throw new Error('Invalid deployment paths or digest')
  const python = await owned(runtime.pythonPath, false)
  const library = await owned(runtime.libraryDir, true)
  const models = await owned(runtime.modelDir, true)
  if (await offlineLibraryDigest(library, signal) !== runtime.librarySha256) throw new Error('Dependency digest differs')
  await verifyPinnedSpeechModel(models, files, signal)
  return { python, library, models }
}
