/**
 * Step table and resume guards for the fixed-target Desktop packaging pipeline.
 *
 * Packaging reads the working tree, so a resumed run reuses artifacts an earlier
 * run left behind — and those artifacts are what the installer ships. Reuse is
 * therefore refused unless the tree is clean, HEAD has not moved since the run
 * started, and every reused artifact is newer than the commit being packaged: a
 * tarball older than HEAD cannot contain HEAD's fix, and a tree edited while the
 * pipeline runs puts bytes into the installer that no commit names
 * ([rationale](../../../../.agents/notes/implemented/process/2026-09-27-packaging-resume-and-unchanged-package-skip.md)).
 *
 * The table is the single home for two facts: which step produces which paths,
 * and the order the steps run in. `--help` prints it, and `--from`/`--only`
 * reuse exactly the artifacts of the steps they skip.
 */

import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { capture } from '../../../scripts/release/process.ts'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import type { DesktopPackageTargetName } from './package-target.ts'

/** Fixed identifiers of the packaging pipeline's steps, in execution order. */
export type DesktopPackageStepId =
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7'
  | 'S8' | 'S9' | 'S10' | 'S11' | 'S12' | 'S13'

/** Worktree paths a packaging run tolerates being dirty: the harness's own runtime state. */
const WORKTREE_EXEMPT_PREFIXES = ['.pi-glla/'] as const

/** How many files of one reused artifact group the resume listing names individually. */
const REUSE_SAMPLE = 4

/** One path a step leaves behind, described by what it selects. */
export interface DesktopPackageArtifact {
  /** Repository-relative path or glob (`*`), with `/` separators. */
  readonly glob: string
  /** What the matches are, named in the resume listing and in `--help`. */
  readonly label: string
  /** Whether a match is stored content, or a directory reported as one entry. */
  readonly kind: 'files' | 'directory'
}

/** One step of the packaging pipeline and the paths it produces. */
export interface DesktopPackageStep {
  readonly id: DesktopPackageStepId
  /** Short name of the commands the step runs. */
  readonly title: string
  /** Paths this step produces and a later step consumes. */
  readonly artifacts: readonly DesktopPackageArtifact[]
}

/** A step together with the commands that run it. */
export interface DesktopPackageRunStep extends DesktopPackageStep {
  /**
   * Run the step's commands.
   * @returns Resolves when every command exited zero.
   */
  run(): Promise<void>
}

/**
 * Read a package manifest's name and version.
 * @param manifestPath - absolute path of the manifest.
 * @returns The package name and version.
 */
function manifestIdentity(manifestPath: string): { name: string; version: string } {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`desktop package: ${manifestPath} is not a package manifest`)
  }
  const { name, version } = manifest as { name?: unknown; version?: unknown }
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
    throw new Error(`desktop package: ${manifestPath} has no name and version`)
  }
  return { name, version }
}

/**
 * The npm tarball filename `pnpm pack` writes for one package directory.
 * @param manifestPath - absolute path of the package manifest.
 * @returns The tarball filename.
 */
function tarballName(manifestPath: string): string {
  const { name, version } = manifestIdentity(manifestPath)
  const unscoped = name.startsWith('@') ? name.slice(1).replace('/', '-') : name
  return `${unscoped}-${version}.tgz`
}

/**
 * Describe the artifacts and order of the packaging pipeline for one target.
 *
 * The table follows the commands a run executes: S2 packs the dsh family, S3 to
 * S6 add the tarballs that family excludes, S7 packs vendor, S8 to S9 build and
 * pack the landlock addon, S10 prepares the target runtime, S11 and S12 assemble
 * the package set and the dsh tree electron-builder consumes, and S13 builds the
 * installer.
 * @param root - absolute repository root.
 * @param target - release target the run packages.
 * @param unsigned - whether artifacts omit publisher signing and notarization.
 * @returns The steps in execution order, with the paths each produces.
 */
