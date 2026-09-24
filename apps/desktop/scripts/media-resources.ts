/** Hash-locked resource acquisition, archive validation and inventory shared by desktop payload preparers. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import extractZip from 'extract-zip'

/** One public resource accepted only with the recorded size and SHA-256. */
export interface MediaResource { filename: string; url: string; bytes: number; sha256: string }

/** Reject paths that escape or alias installation files on Windows.
 * @param name - Archive member with POSIX separators.
 */
export function assertMediaArchivePath(name: string): void {
  const parts = name.replace(/\/$/u, '').split('/')
  if (name === '' || /[\\:\u0000-\u001f]/u.test(name) || parts.some(part =>
    part === '' || part === '.' || part === '..' || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error('media archive: unsafe member path')
  }
}

/** Check cached or downloaded bytes without modifying the file.
 * @param path - File to verify.
 * @param resource - Expected size and SHA-256.
 */
export async function verifyMediaResource(path: string, resource: MediaResource): Promise<void> {
  if ((await stat(path)).size !== resource.bytes) throw new Error(`media size mismatch: ${resource.filename}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== resource.sha256) throw new Error(`media checksum mismatch: ${resource.filename}`)
}

/**
 * Longest absolute path a payload stage may occupy.
 *
 * Windows rejects a module whose dependency resolution passes MAX_PATH, and the
 * payload nests a deep `site-packages` tree.
 */
const STAGE_PATH_LIMIT = 60

/**
 * Create the staging directory for a payload that will be renamed into `output`.
 *
 * A stage beside the output inherits the build's own depth, and a nested Python
 * payload then exceeds the Windows path limit while importing its extension
 * modules. The stage therefore starts at the output's volume root and walks
 * towards the output until one of those ancestors accepts the directory, which
 * keeps the payload short without leaving the volume `rename` requires.
 * @param output - Final directory the caller renames the stage into.
 * @returns Absolute path of a fresh staging directory.
 * @throws When no ancestor of the output accepts the directory.
 */
export async function shortStage(output: string): Promise<string> {
  const target = resolve(output)
  const volume = parse(target).root
  const name = `mb-${randomUUID().slice(0, 8)}`
  const candidates: string[] = []
  for (let base = dirname(target); ; base = dirname(base)) {
    candidates.push(base)
    if (base.length <= volume.length) break
  }
  candidates.sort((left, right) => left.length - right.length)
  for (const base of candidates) {
    const candidate = join(base, name)
    if (candidate.length > STAGE_PATH_LIMIT) continue
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') throw error
    }
  }
  throw new Error('media staging: no writable short staging directory on the output volume')
}

/** Obtain a locked artifact without replacing an existing mismatched cache entry.
 * @param resource - Public URL and required content identity.
 * @param cache - Existing download directory.
 * @returns Verified local artifact path.
 */
export async function obtain(resource: MediaResource, cache: string): Promise<string> {
  const path = join(cache, resource.filename)
  try { await stat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const temporary = `${path}.${randomUUID()}.part`
    try {
      const response = await fetch(resource.url, { signal: AbortSignal.timeout(30 * 60_000) })
      if (!response.ok || response.body === null) throw new Error(`media download failed: ${resource.filename}, HTTP ${response.status}`)
      let bytes = 0
      const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > resource.bytes) source.destroy(new Error(`media download exceeds locked size: ${resource.filename}`))
      })
      await pipeline(source, createWriteStream(temporary, { flags: 'wx' }))
      await verifyMediaResource(temporary, resource)
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  await verifyMediaResource(path, resource)
  return path
}

/** Extract a ZIP while rejecting links, special files and Windows path aliases.
 * @param path - Verified archive.
 * @param target - Absolute extraction directory.
 */
export async function unzip(path: string, target: string): Promise<void> {
  const names = new Set<string>()
  await mkdir(target, { recursive: true })
  await extractZip(path, { dir: target, onEntry(entry) {
    assertMediaArchivePath(entry.fileName)
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000
    if (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) throw new Error('media archive: links and special files refused')
    const key = entry.fileName.toLowerCase()
    if (names.has(key)) throw new Error('media archive: duplicate Windows member')
    names.add(key)
  } })
}

/** Run a preparer command and wait for its exit; failures reject.
 * @param binary - Executable path.
 * @param args - Explicit argument vector.
 * @param env - Scrubbed child environment.
 */
export function run(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', code => code === 0 ? accept() : reject(new Error(`media command failed (${String(code)}): ${binary}`)))
  })
}

/** Inventory regular payload files, rejecting symbolic links and special members.
 * @param root - Payload root.
 * @param relative - Current relative subdirectory.
 * @returns Sorted paths, sizes and content hashes.
 */
export async function inventory(root: string, relative = ''): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const output: Array<{ path: string; bytes: number; sha256: string }> = []
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('media payload: symbolic links refused')
    if (entry.isDirectory()) output.push(...await inventory(root, name))
    else if (entry.isFile()) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(join(root, name))) hash.update(chunk)
      output.push({ path: name, bytes: (await stat(join(root, name))).size, sha256: hash.digest('hex') })
    } else throw new Error('media payload: special files refused')
  }
  return output.sort((a, b) => a.path.localeCompare(b.path))
}
