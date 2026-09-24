/**
 * Rehearse the next upstream move without making it.
 *
 * `upstream.json` records the commit this fork last confirmed as its upstream base. This script
 * re-derives that base from Git and refuses to continue when the record and Git disagree, so a
 * stale pin fails loudly instead of reporting a rehearsal against a commit nobody re-checked.
 * It then runs `git merge-tree --write-tree` against the requested ref and reports the conflicts
 * a real merge would raise, classified by kind.
 *
 * The rehearsal is read-only by construction. `merge-tree` writes a tree object and no ref, and
 * this script asserts afterwards that both the working tree and the ref set are byte-identical to
 * what it observed before starting. A rehearsal that changed either would be a defect in the
 * rehearsal, not a finding about the merge.
 *
 * Usage:
 *   tsx scripts/upstream-sync-rehearsal.ts [--ref <ref>] [--out <path>] [--repo <path>]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Default upstream ref; `upstream.json` records the base derived from this ref. */
export const DEFAULT_UPSTREAM_REF = 'origin/master'

/** File at the repository root recording the confirmed upstream base. */
export const UPSTREAM_PIN_FILE = 'upstream.json'

/** Largest Git output accepted; `--name-only` output is one path per conflict. */
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024

/** The upstream base this fork last confirmed. */
export interface UpstreamPin {
  /** Upstream repository URL the pin was derived from. */
  readonly repository: string
  /** Commit recorded as the fork's upstream base. */
  readonly pinnedCommit: string
  /** DeepSeek Harness version that commit builds. */
  readonly pinnedVersion: string
  /** How the recorded commit was obtained, so it can be re-derived rather than re-copied. */
  readonly derivedFrom: string
}

/** One conflicted path and the conflict Git reported for it. */
export interface ConflictEntry {
  /** Repository-relative path. */
  readonly path: string
  /** Conflict kind: `content` for both-sides-edited, `modify/delete` for one side deleting it. */
  readonly kind: 'content' | 'modify/delete'
}

/** What a rehearsal observed. */
export interface RehearsalReport {
  /** Upstream ref the rehearsal resolved. */
  readonly ref: string
  /** Commit the ref currently points at. */
  readonly refCommit: string
  /** Upstream base recorded in `upstream.json`. */
  readonly pinnedCommit: string
  /** Upstream base Git derives now; equal to `pinnedCommit` or the rehearsal fails first. */
  readonly mergeBase: string
  /** Tree object `merge-tree` wrote, or an empty string when the merge is clean. */
  readonly tree: string
  /** Conflicted files, sorted by path. */
  readonly conflicts: readonly ConflictEntry[]
  /** Count of `content` conflicts. */
  readonly contentConflicts: number
  /** Count of `modify/delete` conflicts. */
  readonly modifyDeleteConflicts: number
  /** Whether `git status --porcelain` was byte-identical before and after. */
  readonly workingTreeUnchanged: boolean
  /** Whether `git show-ref` was byte-identical before and after. */
  readonly refsUnchanged: boolean
}

/** A rehearsal precondition failed; the message states which and why. */
export class RehearsalError extends Error {}

function git(repoRoot: string, args: readonly string[], allowNonZero = false): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_LIMIT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, status: 0 }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer }
    const status = typeof failure.status === 'number' ? failure.status : null
    if (status === null) throw error
    if (!allowNonZero) {
      const detail = String(failure.stderr ?? '').trim()
      throw new RehearsalError(`git ${args.join(' ')} failed with ${String(status)}${detail === '' ? '' : `: ${detail}`}`)
    }
    return { stdout: String(failure.stdout ?? ''), status }
  }
}

/**
 * Read and shape-check the recorded upstream pin.
 * @param repoRoot - Repository root holding `upstream.json`.
 * @returns The recorded pin.
 * @throws When the file is missing or a required field is absent or mistyped.
 */
