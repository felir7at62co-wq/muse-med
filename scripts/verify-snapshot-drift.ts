/**
 * Find recorded-session expected output that still contains model-visible text a change removed.
 *
 * A removed source line is reduced to text fragments: the whole trimmed line, plus the contents of every string
 * literal in code and JSON. A fragment that no source file still contains, but that a committed
 * `system-prompt*.expected.md` or `tool-schemas*.expected.json` sidecar, or a `tool/result` event of a compared
 * Session JSONL does, reports a possible stale output. Static concatenation and fixture-owned text can produce
 * false positives; only the owning replay determines whether the expected output needs to change.
 * Compared JSONL is a scenario's `writer*.expected.jsonl` oracles when it has them, otherwise the highest generation
 * of each Session role; retained older generations and recorded model text are never searched. The check needs no
 * build and runs in seconds. Hooks use warning-only mode so this heuristic cannot prevent a valid push.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * Paths that never supply model-visible text: recorded Sessions and expected output under `snapshots/`, spec
 * assertions, and documentation. Workspace seeds under `snapshots/` and test fixtures stay sources, because
 * scenarios copy them into the workspace a tool reads.
 */
export const NON_SOURCE_PATHSPECS: readonly string[] = [
  ':(exclude,glob)snapshots/**/*.jsonl',
  ':(exclude,glob)snapshots/**/*.expected.*',
  ':(exclude,glob)snapshots/**/workspace.expected/**',
  ':(exclude)docs/',
  ':(exclude)website/',
  ':(exclude).agents/',
  ':(exclude)vendor/',
  ':(exclude,glob)**/*.spec.*',
  ':(exclude,glob)**/*.test.*',
  ':(exclude,glob)**/README*.md',
  ':(exclude,glob)**/*.i18n.yaml',
  ':(exclude,glob)**/CHANGELOG*.md',
]

const TEXT_SOURCE = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|txt|py)$/u
const CODE_SOURCE = /\.(?:[cm]?[jt]sx?|json|py)$/u
const SIDECAR = /^snapshots\/[^/]+\/[^/]+\/(?:system-prompt|tool-schemas)(?:\.[1-9]\d*)?\.expected\.(?:md|json)$/u
const SESSION_LOG = /^(snapshots\/[^/]+\/[^/]+)\/(?:session(\.[1-9]\d*)?(?:\.v([1-9]\d*))?|(writer)(?:\.[1-9]\d*)?\.expected)\.jsonl$/u
const STRING_LITERAL = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/gu
const CJK = /[　-〿㐀-鿿＀-￯]/gu
/** Shortest fragments worth matching: shorter text recurs by chance across unrelated prompts. */
const MIN_LATIN_LENGTH = 24
const MIN_CJK_CHARACTERS = 8

/** One stale expected-output file and the removed source text it still contains. */
export interface DriftFinding {
  /** Repository path of the expected output that still contains the fragment. */
  expected: string
  /** Repository path of the source the fragment was removed from. */
  source: string
  /** Removed model-visible text. */
  fragment: string
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gu, (_match, escape: string) => {
    if (escape.startsWith('u{')) return String.fromCodePoint(Number.parseInt(escape.slice(2, -1), 16))
    if (escape.startsWith('u') || escape.startsWith('x')) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
    return escape === 'n' ? '\n' : escape === 't' ? '\t' : escape
  })
}

function significant(fragment: string): boolean {
  const cjk = fragment.match(CJK)?.length ?? 0
  return (cjk >= MIN_CJK_CHARACTERS || fragment.length >= MIN_LATIN_LENGTH) && /[\p{L}]/u.test(fragment)
}

/**
 * Reduce one source line to the model-visible text fragments it can contribute to a prompt or tool schema.
 * @param path Repository path of the source, which selects code or prose handling.
 * @param line One line of that source, without its diff marker.
 * @returns Distinct fragments long enough to identify their text.
 */
