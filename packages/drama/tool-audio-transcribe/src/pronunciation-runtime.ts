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
  readonly pythonPath: string
  readonly libraryDir: string
  readonly librarySha256: string
  readonly modelDir: string
}

export const sampleRate = 16_000
export const maxSourceBytes = 512 * 1024 * 1024
const runFile = promisify(execFile)

export async function digest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash, { signal })
  return hash.digest('hex')
}

function inside(root: string, child: string): boolean {
  const part = relative(root, child)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

export async function owned(path: string, dir: boolean, parent?: string): Promise<string> {
  const fail = (): Error => new Error('OFFLINE_ASR_SCOPE: Expected an existing regular local file or directory in the selected workspace.')
  if (parent !== undefined && !inside(parent, path)) throw fail()
  const entry = await lstat(path).catch(() => { throw fail() })
  const actual = await realpath(path).catch(() => { throw fail() })
  if (entry.isSymbolicLink() || (dir ? !entry.isDirectory() : !entry.isFile())
    || (parent !== undefined && !inside(parent, actual))) throw fail()
  return actual
}

/** Digest of the installed package files, sorted by slash-separated relative path. */
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

export async function verifyPinnedSpeechModel(dir: string, files: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> {
  for (const file of await readdir(dir)) {
    if (!Object.hasOwn(files, file) && file !== 'model-version.json') throw new Error('Unexpected file in the pinned model directory')
  }
  for (const [name, expected] of Object.entries(files)) {
    if (await digest(await owned(join(dir, name), false, dir), signal) !== expected) throw new Error('Offline model digest differs')
  }
}

export async function command(executable: string, args: string[], category: string, timeout: number, signal: AbortSignal): Promise<string> {
  try { return (await runFile(executable, args, { encoding: 'utf8', windowsHide: true, timeout, signal, maxBuffer: 1024 * 1024 })).stdout }
  catch {
    signal.throwIfAborted()
    throw new Error(`${category}: Local speech processing failed or exceeded its limit.`)
  }
}

/** Resolve and verify only deployment-provisioned local speech assets. */
export async function verifiedSpeechRuntime(runtime: OfflineSpeechConfig, files: Readonly<Record<string, string>>, signal: AbortSignal) {
  if (![runtime.pythonPath, runtime.libraryDir, runtime.modelDir].every(isAbsolute)
    || !/^[a-f0-9]{64}$/u.test(runtime.librarySha256)) throw new Error('Invalid deployment paths or digest')
  const python = await owned(runtime.pythonPath, false)
  const library = await owned(runtime.libraryDir, true)
  const models = await owned(runtime.modelDir, true)
  if (await offlineLibraryDigest(library, signal) !== runtime.librarySha256) throw new Error('Dependency digest differs')
  await verifyPinnedSpeechModel(models, files, signal)
  return { python, library, models }
}
