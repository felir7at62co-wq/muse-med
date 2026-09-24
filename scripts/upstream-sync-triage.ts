/**
 * Triage the conflicts an upstream move would raise, by owner.
 *
 * The [rehearsal](./upstream-sync-rehearsal.ts) answers what a merge would conflict on, which is the
 * expensive half to discover and the cheap half to act on. This module answers the other half: for
 * each conflicted path, which side of the move owns the decision, so a maintainer reads a short list
 * of real decisions instead of re-deriving ownership path by path.
 *
 * Ownership is decided from what the two sides contain, never from a list of filenames:
 *
 * - HEAD holds a path the upstream ref does not — the fork kept what upstream deleted;
 * - the upstream ref holds a path HEAD does not — the fork deleted what upstream kept;
 * - otherwise both sides hold it, so the resolution merges two intentions and neither side owns it.
 *
 * A deletion decision stays with the deleting side even when a generator also claims the path:
 * a generator cannot restore or drop a file, so an ownership transfer there would hide the decision.
 *
 * The safety property is inherited rather than restated. The merge, the pin check, and the
 * assertion that neither the working tree nor the ref set moved all happen in `rehearse()`, and a
 * triage that mutated the repository throws there before it can report anything.
 *
 * Usage:
 *   tsx scripts/upstream-sync-triage.ts [--ref <ref>] [--out <path>] [--markdown <path>] [--repo <path>]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RehearsalError, rehearse, resolveRefCommit, type ConflictEntry, type RehearsalReport } from './upstream-sync-rehearsal.ts'

export type { ConflictEntry } from './upstream-sync-rehearsal.ts'

/**
 * Outputs owned by a generator rather than by hand, declared beside this script.
 *
 * The declaration is explicit because no mechanical rule identifies a generated file reliably: the
 * generators write through locals, helpers, and computed paths, so reading their sources would
 * guess. It is tracked because a checkout without it could not triage; a missing manifest declares
 * nothing, and a malformed one fails loudly instead of silently narrowing the generated set.
 */
export const DEFAULT_GENERATED_MANIFEST = 'scripts/upstream-sync-generated-paths.json'

/** Who owns the decision for one conflicted path. */
export type ConflictOwner =
  /** The fork kept what upstream deleted: keeping or dropping the file is a product decision. */
  | 'product'
  /** Upstream deleted what the fork kept: accept the deletion or restore the file deliberately. */
  | 'upstream'
  /** A declared generator writes this path; regenerate it rather than merge it. */
  | 'generated'
  /** Both sides hold the path, so the resolution merges two intentions. */
  | 'own'

/** A conflicted path with its owner assigned. */
export interface OwnedConflict extends ConflictEntry {
  /** Side holding the decision. */
  readonly owner: ConflictOwner
  /** Generator declaring this path, when the owner is `generated`. */
  readonly generator: string | null
}

/** Which sides of the move hold each path. */
export interface MergeTrees {
  /** Paths present in HEAD. */
  readonly head: ReadonlySet<string>
  /** Paths present in the upstream ref. */
  readonly upstream: ReadonlySet<string>
}

/** Per-owner path lists. */
export interface OwnerGroups {
  readonly product: string[]
  readonly upstream: string[]
  readonly generated: string[]
  readonly own: string[]
}

/** What a triage observed. */
export interface TriageRecord {
  /** Ref the triage resolved. */
  readonly ref: string
  /** Upstream base recorded in the pin and re-derived from Git. */
  readonly pinnedCommit: string
  /** Commit the ref currently points at. */
  readonly refCommit: string
  /** Every conflicted path with its owner, ordered by path. */
  readonly conflicts: readonly OwnedConflict[]
  /** Path counts per owner. */
  readonly counts: Record<ConflictOwner, number>
  /** Whether the working tree and the ref set were identical before and after. */
  readonly safe: boolean
  /** The rehearsal findings this triage classified. */
  readonly rehearsal: RehearsalReport
}

/** Largest Git output accepted; one path per line. */
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024

/** Owners in report order, from the most decision-heavy to the most mechanical. */
const OWNER_ORDER: readonly ConflictOwner[] = ['product', 'upstream', 'own', 'generated']