export function textFragments(path: string, line: string): string[] {
  let prose = line.trim().replace(/^(?:[-*+>]|#{1,6}|\d+[.)])\s+/u, '')
  if (/\.ya?ml$/u.test(path)) prose = prose.replace(/^[\w.-]+:\s+/u, '').replace(/^(['"])(.*)\1$/u, '$2')
  const fragments = [prose]
  if (CODE_SOURCE.test(path)) {
    for (const match of line.matchAll(STRING_LITERAL)) {
      const literal = unescapeLiteral(match[1] ?? match[2] ?? match[3] ?? '')
      for (const piece of literal.split(/\$\{[^}]*\}|\n/u)) fragments.push(piece.trim())
    }
  }
  return [...new Set(fragments)].filter(significant)
}

function stringValues(value: unknown, values: string[] = []): string[] {
  if (typeof value === 'string') values.push(value)
  else if (Array.isArray(value)) for (const item of value) stringValues(item, values)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringValues(item, values)
  return values
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    // Unparsable expected output fails its own replay; this check then matches nothing in it.
    void error
    return undefined
  }
}

/**
 * Read the searchable text of an expected output: Markdown as written, a JSON sidecar as its string values, and
 * Session JSONL as the string values of its `tool/result` events.
 * @param path Repository path of the expected output.
 * @param content File bytes decoded as UTF-8.
 * @returns Text in which a fragment appears exactly as the model receives it.
 */
export function expectedText(path: string, content: string): string {
  if (path.endsWith('.md')) return content
  if (path.endsWith('.json')) return stringValues(parsed(content)).join('\n')
  return content.split('\n').map(parsed)
    .filter(event => event !== null && typeof event === 'object' && 'type' in event && event.type === 'tool/result')
    .flatMap(event => stringValues(event)).join('\n')
}

/**
 * Select the snapshot files that replay compares with current output.
 * @param paths Repository paths under `snapshots/`.
 * @returns Prompt and schema sidecars, plus each scenario's writer oracles or else its highest Session generation per role.
 */
export function comparedOutputs(paths: readonly string[]): string[] {
  const selected = paths.filter(path => SIDECAR.test(path))
  interface ScenarioLogs {
    writers: string[]
    roles: Map<string, { version: number; path: string }>
  }
  const scenarios = new Map<string, ScenarioLogs>()
  for (const path of paths) {
    const match = SESSION_LOG.exec(path)
    if (match === null) continue
    const [, dir = '', ordinal = '', version = '0', writer] = match
    const scenario: ScenarioLogs = scenarios.get(dir) ?? { writers: [], roles: new Map<string, { version: number; path: string }>() }
    scenarios.set(dir, scenario)
    const generation = Number(version)
    if (writer !== undefined) scenario.writers.push(path)
    else if (generation >= (scenario.roles.get(ordinal)?.version ?? -1)) scenario.roles.set(ordinal, { version: generation, path })
  }
  for (const { writers, roles } of scenarios.values()) {
    selected.push(...writers.length > 0 ? writers : [...roles.values()].map(role => role.path))
  }
  return selected.sort()
}

/**
 * Pair removed fragments with the expected outputs that still contain them.
 * @param removed Removed lines keyed by source path.
 * @param outputs Searchable expected-output text keyed by repository path.
 * @param stillSourced Whether some source after the change still contains the fragment, so the output may be current.
 * @returns One finding per stale output and removed fragment, sorted by output path.
 */
export function findStaleOutputs(
  removed: ReadonlyMap<string, readonly string[]>,
  outputs: ReadonlyMap<string, string>,
  stillSourced: (fragment: string) => boolean,
): DriftFinding[] {
  const findings: DriftFinding[] = []
  const checked = new Map<string, boolean>()
  // Scenarios sharing a profile commit identical sidecars; search each distinct text once.
  const byText = new Map<string, string[]>()
  for (const [path, text] of outputs) byText.set(text, [...byText.get(text) ?? [], path])
  for (const [source, lines] of removed) {
    for (const fragment of new Set(lines.flatMap(line => textFragments(source, line)))) {
      const owners = [...byText].filter(([text]) => text.includes(fragment)).flatMap(([, paths]) => paths)
      if (owners.length === 0) continue
      let sourced = checked.get(fragment)
      if (sourced === undefined) checked.set(fragment, sourced = stillSourced(fragment))
      if (!sourced) findings.push(...owners.map(expected => ({ expected, source, fragment })))
    }
  }
  return findings.sort((a, b) => a.expected.localeCompare(b.expected) || a.source.localeCompare(b.source))
}

/**
 * Extract removed lines per source path from `git diff --unified=0` output.
 * @param diff Unified diff text produced with `a/` and `b/` prefixes and `core.quotePath=false`.
 * @returns Removed lines keyed by the path the lines were removed from.
 */
export function removedLines(diff: string): Map<string, string[]> {
  const removed = new Map<string, string[]>()
  let path: string | undefined
  // `---` names the old path only in a file header; inside a hunk it is a removed line starting with `--`.
  let header = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) [path, header] = [undefined, true]
    else if (line.startsWith('@@')) header = false
    else if (header) {
      if (line.startsWith('--- ')) path = diffPath(line.slice(4), 'a/')
    } else if (line.startsWith('-') && path !== undefined && TEXT_SOURCE.test(path)) {
      const lines = removed.get(path) ?? []
      lines.push(line.slice(1))
      removed.set(path, lines)
    }
  }
  return removed
}

function diffPath(value: string, prefix: string): string | undefined {
  if (value === '/dev/null') return undefined
  const unquoted = value.startsWith('"') ? unescapeLiteral(value.slice(1, -1)) : value
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : undefined
}

/**
 * Format findings as an actionable report naming each stale scenario and its refresh command.
 * @param findings Stale expected outputs found for a change.
 * @returns Report lines.
 */
export function driftReport(findings: readonly DriftFinding[]): string[] {
  const scenarios = new Map<string, Set<string>>()
  const lines = ['Possible stale recorded-session output contains text removed from source:']
  for (const { expected, source, fragment } of findings) {
    const [, suite = '', scenario = ''] = expected.split('/')
    const names = scenarios.get(suite) ?? new Set<string>()
    names.add(scenario)
    scenarios.set(suite, names)
    const excerpt = fragment.length > 100 ? `${fragment.slice(0, 97)}...` : fragment
    lines.push(`  ${expected}: ${JSON.stringify(excerpt)} (removed from ${source})`)
  }
  lines.push('Run the owning replay before refreshing; review every resulting diff (snapshots/AGENTS.md):')
  for (const [suite, names] of scenarios) {
    const filter = [...names].sort().join('|')
    if (suite === 'web') {
      for (const name of [...names].sort()) lines.push(`  rg --fixed-strings 'snapshots/web/${name}' apps/web/tests`)
      lines.push('  Run the matching test file with pnpm run test:web:built; its filename may differ from the scenario.')
    } else lines.push(`  pnpm run test:snapshot snapshots/${suite}/${suite === 'session' ? 'headless' : suite}.snapshot.ts -t '${filter}'`)
  }
  return lines
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

/** Read compared outputs from a commit with one `git cat-file --batch`, or from the working tree when `head` is undefined. */
function readExpectedOutputs(root: string, head: string | undefined): Map<string, string> {
  const listing = head === undefined
    ? git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'snapshots/'])
    : git(root, ['ls-tree', '-r', '-z', '--name-only', head, '--', 'snapshots/'])
  const paths = comparedOutputs(listing.split('\0'))
  const outputs = new Map<string, string>()
  if (head === undefined) {
    for (const path of paths) outputs.set(path, expectedText(path, readFileSync(join(root, path), 'utf8')))
    return outputs
  }
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root, input: paths.map(path => `${head}:${path}\n`).join(''), maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  if (batch.status !== 0) throw new Error(`git cat-file --batch failed: ${batch.stderr.toString().trim()}`)
  let offset = 0
  for (const path of paths) {
    const end = batch.stdout.indexOf(0x0a, offset)
    const size = Number(batch.stdout.subarray(offset, end).toString('utf8').split(' ')[2])
    const content = batch.stdout.subarray(end + 1, end + 1 + size).toString('utf8')
    offset = end + 1 + size + 1
    outputs.set(path, expectedText(path, content))
  }
  return outputs
}

