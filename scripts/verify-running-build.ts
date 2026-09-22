/**
 * Verify that the profile loads the packages this checkout just built.
 *
 * A plugin's loaded artifact is its built bundle, and two failures hide behind a
 * passing build:
 *
 * - the bundle is older than the sources it was built from, because a package with
 *   its own `tsdown.config.ts` is not rebuilt by the workspace build;
 * - the profile resolves the package somewhere else entirely — a vendored copy or a
 *   module fallback — so editing this checkout changes nothing that runs.
 *
 * Both have been hit here, so this check reports which package the profile loads,
 * what it was built from, and whether that bundle is current. It reads no
 * credentials and starts no process.
 *
 * The packages a session loads are not all in the profile's own `node_modules`:
 * Node walks the ancestor directories too, which is where the rows an agent preset
 * mounts resolve from. Every directory in that chain is read, nearest first, so a
 * package found in both is reported as the one resolution would actually pick.
 *
 * Usage:
 *   tsx scripts/verify-running-build.ts [--profile <dir>] [--json]
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Milliseconds a bundle may trail its source before it counts as stale. */
export const STALE_TOLERANCE_MS = 1_000

/** What the check concluded about one package. */
export type BuildVerdict =
  /** The profile loads this checkout's package and its bundle is newer than its sources. */
  | 'current'
  /** The profile loads this checkout's package from a bundle older than its sources. */
  | 'stale'
  /** The profile loads this checkout's package but the bundle it names is missing. */
  | 'missing_bundle'
  /** The profile loads its own copy, and that copy is older than this checkout's sources. */
  | 'behind'
  /** The profile loads its own copy, and that copy is as new as this checkout's sources. */
  | 'copied'
  /** The loaded package is not one this checkout builds. */
  | 'not_built_here'

/** The verdicts that mean the profile is not running this checkout's code. */
const PROBLEM_VERDICTS: readonly BuildVerdict[] = ['stale', 'missing_bundle', 'behind']

/** One package's row in the report. */
export interface PackageReport {
  /** Package name as the profile resolves it. */
  readonly name: string
  /** Absolute path of the real directory the profile's module entry reaches. */
  readonly loaded: string
  /** This checkout's directory for the same package, when it has one. */
  readonly workspace?: string | undefined
  /** Newest source file, ISO, or an empty string when there is none. */
  readonly newestSource: string
  /** The bundle the package loads, ISO, or an empty string when it is missing. */
  readonly bundle: string
  /** What the check concluded. */
  readonly verdict: BuildVerdict
  /** The command that repairs this row, or an empty string. */
  readonly fix: string
}

/** The newest modification time among the given files, or 0 when there is none. */
export function newestMtime(files: readonly string[]): number {
  let newest = 0
  for (const file of files) {
    try {
      newest = Math.max(newest, statSync(file).mtimeMs)
    } catch {
      continue
    }
  }
  return newest
}

/**
 * Judge one package.
 *
 * A source file newer than the bundle means the bundle does not contain it. A
 * profile that holds its own copy of the package is only a finding when that copy
 * trails this checkout: an upstream package nobody edited here is expected to be a
 * copy, and re-installing it would change nothing.
 * @param input - The measured facts for one package.
 * @returns The verdict and the command that repairs it.
 */
export function verdictOf(input: {
  readonly loadsWorkspacePackage: boolean
  readonly hasBundle: boolean
  readonly newestSourceMs: number
  readonly bundleMs: number
}): { verdict: BuildVerdict; fix: string } {
  const behind = input.hasBundle && input.newestSourceMs > input.bundleMs + STALE_TOLERANCE_MS
  if (!input.loadsWorkspacePackage) {
    return behind
      ? { verdict: 'behind',
        fix: 'profile 加载的是它自己那份副本，而且比本仓源码旧：把这个包的模块入口指回本仓，'
          + '或把本仓构建产物同步进 profile，然后重启宿主。' }
      : { verdict: 'copied', fix: '' }
  }
  if (!input.hasBundle) {
    return { verdict: 'missing_bundle',
      fix: '这个包还没有产物：pnpm run build:lib:host；带 tsdown.config.ts 的包再单独跑一次它的 tsdown。' }
  }
  if (behind) {
    return { verdict: 'stale',
      fix: '源码比产物新：pnpm run build:lib:host；带 tsdown.config.ts 的包必须再加一次 '
        + 'pnpm exec tsdown --config <包>/tsdown.config.ts，然后重启宿主。' }
  }
  return { verdict: 'current', fix: '' }
}

/** Every TypeScript file below one directory, or an empty list when it is absent. */
function sourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(path)
    }
  }
  walk(root)
  return found
}

/**
 * Every workspace package in this checkout, by name.
 * @param root - Absolute checkout root.
 * @returns Package name to absolute package directory.
 */
