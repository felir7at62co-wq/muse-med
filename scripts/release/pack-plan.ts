/**
 * Content-hash reuse decisions for the release pack step.
 *
 * `pnpm pack` rewrites a tarball from the working tree, so repacking a package
 * nothing changed costs the same minutes as packing one that changed. This
 * module decides, per member, whether the recorded inputs still describe the
 * tarball standing beside them, and the pack step keeps that tarball when they
 * do.
 *
 * A member's digest covers its own pack inputs, the packer that wrote them, and
 * the input digests of every family member it depends on — so a dependency
 * packed from new content invalidates its consumers even though their own files
 * never moved ([rationale](../../.agents/notes/implemented/process/2026-09-27-packaging-resume-and-unchanged-package-skip.md)).
 */

import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

/** Record format version, which a reader refuses to interpret when it differs. */
const PACK_MANIFEST_FORMAT = 1

/** Root names npm packs whatever `files` lists, matching npm-packlist's own set. */
const ALWAYS_PACKED_PATTERN = /^(?:readme|copying|licen[cs]e|notice|changes|changelog|history)(?:\..*)?$/iu

/** Directory names no package publishes, skipped when a declared path is a directory. */
const NEVER_PACKED_DIRECTORIES = new Set(['node_modules', '.git'])

/** One file a package would publish: where it lands in the tarball and where it is read. */
interface PackInputFile {
  /** Package-relative path the tarball carries. */
  readonly path: string
  /** Absolute path the digest reads. */
  readonly source: string
}

/** The pack inputs of one member and the digest that names them. */
export interface PackInputs {
  /** Package-relative paths the digest covers, sorted. */
  readonly files: readonly string[]
  /** Lowercase hex SHA-256 over the sorted paths and their contents. */
  readonly sha256: string
}

/** One member's row in a pack manifest. */
export interface PackManifestMember {
  readonly name: string
  readonly version: string
  /** Tarball filename this run leaves in the destination. */
  readonly tarball: string
  /** Byte length of that tarball. */
  readonly bytes: number
  /** Content digest of that tarball. */
  readonly sha256: string
  /** Digest of the member's own pack inputs. */
  readonly inputSha256: string
  /** The digest a later run compares: inputs, packer, and dependency inputs. */
  readonly digest: string
  /** Number of input files the digest covers. */
  readonly fileCount: number
  /** Whether those inputs covered every path the packed tarball carries. */
  readonly inputsMatchPayload: boolean
}

/** What one pack run leaves beside the tarballs it produced or reused. */
export interface PackManifest {
  readonly formatVersion: number
  readonly family: string
  readonly commit: string
  /** The package manager that wrote the tarballs, from the root manifest. */
  readonly packageManager: string
  readonly members: readonly PackManifestMember[]
}

/**
 * The manifest filename one release family writes into its pack destination.
 * @param familyId - release family identifier.
 * @returns The filename, which ends in `.json` so tarball readers ignore it.
 */
export function packManifestFile(familyId: string): string {
  return `release-pack-${familyId}.json`
}

/** Walk every file below one directory, skipping trees no package publishes. */
function walkFiles(directory: string, prefix: string, found: Map<string, PackInputFile>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (NEVER_PACKED_DIRECTORIES.has(entry.name)) continue
      walkFiles(join(directory, entry.name), `${prefix}${entry.name}/`, found)
      continue
    }
    if (!entry.isFile()) continue
    const path = `${prefix}${entry.name}`
    found.set(path, { path, source: join(directory, entry.name) })
  }
}

/** The `files` patterns a manifest declares, or undefined when it publishes the whole directory. */
function declaredPatterns(manifest: Readonly<Record<string, unknown>>): string[] | undefined {
  const files = manifest.files
  if (!Array.isArray(files)) return undefined
  const patterns = files.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return patterns.length === 0 ? undefined : patterns
}