export function readUpstreamPin(repoRoot: string): UpstreamPin {
  const path = join(repoRoot, UPSTREAM_PIN_FILE)
  let parsed: unknown
  try {
    // PowerShell's Set-Content and some editors write a UTF-8 BOM; JSON.parse rejects one.
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')
    parsed = JSON.parse(text)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RehearsalError(`no ${UPSTREAM_PIN_FILE} at ${repoRoot}; record the upstream base before rehearsing`)
    }
    throw new RehearsalError(`${UPSTREAM_PIN_FILE} is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RehearsalError(`${UPSTREAM_PIN_FILE} must hold a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  for (const field of ['repository', 'pinnedCommit', 'pinnedVersion', 'derivedFrom'] as const) {
    const value = record[field]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new RehearsalError(`${UPSTREAM_PIN_FILE} is missing a non-empty string ${field}`)
    }
  }
  return {
    repository: record.repository as string,
    pinnedCommit: record.pinnedCommit as string,
    pinnedVersion: record.pinnedVersion as string,
    derivedFrom: record.derivedFrom as string,
  }
}

/**
 * Resolve one ref to the commit it names.
 * @param repoRoot - Repository root.
 * @param ref - Ref or revision to resolve.
 * @returns The commit the ref points at.
 * @throws When the ref does not resolve to a commit.
 */
export function resolveRefCommit(repoRoot: string, ref: string): string {
  const { stdout, status } = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true)
  const commit = stdout.trim()
  if (status !== 0 || commit === '') {
    throw new RehearsalError(`upstream ref ${JSON.stringify(ref)} does not resolve to a commit; fetch it or pass --ref with a ref that exists`)
  }
  return commit
}

/**
 * Derive the current upstream base and require it to match the recorded pin.
 * @param repoRoot - Repository root.
 * @param ref - Upstream ref to derive from.
 * @returns The confirmed base commit.
 * @throws When the ref is missing or the derived base differs from the recorded pin.
 */
export function confirmPin(repoRoot: string, ref: string): string {
  const pin = readUpstreamPin(repoRoot)
  resolveRefCommit(repoRoot, ref)
  const { stdout, status } = git(repoRoot, ['merge-base', 'HEAD', ref], true)
  const mergeBase = stdout.trim()
  if (status !== 0 || mergeBase === '') {
    throw new RehearsalError(`HEAD and ${JSON.stringify(ref)} share no merge base; the pin cannot be derived from this ref`)
  }
  if (mergeBase !== pin.pinnedCommit) {
    throw new RehearsalError(
      `${UPSTREAM_PIN_FILE} records upstream base ${pin.pinnedCommit}, but \`git merge-base HEAD ${ref}\` is ${mergeBase}.`
      + ` Re-derive the base and update ${UPSTREAM_PIN_FILE} before rehearsing; a rehearsal against the recorded commit would not describe the move you are about to make.`,
    )
  }
  return mergeBase
}

/**
 * Split `git merge-tree --write-tree --name-only` output into a tree and its conflicts.
 * @param stdout - Raw `merge-tree` standard output.
 * @returns The written tree (empty when the merge is clean) and one entry per conflict line.
 */
export function parseMergeTree(stdout: string): { tree: string; conflicts: ConflictEntry[] } {
  const lines = stdout.split('\n')
  const tree = (lines[0] ?? '').trim()
  const conflicts: ConflictEntry[] = []
  for (const line of lines) {
    const content = /^CONFLICT \(content\): Merge conflict in (.+)$/.exec(line)
    if (content !== null) {
      conflicts.push({ path: content[1] as string, kind: 'content' })
      continue
    }
    const modifyDelete = /^CONFLICT \(modify\/delete\): (.+) deleted in .+ and modified in .+$/.exec(line)
    if (modifyDelete !== null) conflicts.push({ path: modifyDelete[1] as string, kind: 'modify/delete' })
  }
  return { tree: /^[0-9a-f]{40}$/u.test(tree) ? tree : '', conflicts }
}

/**
 * Group conflict entries by kind and sort them by path.
 * @param conflicts - Conflicts parsed from `merge-tree`.
 * @returns Sorted entries plus the per-kind counts.
 */
export function classifyConflicts(conflicts: readonly ConflictEntry[]): {
  conflicts: ConflictEntry[]
  contentConflicts: number
  modifyDeleteConflicts: number
} {
  const sorted = [...conflicts].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    conflicts: sorted,
    contentConflicts: sorted.filter(entry => entry.kind === 'content').length,
    modifyDeleteConflicts: sorted.filter(entry => entry.kind === 'modify/delete').length,
  }
}

