/**
 * Packs this machine's DSH product into the release payload a Windows installer
 * downloads: seven `.tar.zst` archives plus the `manifest.json` beside them.
 *
 * Packaging is the only place slimming happens. Nothing under a source root is
 * deleted: excluded members are filtered out of the archive and their bytes are
 * reported, so the exclusion set stays reversible and re-measurable.
 *
 * Those source roots are the real trees this machine runs from, and they hold
 * NTFS junctions (the profile stores point at the workspace, a vendor tree, or
 * an npm cache). Every walk follows links to the content they reach, so an
 * archive holds real files and never a link.
 *
 * Compression uses Node's own zstd and a minimal tar writer, because the
 * repository's `tar` package is a transitive dependency of `apps/desktop` and is
 * not resolvable from `scripts/`.
 *
 * Usage:
 *   tsx scripts/release/pack-release.ts --plan-only
 *   tsx scripts/release/pack-release.ts --build --out E:\dsh-release\0.1.6-alpha.1 [--only bgm]
 *   tsx scripts/release/pack-release.ts --verify E:\dsh-release\0.1.6-alpha.1
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { writeTarZst } from './tar-zstd.ts'
import type { WrittenArchive } from './tar-zstd.ts'

/** One member an archive will hold: where it is read from and where it lands. */
interface PlannedFile {
  /** Archive-relative path, POSIX separators, no trailing slash. */
  readonly name: string
  /** Absolute path of the real file whose bytes the archive stores. */
  readonly source: string
  /** Size in bytes the header declares; reading must produce exactly this. */
  readonly size: number
  /** Permission bits the header declares. */
  readonly mode: number
}

/** A directory the archive names explicitly, so empty ones survive extraction. */
interface PlannedDir {
  /** Archive-relative path, POSIX separators, no trailing slash. */
  readonly name: string
  /** Permission bits the header declares. */
  readonly mode: number
}

/** One source tree (or single file) mapped into a pack's archive namespace. */
interface Mount {
  /** Absolute path of the tree or file to read. */
  readonly from: string
  /** Archive-relative prefix the mount's members land under; '' means the root. */
  readonly into: string
  /**
   * Decides whether one member below the mount is admitted. The mount root is
   * always descended into, so a filter never prunes the tree the caller named.
   */
  readonly accept?: (rel: string) => boolean
}

/** A path rule that removes members, applied to every pack or to one pack. */
interface Exclusion {
  /** Short label the plan reports saved bytes against. */
  readonly label: string
  /** True when the rule removes this archive-relative path. */
  readonly matches: (rel: string) => boolean
  /** True when the rule removes directories, so the walk can prune subtrees. */
  readonly dir?: boolean
}

/** One entry of the release payload. */
interface PackSpec {
  /** Stable identifier used by `--only` and shown in the plan. */
  readonly id: string
  /** Filename template; `{version}` is replaced by the resolved release version. */
  readonly nameTemplate: string
  /** Install-root-relative directory the installer extracts the archive into. */
  readonly unpackTo: string
  /** Source trees this pack draws from. */
  readonly mounts: readonly Mount[]
  /** Pack-specific exclusions applied after the default set. */
  readonly exclusions: readonly Exclusion[]
}

/** Skipped files and bytes for one exclusion label. */
interface ExcludedTotals {
  /** Number of skipped files. */
  readonly files: number
  /** Summed source bytes of skipped files. */
  readonly bytes: number
}

/** A pack's inventory after walking its sources and applying exclusions. */
interface PackPlan {
  /** Filename the pack is written as. */
  readonly name: string
  /** Install-root-relative extraction directory from the design table. */
  readonly unpackTo: string
  /** Files in archive order. */
  readonly files: readonly PlannedFile[]
  /** Directories the archive names. */
  readonly dirs: readonly PlannedDir[]
  /** Summed source bytes of `files`. */
  readonly originalBytes: number
  /** Removed bytes per exclusion label. */
  readonly excluded: ReadonlyMap<string, ExcludedTotals>
  /** Absolute paths of links that could not be read, skipped and reported. */
  readonly brokenLinks: readonly string[]
}

/** One row of the plan table. */
interface PlanRow {
  /** Pack specification. */
  readonly pack: PackSpec
  /** Inventory, absent when the pack could not be planned. */
  readonly plan: PackPlan | undefined
  /** Failure message when planning did not complete. */
  readonly error: string | undefined
}