export function desktopPackageSteps(
  root: string,
  target: DesktopPackageTargetName,
  unsigned: boolean,
): readonly DesktopPackageStep[] {
  const paths = desktopTargetBuildPaths(target)
  const repoPath = (absolute: string): string => relative(root, absolute).replaceAll('\\', '/')
  const packedDsh = repoPath(paths.packedDsh)
  const packedVendor = repoPath(paths.packedVendor)
  const packedLandlock = repoPath(paths.packedLandlock)
  const runtime = repoPath(paths.runtime)
  const packageSet = repoPath(paths.packageSet)
  const dsh = repoPath(paths.dsh)
  const artifacts = repoPath(unsigned ? join(paths.root, 'unsigned-artifacts') : paths.artifacts)
  const packedTarball = (directory: string, note: string): DesktopPackageArtifact => {
    const file = tarballName(join(root, directory, 'package.json'))
    return { glob: `${packedDsh}/${file}`, label: `${file} (${note})`, kind: 'files' }
  }
  const sources: unknown = JSON.parse(readFileSync(join(root, 'third_party', 'plugins', 'sources.json'), 'utf8'))
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new Error('desktop package: third_party/plugins/sources.json is not an object')
  }
  const pinnedTarballs = Object.keys(sources)
    .map(source => packedTarball(join('third_party', 'plugins', source), `community plugin ${source}`))
  const downloads = JSON.parse(readFileSync(join(root, 'third_party', 'plugins', 'owned-downloads.json'), 'utf8')) as Record<string, { version: string }>
  const downloadTarballs = Object.keys(downloads)
    .map(source => packedTarball(join('third_party', 'plugins', source), `Muse download tool ${source}`))

  return [
    {
      id: 'S1',
      title: 'build every package and the client bundles from this tree',
      artifacts: [{
        glob: '.dsh-build/client-build-environment.json',
        label: 'client build record binding the bundles to this commit and version',
        kind: 'files',
      }],
    },
    {
      id: 'S2',
      title: 'pack the dsh family tarballs',
      artifacts: [
        { glob: `${packedDsh}/*.tgz`, label: 'dsh family tarballs', kind: 'files' },
        { glob: `${packedDsh}/publish-order.txt`, label: 'dsh publish order', kind: 'files' },
      ],
    },
    {
      id: 'S3',
      title: 'pack the Desktop Host tarball',
      artifacts: [packedTarball('apps/desktop-host', 'Desktop Host')],
    },
    {
      id: 'S4',
      title: 'pack the drama skills tarball',
      artifacts: [packedTarball('packages/drama/skills', 'drama skills')],
    },
    {
      id: 'S5',
      title: 'pack the perception BGM tarball',
      artifacts: [packedTarball('packages/perception/perception-bgm', 'perception BGM')],
    },
    {
      id: 'S6',
      title: 'build and pack source plugins and Muse download tools',
      artifacts: [...pinnedTarballs, ...downloadTarballs],
    },
    {
      id: 'S7',
      title: 'pack the vendor family tarballs',
      artifacts: [
        { glob: `${packedVendor}/*.tgz`, label: 'vendor family tarballs', kind: 'files' },
        { glob: `${packedVendor}/publish-order.txt`, label: 'vendor publish order', kind: 'files' },
      ],
    },
    {
      id: 'S8',
      title: 'build the landlock addon',
      artifacts: [{
        glob: 'native/system/packages/entry/lib/index.js',
        label: 'built landlock entry the pack step archives',
        kind: 'files',
      }],
    },
    {
      id: 'S9',
      title: 'pack the landlock addon tarball',
      artifacts: [{ glob: `${packedLandlock}/*.tgz`, label: 'landlock addon tarball', kind: 'files' }],
    },
    {
      id: 'S10',
      title: 'prepare the target runtime and its media payload',
      artifacts: [
        { glob: `${runtime}/versions.json`, label: 'prepared Node and pnpm versions', kind: 'files' },
        { glob: `${runtime}/media`, label: 'media runtime payload', kind: 'directory' },
      ],
    },
    {
      id: 'S11',
      title: 'assemble the Desktop package set',
      artifacts: [
        { glob: `${packageSet}/desktop-packages.json`, label: 'package set record', kind: 'files' },
        { glob: `${packageSet}/desktop-packages`, label: 'package set tarballs', kind: 'directory' },
      ],
    },
    {
      id: 'S12',
      title: 'materialize the dsh runtime tree',
      artifacts: [
        { glob: `${dsh}/desktop-runtime.json`, label: 'runtime record', kind: 'files' },
        { glob: `${dsh}/package.json`, label: 'runtime manifest', kind: 'files' },
        { glob: `${dsh}/node_modules`, label: 'installed runtime tree', kind: 'directory' },
      ],
    },
    {
      id: 'S13',
      title: 'build the installer with electron-builder',
      artifacts: [{ glob: artifacts, label: 'installer and update metadata', kind: 'directory' }],
    },
  ]
}