function stillSourcedIn(root: string, head: string | undefined): (fragment: string) => boolean {
  return (fragment) => {
    const args = ['grep', '-q', '-F', '-e', fragment, ...head === undefined ? ['--untracked'] : [head], '--', '.', ...NON_SOURCE_PATHSPECS]
    const result = spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    if (result.status === 0) return true
    if (result.status === 1) return false
    throw new Error(`git grep failed: ${result.stderr.toString().trim()}`)
  }
}

/**
 * Compare `base` with `head` (or the working tree) and report stale expected outputs.
 * @param root Repository top-level directory.
 * @param base Commit before the change.
 * @param head Commit after the change; the working tree when undefined.
 * @returns Stale expected-output findings.
 */
export function checkSnapshotDrift(root: string, base: string, head: string | undefined): DriftFinding[] {
  const diff = git(root, ['diff', '--no-color', '--no-ext-diff', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/',
    base, ...head === undefined ? [] : [head], '--', '.', ...NON_SOURCE_PATHSPECS])
  const removed = removedLines(diff)
  if (removed.size === 0) return []
  return findStaleOutputs(removed, readExpectedOutputs(root, head), stillSourcedIn(root, head))
}

/**
 * Resolve the range to check for each ref git is about to push, from the pre-push hook's standard input. An
 * updated ref starts at its remote commit; a new ref starts at the parent of its oldest commit that no
 * remote-tracking ref contains, so only commits published for the first time are checked.
 */