/** One pack's record in `manifest.json`. */
interface ManifestPack {
  /** Archive filename. */
  readonly name: string
  /** Exact size on disk of the written archive. */
  readonly bytes: number
  /** Lowercase hex sha256 of the written archive. */
  readonly sha256: string
  /** True for every pack in the current payload. */
  readonly required: boolean
  /** Install-root-relative extraction directory. */
  readonly unpackTo: string
}

/** The installer's single entry point, stored beside the archives. */
interface Manifest {
  /** Release version every archive name carries. */
  readonly release: string
  /** ISO8601 build timestamp. */
  readonly builtAt: string
  /** Pack records, in payload order. */
  readonly packs: readonly ManifestPack[]
}

/** Raised for conflicts that must stop a build rather than drop a file. */
class PlanError extends Error {}

/** Workspace packages whose names resolve inside the workspace, not a store. */
const WORKSPACE_SCOPES = ['@deepseek-ai/dsh-', '@deepseek-ai/cordis']

/** Default output root; E: because 2.7 GB of input must not be written to C:. */
const DEFAULT_OUT_ROOT = 'E:\\dsh-release'

/** The workspace this script packs, derived from its own location. */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

/** Windows user profile holding the DSH home, caches, and profile stores. */
const HOME = process.env['USERPROFILE'] ?? ''

/** Junction farm of the web profile — the plugin payload's real source. */
const PROFILE_MODULES = join(HOME, '.dsh', 'profiles', 'web', 'node_modules')

/** Skills whose bundled ffmpeg copies never ship: the tools pack owns ffmpeg. */
const SKILLS_EXCLUSIONS: readonly Exclusion[] = [
  { label: 'tweet-drama-draft-build/tools/ffmpeg/*.exe', matches: rel => rel.endsWith('.exe') && rel.split('/').includes('ffmpeg') },
]

/** Rules that remove members from every pack, in plan-reporting order. */
const DEFAULT_EXCLUSIONS: readonly Exclusion[] = [
  { label: '*.lib', matches: rel => rel.endsWith('.lib') },
  { label: 'include/', matches: rel => rel.split('/').includes('include'), dir: true },
  { label: '__pycache__/', matches: rel => rel.split('/').includes('__pycache__'), dir: true },
  { label: '*.pyc', matches: rel => rel.endsWith('.pyc') },
  { label: '_archived/', matches: rel => rel.split('/').includes('_archived'), dir: true },
  { label: '*.map', matches: rel => rel.endsWith('.map') },
  { label: '.git/', matches: rel => rel.split('/').includes('.git'), dir: true },
  {
    label: 'node_modules/.cache/',
    matches: rel => rel.split('/').some((segment, index, all) => segment === '.cache' && all[index - 1] === 'node_modules'),
    dir: true,
  },
]

/** The seven package entries of the release payload, in manifest order. */
const PACKS: readonly PackSpec[] = [
  {
    id: 'app',
    nameTemplate: 'dsh-app-{version}-win-x64.tar.zst',
    unpackTo: 'app/',
    mounts: [],
    exclusions: [],
  },
  {
    id: 'plugins',
    nameTemplate: 'dsh-plugins-{version}.tar.zst',
    unpackTo: 'profiles/web/node_modules/',
    mounts: [{ from: PROFILE_MODULES, into: '' }],
    exclusions: [],
  },
  {
    id: 'python',
    nameTemplate: 'dsh-python-{version}.tar.zst',
    unpackTo: 'runtime/python/',
    mounts: [{ from: 'E:\\aa-manju\\M2E-verify\\.venv', into: '' }],
    exclusions: [],
  },
  {
    id: 'bgm',
    nameTemplate: 'dsh-capability-bgm-{version}.tar.zst',
    unpackTo: 'perception/hf-cache/',
    mounts: [
      { from: join(HOME, '.dsh', 'perception', 'hf-cache'), into: '' },
      { from: join(HOME, '.dsh', 'perception', 'bgm', 'J_all.ckpt'), into: 'J_all.ckpt' },
    ],
    exclusions: [],
  },
  {
    id: 'whisper',
    nameTemplate: 'dsh-model-whisper-{version}.tar.zst',
    unpackTo: 'runtime/whisper/',
    mounts: [{ from: join(HOME, '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-small'), into: '' }],
    exclusions: [],
  },
  {
    id: 'skills',
    nameTemplate: 'dsh-skills-{version}.tar.zst',
    unpackTo: 'skills/',
    mounts: [{ from: join(HOME, '.dsh', 'skills'), into: '' }],
    exclusions: SKILLS_EXCLUSIONS,
  },
  {
    id: 'ffmpeg',
    nameTemplate: 'dsh-ffmpeg-{version}-win-x64.tar.zst',
    unpackTo: 'tools/ffmpeg/',
    // Only the two executables travel; everything else beside them is excluded.
    mounts: [{ from: join(HOME, 'AppData', 'Local', 'ffmpeg', 'bin'), into: '', accept: rel => /^(ffmpeg|ffprobe)\.exe$/iu.test(rel) }],
    exclusions: [],
  },
]