/** The `main` and `bin` targets npm packs in addition to the declared `files`. */
function entryTargets(manifest: Readonly<Record<string, unknown>>): string[] {
  const targets: string[] = []
  if (typeof manifest.main === 'string') targets.push(manifest.main)
  const bin = manifest.bin
  if (typeof bin === 'string') targets.push(bin)
  else if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    for (const value of Object.values(bin)) if (typeof value === 'string') targets.push(value)
  }
  return targets.map(target => target.replace(/^\.\//u, '').replaceAll('\\', '/'))
}

/**
 * Collect every file `pnpm pack` reads from one package directory.
 *
 * The set is deliberately a superset: a declared path that is a directory
 * contributes its whole subtree, and the names npm always packs are added even
 * when `files` omits them. Hashing a file the packer would skip only costs a
 * repack; missing one would reuse a tarball that no longer matches its inputs.
 *
 * `pnpm pack` fills a missing license file from the workspace root, so that root
 * file is an input of every package that has none of its own.
 * @param directory - absolute package directory.
 * @param manifest - the package's parsed manifest.
 * @param options - the workspace root's license file, which the packer injects when the package has none.
 * @returns Package-relative paths, sorted, and their digest.
 */
export function collectPackInputs(
  directory: string,
  manifest: Readonly<Record<string, unknown>>,
  options: { readonly workspaceLicense?: string | undefined } = {},
): PackInputs {
  const found = new Map<string, PackInputFile>()
  const patterns = declaredPatterns(manifest)
  if (patterns === undefined) {
    walkFiles(directory, '', found)
  } else {
    for (const pattern of patterns) {
      for (const match of globSync([pattern], { cwd: directory })) {
        const absolute = join(directory, match)
        const stats = statSync(absolute, { throwIfNoEntry: false })
        if (stats === undefined) continue
        const path = match.replaceAll('\\', '/')
        if (stats.isDirectory()) walkFiles(absolute, `${path}/`, found)
        else if (stats.isFile()) found.set(path, { path, source: absolute })
      }
    }
    for (const match of globSync(['*'], { cwd: directory })) {
      const name = match.replaceAll('\\', '/')
      if (name !== 'package.json' && !ALWAYS_PACKED_PATTERN.test(name)) continue
      const absolute = join(directory, name)
      if (found.has(name) || statSync(absolute, { throwIfNoEntry: false })?.isFile() !== true) continue
      found.set(name, { path: name, source: absolute })
    }
    for (const name of entryTargets(manifest)) {
      const absolute = join(directory, name)
      if (found.has(name) || statSync(absolute, { throwIfNoEntry: false })?.isFile() !== true) continue
      found.set(name, { path: name, source: absolute })
    }
  }
  const localLicense = [...found.keys()].find(name => !name.includes('/') && /^licen[cs]e(?:\..*)?$/iu.test(name))
  const workspaceLicense = options.workspaceLicense
  if (localLicense === undefined && workspaceLicense !== undefined
    && statSync(workspaceLicense, { throwIfNoEntry: false })?.isFile() === true) {
    const path = basename(workspaceLicense)
    found.set(path, { path, source: workspaceLicense })
  }
  // Code-unit order, so a digest computed anywhere names the same sequence.
  const files = [...found.values()].sort((left, right) => (left.path < right.path ? -1 : 1))
  if (files.length === 0) {
    throw new Error(`release pack: ${relative(process.cwd(), directory) || directory} has no packable input`)
  }
  const digest = createHash('sha256')
  for (const file of files) {
    const content = readFileSync(file.source)
    digest.update(`${Buffer.byteLength(file.path)}:`)
    digest.update(file.path)
    digest.update(`${content.byteLength}:`)
    digest.update(content)
  }
  return { files: files.map(file => file.path), sha256: digest.digest('hex') }
}

/**
 * Hash the inputs, the packer, and the dependency inputs into the value a later
 * run compares.
 * @param input - the member's own input digest, its family dependencies, and the packer identity.
 * @returns Lowercase hex SHA-256.
 */
export function memberDigest(input: {
  readonly inputSha256: string
  readonly dependencies: readonly { readonly name: string; readonly inputSha256: string }[]
  readonly packageManager: string
}): string {
  const digest = createHash('sha256')
  digest.update(`packer\0${input.packageManager}\0inputs\0${input.inputSha256}\0`)
  for (const dependency of [...input.dependencies].sort((left, right) => left.name.localeCompare(right.name))) {
    digest.update(`dep\0${dependency.name}\0${dependency.inputSha256}\0`)
  }
  return digest.digest('hex')
}

/**
 * Hash one file's content.
 * @param path - absolute file path.
 * @returns Lowercase hex SHA-256.
 */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Whether a member's recorded inputs still describe the tarball beside them. */
export interface PackDecision {
  /** Whether the pack step keeps the recorded tarball. */
  readonly reuse: boolean
  /** Why, printed for every member so the decision is auditable. */
  readonly reason: string
}

/**
 * Decide whether one member's recorded inputs still describe its tarball.
 * @param input - the recorded row, the current digest, and the tarball path.
 * @returns The decision and the fact that decided it.
 */
export function decideMemberPack(input: {
  readonly previous: PackManifestMember | undefined
  readonly filename: string
  readonly digest: string
  readonly tarball: string
}): PackDecision {
  const { previous, filename, digest, tarball } = input
  if (previous === undefined) return { reuse: false, reason: 'no recorded inputs' }
  if (previous.tarball !== filename) return { reuse: false, reason: `recorded tarball ${previous.tarball}` }
  if (previous.digest !== digest) return { reuse: false, reason: 'inputs, packer, or a dependency changed' }
  if (!previous.inputsMatchPayload) {
    return { reuse: false, reason: 'the recorded inputs did not cover the packed payload' }
  }
  if (!existsSync(tarball)) return { reuse: false, reason: 'the recorded tarball is gone' }
  const sha256 = fileSha256(tarball)
  if (sha256 !== previous.sha256) return { reuse: false, reason: 'the tarball no longer matches its record' }
  return { reuse: true, reason: `unchanged since ${previous.digest.slice(0, 12)}` }
}

/**
 * Read a pack manifest, tolerating the absence or corruption of a prior run's file.
 * @param path - absolute manifest path.
 * @returns The parsed manifest, or undefined when no usable record exists.
 */
export function readPackManifest(path: string): PackManifest | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const manifest = parsed as PackManifest
  if (manifest.formatVersion !== PACK_MANIFEST_FORMAT || !Array.isArray(manifest.members)) return undefined
  return manifest
}

/** The manifest a finished run writes beside its tarballs. */
export function newPackManifest(input: {
  readonly family: string
  readonly commit: string
  readonly packageManager: string
  readonly members: readonly PackManifestMember[]
}): PackManifest {
  return {
    formatVersion: PACK_MANIFEST_FORMAT,
    family: input.family,
    commit: input.commit,
    packageManager: input.packageManager,
    members: input.members,
  }
}
