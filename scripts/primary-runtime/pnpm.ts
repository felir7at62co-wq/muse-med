/** Assemble the pinned pnpm wrapper and its platform executable for offline use. */

import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { x as extractTar } from 'tar'
import lock from './pnpm-lock.json' with { type: 'json' }

/** Platform names supported by the shared runtime. */
export type PnpmRuntimeTarget = keyof typeof lock.targets

/**
 * Copy the published wrapper without package-manager-generated local shims.
 * @param wrapper - Installed pnpm package directory.
 * @param destination - Directory receiving the wrapper files.
 * @returns Resolves after the wrapper has been copied.
 */
export async function copyPnpmWrapper(wrapper: string, destination: string): Promise<void> {
  const generated = new Set(['node_modules', 'pnpm', 'pn', 'pnpx', 'pnx', 'pnpm.exe', 'pn.exe', 'pnpx.exe', 'pnx.exe'])
  await cp(wrapper, destination, {
    recursive: true,
    dereference: true,
    filter: source => !generated.has(source.slice(wrapper.length + 1)),
  })
}

/**
 * Extract already-verified archive bytes without reopening their shared cache path.
 * @param bytes - Archive bytes previously checked against the runtime lock.
 * @param destination - Directory receiving the platform package.
 * @returns Resolves after extraction and private temporary-file cleanup.
 */
export async function unpackVerifiedPnpmArchive(bytes: Uint8Array, destination: string): Promise<void> {
  const extraction = await mkdtemp(join(tmpdir(), 'dsh-pnpm-archive-'))
  try {
    const verifiedArchive = join(extraction, 'verified.tgz')
    await writeFile(verifiedArchive, bytes, { mode: 0o600 })
    await extractTar({ file: verifiedArchive, cwd: destination, strip: 1 })
  } finally { await rm(extraction, { recursive: true, force: true }) }
}

/**
 * Copy pnpm and a hash-verified executable into an isolated, offline runtime.
 * @param target - Platform of the runtime being assembled.
 * @param destination - Directory receiving the pnpm package.
 * @param cache - Directory holding verified executable archives.
 * @returns Version of the bundled pnpm package.
 */
export async function preparePnpmRuntime(target: PnpmRuntimeTarget, destination: string, cache: string): Promise<string> {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('pnpm/package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string; optionalDependencies?: Record<string, string> }
  const artifact = lock.targets[target]
  if (manifest.version !== lock.version || manifest.optionalDependencies?.[artifact.package] !== lock.version) {
    throw new Error(`primary runtime: pnpm ${manifest.version} does not match locked executable ${artifact.package}@${lock.version}`)
  }
  const expectedDigest = artifact.integrity.slice('sha512-'.length)
  const cacheName = Buffer.from(expectedDigest, 'base64').toString('hex')
  await mkdir(cache, { recursive: true })
  const archive = join(cache, cacheName)
  let bytes: Buffer
  let downloaded = false
  try { bytes = await readFile(archive) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const response = await fetch(artifact.url)
    if (!response.ok) throw new Error(`primary runtime download: ${String(response.status)} ${artifact.url}`)
    bytes = Buffer.from(await response.arrayBuffer())
    downloaded = true
  }
  if (createHash('sha512').update(bytes).digest('base64') !== expectedDigest) {
    throw new Error(`primary runtime download: checksum mismatch for ${artifact.url}`)
  }
  if (downloaded) {
    const staging = await mkdtemp(join(cache, 'pnpm-download-'))
    try {
      const temporary = join(staging, 'archive')
      await writeFile(temporary, bytes)
      await rename(temporary, archive)
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  await rm(destination, { recursive: true, force: true })
  await copyPnpmWrapper(dirname(manifestPath), destination)
  const packageDir = join(destination, 'node_modules', ...artifact.package.split('/'))
  await mkdir(packageDir, { recursive: true })
  await unpackVerifiedPnpmArchive(bytes, packageDir)
  const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as { name: string; version: string }
  if (installed.name !== artifact.package || installed.version !== lock.version) {
    throw new Error(`primary runtime: unexpected pnpm executable package for ${target}`)
  }
  return manifest.version
}