/** Content rules `--verify` asserts against a written archive. */
interface ArchiveRules {
  /** Archive-relative shapes that must not appear. */
  readonly banned?: readonly { readonly label: string; readonly test: (name: string) => boolean }[]
  /** A shape that must appear exactly once. */
  readonly exactlyOnce?: { readonly label: string; readonly test: (name: string) => boolean }
}

/** Per-pack content assertions, keyed by pack id. */
const ARCHIVE_RULES: ReadonlyMap<string, ArchiveRules> = new Map<string, ArchiveRules>([
  ['python', {
    banned: [
      { label: '*.lib', test: name => name.endsWith('.lib') },
      { label: 'include/', test: name => name.split('/').includes('include') },
      { label: '__pycache__/', test: name => name.split('/').includes('__pycache__') },
      { label: '*.pyc', test: name => name.endsWith('.pyc') },
    ],
  }],
  ['skills', {
    banned: [
      { label: '_archived/', test: name => name.split('/').includes('_archived') },
      { label: '__pycache__/', test: name => name.split('/').includes('__pycache__') },
      // The tools pack ships ffmpeg once; the skills copies never travel.
      { label: 'bundled ffmpeg executables', test: name => name.endsWith('.exe') && name.split('/').includes('ffmpeg') },
    ],
  }],
  ['ffmpeg', {
    // Exactly one copy each, so the payload never ships ffmpeg twice.
    exactlyOnce: { label: 'ffmpeg.exe', test: name => name.toLowerCase().endsWith('ffmpeg.exe') },
  }],
])

/** Parsed command line. */
interface Invocation {
  /** Requested mode. */
  readonly mode: 'plan' | 'build' | 'verify'
  /** `--out` for build mode, or the directory to verify. */
  readonly directory: string
  /** Optional `--only` substring filter over pack ids. */
  readonly only: string | undefined
  /** Optional `--release` version override. */
  readonly release: string | undefined
}

/**
 * List the workspace packages that carry built output.
 * @returns Absolute package directories in path order.
 */