function prePushRanges(root: string, stdin: string): Array<{ base: string; head: string }> {
  const zero = /^0+$/u
  const ranges: Array<{ base: string; head: string }> = []
  for (const line of stdin.split('\n').filter(Boolean)) {
    const [, localSha = '', , remoteSha = ''] = line.split(' ')
    if (zero.test(localSha)) continue
    const known = !zero.test(remoteSha) && spawnSync('git', ['cat-file', '-e', `${remoteSha}^{commit}`], { cwd: root }).status === 0
    let base = remoteSha
    if (!known) {
      const fresh = git(root, ['rev-list', '--topo-order', '--reverse', localSha, '--not', '--remotes']).split('\n')[0] ?? ''
      if (fresh === '') continue
      base = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${fresh}^`], { cwd: root, encoding: 'utf8' }).stdout.trim()
      if (base === '') {
        console.warn(`verify-snapshot-drift: ${localSha.slice(0, 12)} shares no commit with a remote; skipped (CI still checks the pull request)`)
        continue
      }
    }
    ranges.push({ base, head: localSha })
  }
  return ranges
}

function main(): void {
  const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' },
    'pre-push': { type: 'boolean', default: false }, 'warn-only': { type: 'boolean', default: false } } })
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  // CI supplies the trusted pull request base; a local run compares the working tree with HEAD.
  const ranges = values['pre-push']
    ? prePushRanges(root, readFileSync(0, 'utf8'))
    : [{ base: values.base ?? (process.env.DSH_SNAPSHOT_DRIFT_BASE_REF || 'HEAD'), head: values.head }]
  const findings = ranges.flatMap(({ base, head }) => checkSnapshotDrift(root, base, head))
  if (findings.length === 0) {
    console.log(`verify-snapshot-drift: no compared snapshot output contains removed source text (${ranges.length} range(s)).`)
    return
  }
  const report = driftReport(findings)
  console.error(report.join('\n'))
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Workflow annotations carry diagnostics; --warn-only controls the exit status.
    for (const command of report.slice(report.findIndex(line => line.startsWith('Run the owning')) + 1)) {
      console.log(`::warning title=Stale recorded-session snapshots::${command.trim()}`)
    }
  }
  console.error('This text search can report static string concatenation or retained fixture text; a passing owning replay needs no refresh.')
  process.exitCode = values['warn-only'] ? 0 : 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) main()