export function workspacePackages(root: string): Map<string, string> {
  const found = new Map<string, string>()
  const groups = join(root, 'packages')
  let groups_entries
  try {
    groups_entries = readdirSync(groups, { withFileTypes: true })
  } catch {
    return found
  }
  for (const group of groups_entries) {
    if (!group.isDirectory()) continue
    let members
    try {
      members = readdirSync(join(groups, group.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const member of members) {
      if (!member.isDirectory()) continue
      const directory = join(groups, group.name, member.name)
      try {
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
        if (typeof manifest.name === 'string') found.set(manifest.name, directory)
      } catch {
        continue
      }
    }
  }
  return found
}

/** One package as the profile's module directory presents it. */
export interface LoadedEntry {
  /** Package name, from the directory the profile holds. */
  readonly name: string
  /** The real directory that entry reaches, with every link followed. */
  readonly resolved: string
}

/**
 * Every `@deepseek-ai/*` package the profile's `node_modules` offers.
 *
 * The entry may be a directory, a symlink, or an NTFS junction; the profile loads
 * whichever real directory it reaches, so that is what is reported.
 * @param modules - Absolute path of the profile's `node_modules` directory.
 * @returns One entry per package, sorted by name.
 */
export function loadedPackages(modules: string): LoadedEntry[] {
  const scope = join(modules, '@deepseek-ai')
  let names: string[]
  try {
    names = readdirSync(scope)
  } catch {
    return []
  }
  const entries: LoadedEntry[] = []
  for (const name of names.sort()) {
    try {
      entries.push({ name: `@deepseek-ai/${name}`, resolved: realpathSync(join(scope, name)) })
    } catch {
      continue
    }
  }
  return entries
}

/** How many ancestor directories above the profile the resolution chain is read from. */
const MODULE_CHAIN_HOPS = 3

/**
 * The `node_modules` directories Node's resolution walks, nearest first.
 *
 * A session resolves a plugin from the profile's own `node_modules`, then from
 * each ancestor's — the parent `profiles/node_modules` is where the rows a preset
 * mounts are linked from. Reading only the first would report a session as loading
 * nothing from this checkout while most of its tools come from it.
 * @param profile - Absolute profile directory.
 * @returns The existing `node_modules` directories, nearest first, deduplicated.
 */
export function moduleDirectories(profile: string): string[] {
  const directories: string[] = []
  let directory = resolve(profile)
  for (let hop = 0; hop <= MODULE_CHAIN_HOPS; hop += 1) {
    const modules = join(directory, 'node_modules')
    if (statSync(modules, { throwIfNoEntry: false })?.isDirectory() === true && !directories.includes(modules)) {
      directories.push(modules)
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return directories
}

/**
 * Every package the profile's resolution chain offers, nearest entry per name.
 * @param profile - Absolute profile directory.
 * @returns One entry per package name, sorted by name.
 */
export function chainedPackages(profile: string): LoadedEntry[] {
  const nearest = new Map<string, LoadedEntry>()
  for (const modules of moduleDirectories(profile)) {
    for (const entry of loadedPackages(modules)) {
      if (!nearest.has(entry.name)) nearest.set(entry.name, entry)
    }
  }
  return [...nearest.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Build one package's report row from measured paths.
 * @param input - The package name, the directory the profile loads, and this checkout's directory for it.
 * @returns The row, with its verdict and repair command.
 */
export function inspectPackage(input: {
  readonly name: string
  readonly loaded: string
  readonly workspace?: string | undefined
}): PackageReport {
  if (input.workspace === undefined) {
    return { name: input.name, loaded: input.loaded, newestSource: '', bundle: '',
      verdict: 'not_built_here', fix: '' }
  }
  const sources = sourceFiles(join(input.workspace, 'src'))
  const newestSourceMs = newestMtime(sources)
  const loadsWorkspace = realpathSync(input.loaded) === realpathSync(input.workspace)
  // A copy answers for itself: its own bundle is what the profile runs, so that is
  // the timestamp an edit here has to beat.
  const bundlePath = join(loadsWorkspace ? input.workspace : input.loaded, 'lib', 'index.js')
  const hasBundle = statSync(bundlePath, { throwIfNoEntry: false })?.isFile() === true
  const bundleMs = hasBundle ? statSync(bundlePath).mtimeMs : 0
  const { verdict, fix } = verdictOf({ loadsWorkspacePackage: loadsWorkspace, hasBundle,
    newestSourceMs, bundleMs })
  return {
    name: input.name,
    loaded: input.loaded,
    workspace: input.workspace,
    newestSource: newestSourceMs === 0 ? '' : new Date(newestSourceMs).toISOString(),
    bundle: hasBundle ? new Date(bundleMs).toISOString() : '',
    verdict,
    fix,
  }
}

/** Resolve the profile directory the check reads. */
function profileDirectory(argv: readonly string[]): string {
  const flag = argv.indexOf('--profile')
  if (flag !== -1) {
    const value = argv[flag + 1]
    if (value === undefined) throw new Error('usage: --profile <dir>')
    return resolve(value)
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'web')
}

/** Run the check and print what it found. */
function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const profile = profileDirectory(process.argv.slice(2))
  const modules = moduleDirectories(profile)
  if (modules.length === 0) {
    console.log(`没有可核对的 profile（${join(profile, 'node_modules')} 不存在）：这台机器不加载本仓的包，视为通过。`)
    return
  }
  const workspace = workspacePackages(root)
  const rows = chainedPackages(profile)
    .map(entry => inspectPackage({
      name: entry.name,
      loaded: entry.resolved,
      ...(workspace.has(entry.name) ? { workspace: workspace.get(entry.name) } : {}),
    }))
    .filter(row => row.verdict !== 'not_built_here')
  const problems = rows.filter(row => PROBLEM_VERDICTS.includes(row.verdict))
  const slash = (path: string): string => path.split(sep).join('/')
  console.log(`profile ${slash(profile)}`)
  console.log(`checkout ${slash(root)}`)
  for (const row of rows) {
    console.log(`${PROBLEM_VERDICTS.includes(row.verdict) ? '✗' : '✓'} ${row.name}  ${row.verdict}`)
    console.log(`  源码 ${row.newestSource || '(无)'}`)
    console.log(`  产物 ${row.bundle || '(缺)'}`)
    console.log(`  加载 ${slash(relative(root, row.loaded)) || slash(row.loaded)}`)
    if (row.fix !== '') console.log(`  → ${row.fix}`)
  }
  console.log(`共加载 ${String(rows.length)} 个本仓包，其中 ${String(problems.length)} 个不是当前产物。`)
  if (problems.length > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('verify-running-build.ts')) main()