async function workspacePackages(): Promise<string[]> {
  const found: string[] = []
  for (const group of await readdir(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(REPO_ROOT, 'packages', group.name)
    for (const item of await readdir(groupDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      found.push(join(groupDir, item.name))
    }
  }
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * Read a package's declared runtime dependencies.
 * @param directory - Absolute package directory.
 * @returns Dependency names, excluding workspace-internal ones already mounted.
 */
async function runtimeDependencies(directory: string): Promise<string[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const { dependencies } = parsed as { dependencies?: unknown }
  if (dependencies === null || typeof dependencies !== 'object') return []
  return Object.keys(dependencies)
    .filter(name => !WORKSPACE_SCOPES.some(scope => name.startsWith(scope)))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * Resolve a dependency the way Node does, by walking parent directories.
 * @param from - Absolute directory the import happens in.
 * @param name - Package name to resolve.
 * @returns The real path of the installed package, or null when absent.
 */
async function resolveInstalled(from: string, name: string): Promise<string | null> {
  let at = from
  for (;;) {
    const candidate = join(at, 'node_modules', name)
    try {
      await stat(candidate)
      return await realpath(resolve(candidate))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
    }
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
}

/**
 * Resolve the runtime node_modules closure the built output imports.
 *
 * Every distinct installed copy is mounted under `node_modules/<name>` at the
 * archive root, which is where Node looks for an import from any workspace
 * package's `lib/`. A second copy of the same name is mounted beside the first
 * under a numbered suffix, so two versions coexist without either overwriting
 * the other. No file is stored twice and no store internals are reproduced.
 * @param packages - Workspace package directories carrying built output.
 * @returns One mount per distinct installed package.
 */
async function closureMounts(packages: readonly string[]): Promise<Mount[]> {
  const mounts: Mount[] = []
  const claimed = new Set<string>()
  const taken = new Set<string>()
  const queue: { readonly from: string; readonly name: string }[] = []
  for (const directory of packages) {
    for (const name of await runtimeDependencies(directory)) queue.push({ from: directory, name })
  }
  while (queue.length > 0) {
    const next = queue.pop()
    if (next === undefined) break
    const installed = await resolveInstalled(next.from, next.name)
    if (installed === null || claimed.has(installed)) continue
    claimed.add(installed)
    let into = `node_modules/${next.name}`
    for (let suffix = 1; taken.has(into); suffix++) into = `node_modules/${next.name}-${String(suffix)}`
    taken.add(into)
    mounts.push({ from: installed, into })
    for (const name of await runtimeDependencies(installed)) queue.push({ from: installed, name })
    // A package can keep its own pinned copies (or a bundler's optimized deps)
    // in a nested store; Node resolves those by name, so they travel too.
    for (const name of await nestedPackages(installed)) queue.push({ from: installed, name })
  }
  return mounts
}

/**
 * List the package names installed directly inside a package's nested store.
 * @param directory - Absolute package directory.
 * @returns Dependency names, scoped names expanded and `.bin` skipped.
 */
async function nestedPackages(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(directory, 'node_modules'), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(join(directory, 'node_modules', entry.name), { withFileTypes: true })) {
        names.push(`${entry.name}/${scoped.name}`)
      }
    } else {
      names.push(entry.name)
    }
  }
  return names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * Build the app pack's mounts: built output plus the closure it imports.
 *
 * Only `lib/` and `package.json` travel from the workspace, so sources, test
 * fixtures, and build config stay out of the payload.
 * @returns Mounts covering `packages/`, the apps, and the runtime closure.
 */
async function appMounts(): Promise<Mount[]> {
  const packages = await workspacePackages()
  const built: string[] = []
  for (const directory of packages) {
    try {
      await stat(join(directory, 'lib'))
      built.push(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // Mount roots admit `package.json` and everything below `lib/`; every other
  // subtree is pruned before it is read.
  const rootPrefixes = packages.map(directory => relative(join(REPO_ROOT, 'packages'), directory).split(sep).join('/'))
  const libPrefixes = built.map(directory => `${relative(join(REPO_ROOT, 'packages'), directory).split(sep).join('/')}/lib`)
  const inPackages = (rel: string, prefixes: readonly string[]): boolean =>
    prefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))
  const closure = await closureMounts(built)
  const mounts: Mount[] = [
    {
      from: join(REPO_ROOT, 'packages'),
      into: 'packages',
      accept: (rel) => {
        const parent = rel.slice(0, rel.lastIndexOf('/'))
        if (rel.endsWith('/package.json') && rootPrefixes.includes(parent)) return true
        return inPackages(rel, libPrefixes)
      },
    },
    { from: join(REPO_ROOT, 'apps', 'cli'), into: 'apps/cli' },
    { from: join(REPO_ROOT, 'apps', 'web', 'dist'), into: 'apps/web/dist' },
    { from: join(REPO_ROOT, 'apps', 'web', 'package.json'), into: 'apps/web/package.json' },
    { from: join(REPO_ROOT, 'package.json'), into: 'package.json' },
    ...closure,
  ]
  return mounts
}

/**
 * List the mounts a pack draws from, resolving the app pack's closure on demand.
 * @param pack - Pack to describe.
 * @returns The pack's mounts.
 */
async function mountsFor(pack: PackSpec): Promise<readonly Mount[]> {
  return pack.id === 'app' ? await appMounts() : pack.mounts
}

/**
 * Write one pack as a zstd-compressed tar archive.
 * @param outFile - Absolute path to write.
 * @param plan - Inventory produced by the planning walk.
 * @returns The written archive's size and content hash.
 */
async function writePack(outFile: string, plan: PackPlan): Promise<WrittenArchive> {
  return await writeTarZst(outFile, plan.unpackTo.replace(/\/$/u, ''), plan.dirs, plan.files)
}

/**
 * Judge one directory against a pack's exclusion set.
 * @param rel - Archive-relative directory path.
 * @param exclusions - Default rules followed by the pack's own.
 * @returns The matching label, or undefined to descend.
 */
function prune(rel: string, exclusions: readonly Exclusion[]): string | undefined {
  return exclusions.find(rule => rule.dir === true && rule.matches(rel))?.label
}

/**
 * Judge one file against a pack's exclusion set.
 * @param rel - Archive-relative file path.
 * @param exclusions - Default rules followed by the pack's own.
 * @returns The matching label, or undefined to pack the file.
 */
function classify(rel: string, exclusions: readonly Exclusion[]): string | undefined {
  return exclusions.find(rule => rule.matches(rel))?.label
}

/**
 * Walk one mount, following junctions and symlinks to the content they reach.
 *
 * Every admitted file claims its real path: a second pack claiming the same
 * real file is a conflict, and a conflict stops the plan instead of shipping
 * the file twice.
 * @param pack - Pack being planned, for exclusion selection and messages.
 * @param mount - Source tree or file and its archive prefix.
 * @param exclusions - Combined default and pack-specific rules.
 * @param claim - Real-path claims shared across every pack.
 * @param seen - Real paths of directories this pack already entered, so a link
 * cycle is visited once instead of walked to the filesystem's depth limit.
 * @param addFile - Receives each admitted file under its archive path.
 * @param totals - Accumulates skipped bytes per label.
 * @param broken - Receives absolute paths of links that could not be read.
 */
async function walkMount(
  pack: PackSpec,
  mount: Mount,
  exclusions: readonly Exclusion[],
  claim: Map<string, string>,
  seen: Set<string>,
  addFile: (file: PlannedFile, archivePath: string) => void,
  totals: Map<string, ExcludedTotals>,
  broken: string[],
): Promise<void> {
  const skip = (label: string, bytes: number): void => {
    const prior = totals.get(label) ?? { files: 0, bytes: 0 }
    totals.set(label, { files: prior.files + 1, bytes: prior.bytes + bytes })
  }
  const isLoop = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ELOOP'

  const visit = async (source: string, rel: string): Promise<void> => {
    const archivePath = mount.into === '' ? rel : rel === '' ? mount.into : `${mount.into}/${rel}`
    let info
    try {
      info = await lstat(source)
    } catch (error) {
      if (isLoop(error)) {
        broken.push(source)
        return
      }
      throw error
    }
    // Junctions and symlinks are read through, never stored: the archive holds
    // the target's bytes under the link's own name.
    if (info.isSymbolicLink()) {
      try {
        info = await stat(source)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isLoop(error)) {
          broken.push(source)
          return
        }
        throw error
      }
    }
    if (info.isDirectory()) {
      if (rel !== '' && prune(archivePath, exclusions) !== undefined) return
      if (rel !== '' && mount.accept?.(rel) === false) return
      let real
      try {
        real = await realpath(source)
      } catch (error) {
        if (isLoop(error)) {
          broken.push(source)
          return
        }
        throw error
      }
      // A directory reached twice is either a link cycle or the same subtree
      // under a second name; both are already packed, so one visit is enough.
      if (seen.has(real)) return
      seen.add(real)
      if (!claim.has(real)) claim.set(real, `${pack.id}:${archivePath}/`)
      const children = await readdir(source, { withFileTypes: true })
      // readdir order is filesystem order; sorting keeps a rebuild reproducible.
      children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      for (const child of children) await visit(join(source, child.name), rel === '' ? child.name : `${rel}/${child.name}`)
      return
    }
    if (!info.isFile() || rel === '') return
    if (mount.accept?.(rel) === false) return
    const label = classify(archivePath, exclusions)
    if (label !== undefined) {
      skip(label, info.size)
      return
    }
    let real
    try {
      real = await realpath(source)
    } catch (error) {
      if (isLoop(error)) {
        broken.push(source)
        return
      }
      throw error
    }
    const held = claim.get(real)
    if (held !== undefined && !held.startsWith(`${pack.id}:`)) {
      throw new PlanError(`${source} is already claimed by ${held} and by ${pack.id}:${archivePath}`)
    }
    claim.set(real, `${pack.id}:${archivePath}`)
    addFile({ name: archivePath, source: real, size: info.size, mode: info.mode & 0o777 }, archivePath)
  }

  await visit(mount.from, '')
}

/**
 * Build one pack's inventory from its mounts.
 * @param pack - Pack to plan.
 * @param version - Resolved release version for the archive filename.
 * @param claim - Real-path claims shared across packs.
 * @returns The pack's inventory.
 */
async function planPack(pack: PackSpec, version: string, claim: Map<string, string>): Promise<PackPlan> {
  const exclusions = [...DEFAULT_EXCLUSIONS, ...pack.exclusions]
  const files = new Map<string, PlannedFile>()
  const dirs = new Map<string, PlannedDir>()
  const totals = new Map<string, ExcludedTotals>()
  const broken: string[] = []
  const seen = new Set<string>()

  const addFile = (file: PlannedFile, archivePath: string): void => {
    if (files.has(file.name)) throw new PlanError(`${pack.id} would store ${file.name} twice`)
    files.set(file.name, file)
    const segments = archivePath.split('/')
    for (let depth = 1; depth < segments.length; depth++) {
      const name = segments.slice(0, depth).join('/')
      if (!dirs.has(name)) dirs.set(name, { name, mode: 0o755 })
    }
  }

  for (const mount of await mountsFor(pack)) await walkMount(pack, mount, exclusions, claim, seen, addFile, totals, broken)
  const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
  return {
    name: pack.nameTemplate.replace('{version}', version),
    unpackTo: pack.unpackTo,
    files: [...files.values()].sort((left, right) => order(left.name, right.name)),
    // tar lists a directory after siblings that sort before its trailing slash.
    dirs: [...dirs.values()].sort((left, right) => order(`${left.name}/`, `${right.name}/`)),
    originalBytes: [...files.values()].reduce((sum, file) => sum + file.size, 0),
    excluded: totals,
    brokenLinks: broken,
  }
}

/**
 * Render the human review table: one row per pack, with every exclusion's cost.
 * @param rows - One row per pack, in payload order.
 * @param version - Resolved release version.
 * @returns The table as printable text ending in a newline.
 */
function renderPlan(rows: readonly PlanRow[], version: string): string {
  const lines = [`release ${version}`, '']
  lines.push(['pack'.padEnd(10), 'archive'.padEnd(40), 'source', 'files'.padStart(9), 'raw MB'.padStart(11), 'excluded MB'.padStart(13), 'unpackTo'].join(' '))
  let totalFiles = 0
  let totalRaw = 0
  let totalCut = 0
  for (const row of rows) {
    const source = row.pack.id === 'app'
      ? 'packages/*/*/{lib,package.json} + apps/cli + apps/web/dist + resolved node_modules closure'
      : row.pack.mounts.map(mount => mount.from).join(' + ')
    if (row.plan === undefined) {
      lines.push([row.pack.id.padEnd(10), '(not planned)'.padEnd(40), source, '', '', '', row.pack.unpackTo].join(' '))
      continue
    }
    const cut = [...row.plan.excluded.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    totalFiles += row.plan.files.length
    totalRaw += row.plan.originalBytes
    totalCut += cut
    lines.push([
      row.pack.id.padEnd(10),
      row.plan.name.padEnd(40),
      source,
      String(row.plan.files.length).padStart(9),
      (row.plan.originalBytes / 1024 / 1024).toFixed(1).padStart(11),
      (cut / 1024 / 1024).toFixed(1).padStart(13),
      row.plan.unpackTo,
    ].join(' '))
  }
  lines.push('', `total: ${totalFiles} files, ${(totalRaw / 1024 / 1024).toFixed(1)} MB raw, ${(totalCut / 1024 / 1024).toFixed(1)} MB excluded by rule`)
  for (const row of rows) {
    if (row.error !== undefined) lines.push(`  FAILED ${row.pack.id}: ${row.error}`)
    if (row.plan === undefined) continue
    for (const [label, entry] of row.plan.excluded) {
      lines.push(`  ${row.pack.id}: excluded ${label} -> ${entry.files} files, ${(entry.bytes / 1024 / 1024).toFixed(1)} MB`)
    }
    for (const link of row.plan.brokenLinks) lines.push(`  ${row.pack.id}: unreadable link skipped -> ${link}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Hash and size an archive on disk.
 * @param file - Absolute path to the archive.
 * @returns Its byte length and lowercase hex sha256.
 */
async function digestFile(file: string): Promise<WrittenArchive> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * List an archive's members by decoding it with the platform tar, which is the
 * reader the installer's tooling mirrors.
 * @param file - Absolute path to the `.tar.zst`.
 * @returns Member names with trailing slashes removed, in archive order.
 */
async function listArchive(file: string): Promise<string[]> {
  const found: string[] = []
  const child = spawn('tar', ['--zstd', '-tf', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let pending = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/u)
    pending = lines.pop() ?? ''
    for (const line of lines) if (line !== '') found.push(line.replace(/\/$/u, ''))
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  if (code !== 0) throw new Error(`tar could not read the archive: ${stderr.trim() || `exit ${String(code)}`}`)
  if (pending !== '') found.push(pending.replace(/\/$/u, ''))
  return found
}

/**
 * Check one archive against its pack's content rules.
 * @param pack - Pack the archive belongs to.
 * @param members - Member names read back from the archive.
 * @returns One message per violation; empty means the archive conforms.
 */
function checkContents(pack: PackSpec, members: readonly string[]): string[] {
  const rules = ARCHIVE_RULES.get(pack.id)
  if (rules === undefined) return []
  const problems: string[] = []
  for (const { label, test } of rules.banned ?? []) {
    const hits = members.filter(member => test(member))
    if (hits.length > 0) problems.push(`contains ${label}, which must be excluded (${hits.length} member(s), e.g. ${hits[0] ?? ''})`)
  }
  if (rules.exactlyOnce !== undefined) {
    const hits = members.filter(member => rules.exactlyOnce?.test(member) === true)
    if (hits.length !== 1) problems.push(`expected exactly one ${rules.exactlyOnce.label}, found ${String(hits.length)}`)
  }
  return problems
}

/**
 * Parse argv into a mode and its options.
 * @param argv - Arguments after the script path.
 * @returns The parsed invocation.
 */
function parseArgs(argv: readonly string[]): Invocation {
  const planMode = argv.includes('--plan-only')
  const build = argv.includes('--build')
  const verifyAt = argv.indexOf('--verify')
  const chosen = [planMode, build, verifyAt !== -1].filter(Boolean).length
  if (chosen !== 1) throw new Error('pass exactly one of --plan-only, --build, or --verify <dir>')
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  const release = value('--release')
  const only = value('--only')
  if (planMode) return { mode: 'plan', directory: '', only, release }
  if (build) return { mode: 'build', directory: value('--out') ?? DEFAULT_OUT_ROOT, only, release }
  const directory = argv[verifyAt + 1]
  if (directory === undefined || directory.startsWith('--')) throw new Error('--verify needs a directory')
  return { mode: 'verify', directory, only: undefined, release }
}

/**
 * Resolve the release version from `--release` or the root manifest.
 * @param override - `--release` value when given.
 * @returns The version every archive name carries.
 */
async function resolveVersion(override: string | undefined): Promise<string> {
  if (override !== undefined) return override
  const parsed: unknown = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error('root package.json is not an object')
  const { version } = parsed as { version?: unknown }
  if (typeof version !== 'string' || version === '') throw new Error('root package.json has no version')
  return version
}

/**
 * Plan every pack, capturing failures per pack so the table still prints.
 * @param version - Resolved release version.
 * @returns One row per pack, in payload order.
 */
async function planAll(version: string): Promise<PlanRow[]> {
  const claim = new Map<string, string>()
  const rows: PlanRow[] = []
  for (const pack of PACKS) {
    try {
      rows.push({ pack, plan: await planPack(pack, version, claim), error: undefined })
    } catch (error) {
      rows.push({ pack, plan: undefined, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return rows
}

/**
 * Read an existing manifest, tolerating its absence on a first `--only` build.
 * @param file - Absolute path to `manifest.json`.
 * @returns The parsed manifest, or undefined when it is missing or unusable.
 */
async function readManifest(file: string): Promise<Manifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const manifest = parsed as Manifest
    return Array.isArray(manifest.packs) ? manifest : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Run `--plan-only`: print the review table, write no archive.
 * @param invocation - Parsed command line.
 * @returns Process exit code.
 */
async function runPlan(invocation: Invocation): Promise<number> {
  const version = await resolveVersion(invocation.release)
  const rows = await planAll(version)
  process.stdout.write(renderPlan(rows, version))
  const failed = rows.filter(row => row.error !== undefined)
  if (failed.length > 0) {
    process.stderr.write(`\nplan aborted: ${failed.length} pack(s) failed; nothing was written\n`)
    return 1
  }
  return 0
}

/**
 * Run `--build`: write the selected archives, then the manifest beside them.
 * @param invocation - Parsed command line.
 * @returns Process exit code.
 */
async function runBuild(invocation: Invocation): Promise<number> {
  const only = invocation.only
  if (only !== undefined && !PACKS.some(pack => pack.id.includes(only))) {
    process.stderr.write(`--only ${only} matches no pack id\n`)
    return 1
  }
  const version = await resolveVersion(invocation.release)
  const rows = await planAll(version)
  process.stdout.write(renderPlan(rows, version))
  if (rows.some(row => row.error !== undefined)) {
    process.stderr.write('\nbuild aborted: at least one pack failed to plan; nothing was written\n')
    return 1
  }
  const manifestPath = join(invocation.directory, 'manifest.json')
  const prior = only === undefined ? undefined : await readManifest(manifestPath)
  const selected = rows.filter(row => only === undefined || row.pack.id.includes(only))
  const names = new Set(selected.map(row => row.plan?.name))
  const packs = (prior?.packs ?? []).filter(entry => !names.has(entry.name))
  for (const row of selected) {
    const plan = row.plan
    if (plan === undefined) continue
    const started = Date.now()
    const written = await writePack(join(invocation.directory, plan.name), plan)
    process.stdout.write(`built ${plan.name} files=${String(plan.files.length)} bytes=${String(written.bytes)} sha256=${written.sha256} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
    packs.push({ name: plan.name, bytes: written.bytes, sha256: written.sha256, required: true, unpackTo: plan.unpackTo })
  }
  const order = new Map(PACKS.map((pack, index) => [pack.nameTemplate.replace('{version}', version), index]))
  packs.sort((left, right) => (order.get(left.name) ?? PACKS.length) - (order.get(right.name) ?? PACKS.length))
  const payload: Manifest = { release: version, builtAt: new Date().toISOString(), packs }
  await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  process.stdout.write(`manifest ${manifestPath} lists ${packs.length} of ${PACKS.length} pack(s)\n`)
  return 0
}

/**
 * Run `--verify`: re-hash every archive, compare with the manifest, and assert
 * its members contain nothing the exclusion set forbids.
 * @param invocation - Parsed command line.
 * @returns Process exit code; non-zero on any mismatch.
 */
async function runVerify(invocation: Invocation): Promise<number> {  const manifestPath = join(invocation.directory, 'manifest.json')
  const manifest = await readManifest(manifestPath)
  if (manifest === undefined) {
    process.stderr.write(`${manifestPath} is missing or has no packs array\n`)
    return 1
  }
  const byName = new Map(PACKS.map(pack => [pack.nameTemplate.replace('{version}', manifest.release), pack]))
  const expected = new Set(manifest.packs.map(entry => entry.name))
  const problems: string[] = []
  for (const entry of manifest.packs) {
    const file = join(invocation.directory, entry.name)
    let actual: WrittenArchive
    try {
      actual = await digestFile(file)
    } catch (error) {
      problems.push(`${entry.name}: unreadable (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    if (actual.bytes !== entry.bytes) problems.push(`${entry.name}: manifest declares ${String(entry.bytes)} bytes, disk holds ${String(actual.bytes)}`)
    if (actual.sha256 !== entry.sha256) problems.push(`${entry.name}: sha256 differs from the manifest (manifest ${entry.sha256}, disk ${actual.sha256})`)
    const pack = byName.get(entry.name)
    if (pack === undefined) {
      problems.push(`${entry.name}: no pack specification matches this name`)
      continue
    }
    try {
      for (const problem of checkContents(pack, await listArchive(file))) problems.push(`${entry.name}: ${problem}`)
    } catch (error) {
      problems.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const state = problems.some(problem => problem.startsWith(entry.name)) ? 'FAIL' : 'ok'
    process.stdout.write(`${state} ${entry.name} bytes=${String(entry.bytes)} sha256=${entry.sha256}\n`)
  }
  for (const found of await readdir(invocation.directory)) {
    if (found === 'manifest.json' || expected.has(found) || found.endsWith('.part')) continue
    problems.push(`${found}: present in the output directory but absent from the manifest`)
  }
  if (manifest.packs.length !== PACKS.length) {
    process.stdout.write(`note: the manifest lists ${manifest.packs.length} of ${PACKS.length} packs; verify covers what was built\n`)
  }
  if (problems.length > 0) {
    process.stderr.write(`\nverify FAILED with ${problems.length} problem(s):\n`)
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    return 1
  }
  process.stdout.write(`verify OK: ${manifest.packs.length} pack(s) match the manifest and their content rules\n`)
  return 0
}

/**
 * Entry point: dispatch on the requested mode.
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const invocation = parseArgs(process.argv.slice(2))
  if (invocation.mode === 'plan') return await runPlan(invocation)
  if (invocation.mode === 'build') return await runBuild(invocation)
  return await runVerify(invocation)
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