/** Guidance printed per owner, so a record is usable without reading this module. */
const OWNER_ACTION: Record<ConflictOwner, string> = {
  product: 'The fork kept what upstream deleted. Decide keep or drop, and say why.',
  upstream: 'Upstream deleted what the fork kept. Accept the deletion or restore the file deliberately.',
  own: 'Both sides edited. Merge the two intentions.',
  generated: 'Regenerate. Never hand-edit a generated file to express a product fact.',
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Read the manifest declaring which paths a generator owns.
 * @param repoRoot - Repository root.
 * @param manifestPath - Repository-relative manifest path.
 * @returns Declared path to generator path; empty when the manifest is absent.
 * @throws When the manifest is malformed, declares a missing path, or has two generators on one path.
 */
export function readGeneratedManifest(repoRoot: string, manifestPath: string): Map<string, string> {
  let text: string
  try {
    text = readFileSync(join(repoRoot, manifestPath), 'utf8').replace(/^\uFEFF/u, '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  const entries = (parsed as { paths?: unknown }).paths
  if (!Array.isArray(entries)) throw new RehearsalError(`${manifestPath} must hold a "paths" array`)
  const outputs = new Map<string, string>()
  for (const entry of entries) {
    const record = entry as { path?: unknown; generator?: unknown }
    const path = record.path
    const generator = record.generator
    if (typeof path !== 'string' || path === '' || typeof generator !== 'string' || generator === '') {
      throw new RehearsalError(`${manifestPath} entries need non-empty string "path" and "generator"`)
    }
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new RehearsalError(`${manifestPath} declares ${JSON.stringify(path)}, which must stay inside the repository`)
    }
    if (!existsSync(join(repoRoot, path))) {
      throw new RehearsalError(`${manifestPath} declares ${JSON.stringify(path)}, which does not exist`)
    }
    const existing = outputs.get(path)
    if (existing !== undefined && existing !== generator) {
      throw new RehearsalError(`two generators claim ${JSON.stringify(path)}: ${existing} and ${generator}`)
    }
    outputs.set(path, generator)
  }
  return outputs
}

function existsSync(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * List the paths one ref holds.
 * @param repoRoot - Repository root.
 * @param ref - Ref or revision to list.
 * @returns Repository-relative paths with forward slashes.
 * @throws When the ref does not resolve to a commit.
 */
export function readMergeTrees(repoRoot: string, ref: string): MergeTrees {
  resolveRefCommit(repoRoot, ref)
  const listing = (revision: string): Set<string> => new Set(
    git(repoRoot, ['ls-tree', '-r', '--name-only', revision]).split('\n').filter(path => path !== ''),
  )
  return { head: listing('HEAD'), upstream: listing(ref) }
}

/**
 * Assign every conflict an owner.
 * @param conflicts - Conflicts a rehearsal parsed.
 * @param trees - Paths each side holds.
 * @param generated - Declared path-to-generator ownership.
 * @returns One entry per conflict, ordered by path.
 */
export function classifyConflicts(
  conflicts: readonly ConflictEntry[],
  trees: MergeTrees,
  generated: ReadonlyMap<string, string>,
): OwnedConflict[] {
  return [...conflicts]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((entry): OwnedConflict => {
      if (!trees.upstream.has(entry.path)) return { ...entry, owner: 'product', generator: null }
      if (!trees.head.has(entry.path)) return { ...entry, owner: 'upstream', generator: null }
      const generator = generated.get(entry.path)
      if (generator !== undefined) return { ...entry, owner: 'generated', generator }
      return { ...entry, owner: 'own', generator: null }
    })
}

/**
 * Group owned conflicts into per-owner path lists.
 * @param conflicts - Owned conflicts.
 * @returns Each owner's paths, in the order given.
 */
export function groupByOwner(conflicts: readonly OwnedConflict[]): OwnerGroups {
  const groups: OwnerGroups = { product: [], upstream: [], generated: [], own: [] }
  for (const entry of conflicts) groups[entry.owner].push(entry.path)
  return groups
}

/**
 * Rehearse the next upstream move and classify every conflict by owner.
 * @param repoRoot - Repository root.
 * @param options - Upstream ref and generated-path manifest to use.
 * @returns The triage record.
 * @throws When the pin is stale, the ref is missing, the manifest is invalid, or the rehearsal mutated the repository.
 */
export function triage(
  repoRoot: string,
  options: { ref?: string; manifest?: string } = {},
): TriageRecord {
  const rehearsal = rehearse(repoRoot, options.ref === undefined ? {} : { ref: options.ref })
  const generated = readGeneratedManifest(repoRoot, options.manifest ?? DEFAULT_GENERATED_MANIFEST)
  const conflicts = classifyConflicts(rehearsal.conflicts, readMergeTrees(repoRoot, rehearsal.ref), generated)
  const groups = groupByOwner(conflicts)
  return {
    ref: rehearsal.ref,
    pinnedCommit: rehearsal.pinnedCommit,
    refCommit: rehearsal.refCommit,
    conflicts,
    counts: {
      product: groups.product.length,
      upstream: groups.upstream.length,
      generated: groups.generated.length,
      own: groups.own.length,
    },
    safe: rehearsal.workingTreeUnchanged && rehearsal.refsUnchanged,
    rehearsal,
  }
}

/**
 * Render a triage record for a terminal.
 * @param record - Triage record.
 * @returns One summary line per owner, then one line per conflict.
 */
export function formatTriage(record: TriageRecord): string {
  const lines = [
    `upstream-sync-triage: ${record.ref} at ${record.refCommit}; pinned base ${record.pinnedCommit}`,
    `upstream-sync-triage: ${String(record.conflicts.length)} conflicted file(s):`
    + OWNER_ORDER.map(owner => ` ${owner} ${String(record.counts[owner])}`).join(','),
    `upstream-sync-triage: repository unchanged=${String(record.safe)}`,
  ]
  for (const entry of record.conflicts) lines.push(`  ${entry.owner}\t${entry.kind}\t${entry.path}`)
  return `${lines.join('\n')}\n`
}

/**
 * Render a triage record as Markdown, grouped by who owns each decision.
 * @param record - Triage record.
 * @returns Markdown ending with a newline.
 */
export function formatTriageMarkdown(record: TriageRecord): string {
  const groups = groupByOwner(record.conflicts)
  const owner = new Map(record.conflicts.map(entry => [entry.path, entry]))
  const lines = [
    '# Upstream sync triage',
    '',
    `Upstream ref \`${record.ref}\` at \`${record.refCommit}\`; pinned base \`${record.pinnedCommit}\`;`,
    `${String(record.conflicts.length)} conflicted file(s) —`
    + OWNER_ORDER.map(name => ` ${name} ${String(record.counts[name])}`).join(','),
    `— and the repository was left unchanged: ${String(record.safe)}.`,
    '',
  ]
  for (const name of OWNER_ORDER) {
    lines.push(`## ${name} (${String(groups[name].length)})`, '', OWNER_ACTION[name], '')
    if (groups[name].length === 0) {
      lines.push('None.', '')
      continue
    }
    for (const path of groups[name]) {
      const entry = owner.get(path)
      lines.push(`- \`${path}\` — ${entry?.kind ?? 'unknown'}${entry?.generator == null ? '' : ` — ${entry.generator}`}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): { ref?: string; out?: string; markdown?: string; repo?: string } {
  const parsed: { ref?: string; out?: string; markdown?: string; repo?: string } = {}
  const flags = new Set(['--ref', '--out', '--markdown', '--repo'])
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index] as string
    if (!flags.has(flag)) {
      throw new RehearsalError(`unknown argument ${JSON.stringify(flag)}; usage: --ref <ref> --out <path> --markdown <path> --repo <path>`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new RehearsalError(`${flag} requires a value`)
    if (flag === '--ref') parsed.ref = value
    else if (flag === '--out') parsed.out = value
    else if (flag === '--markdown') parsed.markdown = value
    else parsed.repo = value
    index++
  }
  return parsed
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const { ref, out, markdown, repo } = parseArgs(process.argv.slice(2))
  const root = repo === undefined ? resolve(import.meta.dirname, '..') : resolve(repo)
  const record = triage(root, ref === undefined ? {} : { ref })
  if (!record.safe) {
    throw new RehearsalError('the triage mutated the repository; this is a defect in the triage, not a finding about the merge')
  }
  if (out !== undefined) writeFileSync(resolve(root, out), `${JSON.stringify(record, undefined, 2)}\n`)
  if (markdown !== undefined) writeFileSync(resolve(root, markdown), formatTriageMarkdown(record))
  process.stdout.write(formatTriage(record))
}