/**
 * Name the worktree changes a packaging run refuses to build from.
 * @param porcelain - `git status --porcelain=v1` output.
 * @returns One entry per change, excluding the harness's own runtime state.
 */
export function dirtyWorktreeEntries(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/u)
    .filter(line => line !== '')
    .filter((line) => {
      const path = porcelainPath(line)
      return !WORKTREE_EXEMPT_PREFIXES.some(prefix => path.startsWith(prefix))
    })
}

/** The path a porcelain line reports, without its status field and rename arrow. */
function porcelainPath(line: string): string {
  const body = line.length > 3 ? line.slice(3) : line
  const renamed = body.includes(' -> ') ? body.slice(body.indexOf(' -> ') + 4) : body
  return renamed.replace(/^"(.*)"$/u, '$1').replaceAll('\\', '/')
}

/** The commit a run builds and the worktree state it starts from. */
export interface DesktopPackageBaseline {
  /** Full HEAD commit hash the run packages. */
  readonly head: string
  /** HEAD's committer time in milliseconds, which every reused artifact must be newer than. */
  readonly committedAtMs: number
  /** Worktree changes present when the run started. */
  readonly treeChanges: readonly string[]
}

/**
 * Read HEAD and the worktree state once, so every step compares against the same commit.
 * @param root - absolute repository root.
 * @returns The commit being packaged and the changes present at startup.
 */