function observeSafety(repoRoot: string): { status: string; refs: string } {
  return {
    status: git(repoRoot, ['status', '--porcelain']).stdout,
    refs: git(repoRoot, ['show-ref']).stdout,
  }
}

/**
 * Rehearse the next upstream move against the recorded pin.
 * @param repoRoot - Repository root.
 * @param options - Upstream ref to rehearse against; defaults to `origin/master`.
 * @returns The rehearsal report.
 * @throws When the pin, the ref, or the merge base cannot be established.
 */
export function rehearse(repoRoot: string, options: { ref?: string } = {}): RehearsalReport {
  const ref = options.ref ?? DEFAULT_UPSTREAM_REF
  const pinnedCommit = confirmPin(repoRoot, ref)
  const refCommit = resolveRefCommit(repoRoot, ref)
  const before = observeSafety(repoRoot)
  const { stdout } = git(repoRoot, ['merge-tree', '--write-tree', '--name-only', 'HEAD', ref], true)
  const after = observeSafety(repoRoot)
  const { tree, conflicts } = parseMergeTree(stdout)
  const classified = classifyConflicts(conflicts)
  return {
    ref,
    refCommit,
    pinnedCommit,
    mergeBase: pinnedCommit,
    tree,
    conflicts: classified.conflicts,
    contentConflicts: classified.contentConflicts,
    modifyDeleteConflicts: classified.modifyDeleteConflicts,
    workingTreeUnchanged: before.status === after.status,
    refsUnchanged: before.refs === after.refs,
  }
}

/**
 * Render a rehearsal report for a terminal.
 * @param report - Report to render.
 * @returns Multi-line summary ending with a newline.
 */
export function formatRehearsal(report: RehearsalReport): string {
  const lines = [
    `upstream-sync-rehearsal: pin confirmed at ${report.pinnedCommit} (merge-base of HEAD and ${report.ref})`,
    `upstream-sync-rehearsal: ${report.ref} is ${report.refCommit}`,
    `upstream-sync-rehearsal: merge-tree wrote ${report.tree === '' ? 'no tree (clean merge)' : report.tree}`,
    `upstream-sync-rehearsal: ${String(report.conflicts.length)} conflicted file(s): ${String(report.contentConflicts)} content, ${String(report.modifyDeleteConflicts)} modify/delete`,
    `upstream-sync-rehearsal: working tree unchanged=${String(report.workingTreeUnchanged)} refs unchanged=${String(report.refsUnchanged)}`,
  ]
  for (const entry of report.conflicts) lines.push(`  ${entry.kind}\t${entry.path}`)
  return `${lines.join('\n')}\n`
}

function parseArgs(argv: readonly string[]): { ref?: string; out?: string; repo?: string } {
  const parsed: { ref?: string; out?: string; repo?: string } = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag !== '--ref' && flag !== '--out' && flag !== '--repo') {
      throw new RehearsalError(`unknown argument ${JSON.stringify(flag)}; usage: --ref <ref> --out <path> --repo <path>`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new RehearsalError(`${flag} requires a value`)
    }
    if (flag === '--ref') parsed.ref = value
    else if (flag === '--out') parsed.out = value
    else parsed.repo = value
    index++
  }
  return parsed
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const { ref, out, repo } = parseArgs(process.argv.slice(2))
  // The script belongs to the repository it rehearses, so the default needs no argument. A caller
  // rehearsing another checkout — a test fixture, or a second clone — names it with --repo.
  const root = repo === undefined ? resolve(import.meta.dirname, '..') : resolve(repo)
  const report = rehearse(root, ref === undefined ? {} : { ref })
  // Safety is the rehearsal's own contract: a mutation here invalidates the finding.
  if (!report.workingTreeUnchanged || !report.refsUnchanged) {
    throw new RehearsalError(
      `the rehearsal mutated the repository (working tree unchanged=${String(report.workingTreeUnchanged)},`
      + ` refs unchanged=${String(report.refsUnchanged)}); this is a defect in the rehearsal, not a finding about the merge`,
    )
  }
  if (out !== undefined) writeFileSync(resolve(root, out), `${JSON.stringify(report, undefined, 2)}\n`)
  process.stdout.write(formatRehearsal(report))
}