export function readDesktopPackageBaseline(root: string): DesktopPackageBaseline {
  const head = capture('git', ['rev-parse', 'HEAD'], { cwd: root })
  const committedAtMs = Date.parse(capture('git', ['log', '-1', '--format=%cI'], { cwd: root }))
  const status = capture('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, trim: false })
  return { head, committedAtMs, treeChanges: dirtyWorktreeEntries(status) }
}

/**
 * Refuse to package a worktree carrying changes that no commit names.
 * @param baseline - the state read when the run started.
 */
export function assertCleanWorktree(baseline: DesktopPackageBaseline): void {
  if (baseline.treeChanges.length === 0) return
  throw new Error(
    `desktop package: the worktree is not clean, so no packaged byte is attributable to ${baseline.head.slice(0, 12)};`
    + ' commit or stash these changes first:\n'
    + baseline.treeChanges.map(change => `  ${change}`).join('\n'),
  )
}

/**
 * Refuse to continue once HEAD moved away from the commit the run started on.
 * @param root - absolute repository root.
 * @param baseline - the state read when the run started.
 */
export function assertUnchangedHead(root: string, baseline: DesktopPackageBaseline): void {
  const head = capture('git', ['rev-parse', 'HEAD'], { cwd: root })
  if (head === baseline.head) return
  throw new Error(
    `desktop package: HEAD moved from ${baseline.head.slice(0, 12)} to ${head.slice(0, 12)} while packaging;`
    + ' the artifacts already built describe neither commit, so restart the run on one of them',
  )
}

/**
 * Check both run inputs before a step: HEAD still names the commit being packaged,
 * and the tree still carries only committed content.
 * @param root - absolute repository root.
 * @param baseline - the state read when the run started.
 */
export function assertPackagingInputs(root: string, baseline: DesktopPackageBaseline): void {
  assertUnchangedHead(root, baseline)
  const status = capture('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, trim: false })
  const changes = dirtyWorktreeEntries(status)
  if (changes.length === 0) return
  throw new Error(
    'desktop package: the worktree changed while packaging, so the artifacts would absorb bytes no commit names:\n'
    + changes.map(change => `  ${change}`).join('\n'),
  )
}

/** An ISO instant for a millisecond timestamp. */
function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

/** One path a resumed run would reuse, with the evidence that identifies it. */
export interface ReusedArtifact {
  /** Repository-relative path, `/` separators. */
  readonly path: string
  /** Last modification time in milliseconds. */
  readonly mtimeMs: number
  /** Byte length, or the number of directory entries for a directory artifact. */
  readonly bytes: number
  /** Content digest, empty for a directory artifact. */
  readonly sha256: string
}

/** The artifacts one skipped step contributes to a resumed run. */
export interface ReusedArtifactGroup {
  readonly stepId: DesktopPackageStepId
  readonly title: string
  readonly label: string
  readonly kind: 'files' | 'directory'
  /** Matches in path order. */
  readonly entries: readonly ReusedArtifact[]
  /** Digest over the sorted entry list, which names the set as one value. */
  readonly digest: string
}

/** What a resumed run found of the artifacts its skipped steps produced. */
export interface ReuseInventory {
  readonly groups: readonly ReusedArtifactGroup[]
  /** One message per declared artifact with no match. */
  readonly missing: readonly string[]
  /** One message per artifact older than the commit being packaged. */
  readonly stale: readonly string[]
}

/**
 * Hash one file's content.
 * @param path - absolute file path.
 * @returns Lowercase hex SHA-256.
 */
function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Expand one artifact entry into the paths it names.
 * @param root - absolute repository root.
 * @param artifact - the declared artifact.
 * @returns Repository-relative paths, sorted.
 */
function artifactPaths(root: string, artifact: DesktopPackageArtifact): string[] {
  if (artifact.kind === 'directory') {
    return existsSync(join(root, artifact.glob)) ? [artifact.glob] : []
  }
  return globSync([artifact.glob], { cwd: root })
    .map(path => path.replaceAll('\\', '/'))
    .filter(path => statSync(join(root, path)).isFile())
    .sort()
}

/**
 * Collect the artifacts the steps before `first` leave for the steps that run,
 * and judge each one against the commit being packaged.
 * @param root - absolute repository root.
 * @param steps - the pipeline's steps in execution order.
 * @param first - index of the first step this run executes.
 * @param baseline - the state read when the run started.
 * @returns The groups the run reuses, with what is missing or older than the commit.
 */
export function collectReusedArtifacts(
  root: string,
  steps: readonly DesktopPackageStep[],
  first: number,
  baseline: DesktopPackageBaseline,
): ReuseInventory {
  const groups: ReusedArtifactGroup[] = []
  const missing: string[] = []
  const stale: string[] = []
  for (const step of steps.slice(0, first)) {
    for (const artifact of step.artifacts) {
      const paths = artifactPaths(root, artifact)
      if (paths.length === 0) {
        missing.push(`${step.id} declares ${artifact.glob} (${artifact.label}) and nothing matches it`)
        continue
      }
      const entries: ReusedArtifact[] = []
      for (const path of paths) {
        const absolute = join(root, path)
        const stats = statSync(absolute)
        if (artifact.kind === 'directory') {
          entries.push({ path, mtimeMs: stats.mtimeMs, bytes: readdirSync(absolute).length, sha256: '' })
          continue
        }
        entries.push({ path, mtimeMs: stats.mtimeMs, bytes: stats.size, sha256: fileDigest(absolute) })
      }
      for (const entry of entries) {
        if (entry.mtimeMs >= baseline.committedAtMs) continue
        stale.push(
          `${step.id} ${entry.path} was last written ${isoTime(entry.mtimeMs)},`
          + ` before ${baseline.head.slice(0, 12)} was committed at ${isoTime(baseline.committedAtMs)}`,
        )
      }
      const digest = createHash('sha256')
      for (const entry of entries) digest.update(`${entry.path}\0${entry.sha256 || String(entry.bytes)}\0`)
      groups.push({
        stepId: step.id,
        title: step.title,
        label: artifact.label,
        kind: artifact.kind,
        entries,
        digest: digest.digest('hex'),
      })
    }
  }
  return { groups, missing, stale }
}

/**
 * Refuse a resumed run whose reused artifacts are absent or older than its commit.
 * @param inventory - the judged reuse inventory.
 * @param baseline - the state read when the run started.
 */
export function assertReusableArtifacts(inventory: ReuseInventory, baseline: DesktopPackageBaseline): void {
  if (inventory.missing.length > 0 || inventory.stale.length > 0) {
    throw new Error(
      `desktop package: ${String(inventory.missing.length + inventory.stale.length)} artifact problem(s)`
      + ` stop this resume at ${baseline.head.slice(0, 12)}:\n`
      + [...inventory.missing, ...inventory.stale].map(problem => `  ${problem}`).join('\n')
      + '\n  rerun without --from/--only so every step produces its own artifacts',
    )
  }
}

/**
 * Render the reuse inventory the way an operator checks it: which paths, how old
 * they are, and one digest naming the set.
 * @param inventory - the judged reuse inventory.
 * @param verbose - whether to name every file instead of a sample per group.
 * @returns One line per reported fact.
 */
export function describeReuse(inventory: ReuseInventory, verbose: boolean): string[] {
  const lines: string[] = []
  for (const group of inventory.groups) {
    const oldest = group.entries.reduce((left, right) => (left.mtimeMs <= right.mtimeMs ? left : right))
    const newest = group.entries.reduce((left, right) => (left.mtimeMs >= right.mtimeMs ? left : right))
    lines.push(
      `desktop package: reuse ${group.stepId} ${group.entries.length} ${group.kind === 'directory' ? 'path' : 'file'}(s)`
      + ` for "${group.label}" written ${isoTime(oldest.mtimeMs)}..${isoTime(newest.mtimeMs)}`
      + ` digest=sha256:${group.digest.slice(0, 16)}`,
    )
    const sampled = verbose || group.entries.length <= REUSE_SAMPLE * 2
      ? group.entries
      : [...group.entries.slice(0, REUSE_SAMPLE), ...group.entries.slice(-REUSE_SAMPLE)]
    for (const entry of sampled) {
      lines.push(
        entry.sha256 === ''
          ? `desktop package:   ${entry.path} ${isoTime(entry.mtimeMs)} entries=${String(entry.bytes)}`
          : `desktop package:   ${entry.path} ${isoTime(entry.mtimeMs)} bytes=${String(entry.bytes)} sha256=${entry.sha256.slice(0, 16)}`,
      )
    }
    if (sampled.length !== group.entries.length) {
      lines.push(`desktop package:   ... ${String(group.entries.length - sampled.length)} more; --list-reuse names every one`)
    }
  }
  return lines
}

/** Which steps a run executes. */
export interface DesktopPackageSelection {
  /** Index of the first executed step. */
  readonly first: number
  /** Index after the last executed step. */
  readonly last: number
}

/**
 * Resolve `--from`/`--only` against the step table.
 * @param steps - the pipeline's steps in execution order.
 * @param from - first step to run, or undefined to start at the beginning.
 * @param only - the single step to run, or undefined to run through to the end.
 * @returns The half-open index range to execute.
 */
export function selectPackageSteps(
  steps: readonly DesktopPackageStep[],
  from: string | undefined,
  only: string | undefined,
): DesktopPackageSelection {
  const indexOf = (id: string): number => {
    const index = steps.findIndex(step => step.id === id)
    if (index === -1) {
      const known = steps.map(step => step.id).join(', ')
      throw new Error(`desktop package: unknown step ${JSON.stringify(id)}; expected one of ${known}`)
    }
    return index
  }
  if (from !== undefined && only !== undefined) {
    throw new Error('desktop package: --from and --only are mutually exclusive')
  }
  if (only !== undefined) {
    const index = indexOf(only)
    return { first: index, last: index + 1 }
  }
  return { first: from === undefined ? 0 : indexOf(from), last: steps.length }
}

/**
 * Render the step table for `--help`.
 * @param steps - the pipeline's steps in execution order.
 * @returns One line per step, each followed by the paths it produces.
 */
export function describeSteps(steps: readonly DesktopPackageStep[]): string[] {
  return steps.flatMap(step => [
    `  ${step.id}  ${step.title}`,
    ...step.artifacts.map(artifact => `      produces ${artifact.glob}  (${artifact.label})`),
  ])
}

/**
 * Run a selected range of packaging steps, refusing to enter any step whose inputs
 * are no longer the ones the run started from.
 * @param options - the repository root, the steps with their commands, the selected range, and where to log.
 * @returns Resolves when every selected step exited zero.
 */
export async function runDesktopPackageSteps(options: {
  readonly root: string
  readonly steps: readonly DesktopPackageRunStep[]
  readonly selection: DesktopPackageSelection
  readonly baseline: DesktopPackageBaseline
  readonly log: (line: string) => void
}): Promise<void> {
  const { root, steps, selection, baseline, log } = options
  for (const step of steps.slice(selection.first, selection.last)) {
    assertPackagingInputs(root, baseline)
    log(`desktop package: ${step.id} ${step.title}`)
    try {
      await step.run()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log(
        `desktop package: ${step.id} failed; fix the cause, then repeat this command with --from ${step.id}`
        + ' to reuse the artifacts listed above instead of rebuilding from S1\n',
      )
      throw new Error(detail)
    }
  }
}
