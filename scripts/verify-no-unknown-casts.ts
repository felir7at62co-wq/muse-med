/** Reject new assertions to unknown while retiring the recorded existing assertions. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createRegularRepositorySourceReader, readRetainedPluginOrigins, type RetainedPluginOrigin } from './retained-plugin-sources.ts'

const root = resolve(import.meta.dirname, '..')
const baselinePath = 'scripts/no-unknown-casts.baseline.json'

/** Existing assertion counts, keyed by repository path and syntax fingerprint. */
export type UnknownCastBaseline = Record<string, Record<string, number>>

/** One direct assertion to unknown in authored source. */
export interface UnknownCast {
  /** Repository-relative path with forward slashes. */
  file: string
  /** One-based source line. */
  line: number
  /** SHA-256 of the assertion's syntax tokens, excluding comments and whitespace. */
  fingerprint: string
}

function syntaxFingerprint(node: ts.Node, source: ts.SourceFile): string {
  const tokens: string[] = []
  const visit = (child: ts.Node): void => {
    if (ts.isJSDoc(child)) return
    if (ts.isToken(child)) tokens.push(child.getText(source))
    else child.getChildren(source).forEach(visit)
  }
  visit(node)
  return createHash('sha256').update(JSON.stringify(tokens)).digest('hex')
}

function assertsUnknown(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return assertsUnknown(type.type)
  return type.kind === ts.SyntaxKind.UnknownKeyword
    || (ts.isUnionTypeNode(type) && type.types.some(assertsUnknown))
}

/**
 * Find assertions to unknown, including angle syntax and unknown members of asserted unions.
 * @param file - repository-relative source path; its extension selects TS or TSX parsing.
 * @param text - source contents.
 * @returns assertions in AST traversal order; comments, strings, aliases and unknown containers do not match.
 */
export function findUnknownCasts(file: string, text: string): UnknownCast[] {
  return unknownCastSyntax(file, text).map(item => item.cast)
}

interface UnknownCastSyntax {
  cast: UnknownCast
  kind: ts.SyntaxKind
  start: ts.LineAndCharacter
  end: ts.LineAndCharacter
}

function unknownCastSyntax(file: string, text: string): UnknownCastSyntax[] {
  const normalized = file.replaceAll('\\', '/')
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true)
  const casts: UnknownCastSyntax[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (assertsUnknown(node.type)) {
        const children = node.getChildren(source)
        const operatorKind = ts.isAsExpression(node) ? ts.SyntaxKind.AsKeyword : ts.SyntaxKind.LessThanToken
        const operator = children.find(child => child.kind === operatorKind)
        const end = ts.isAsExpression(node) ? node.type : children.find(child => child.kind === ts.SyntaxKind.GreaterThanToken)
        if (operator === undefined || end === undefined) throw new Error(`unknown assertion operator is missing: ${normalized}`)
        casts.push({ cast: {
          file: normalized,
          line: source.getLineAndCharacterOfPosition(node.type.getStart(source)).line + 1,
          fingerprint: syntaxFingerprint(node, source),
        }, kind: node.kind,
        start: source.getLineAndCharacterOfPosition(operator.getStart(source)),
        end: source.getLineAndCharacterOfPosition(end.getEnd()),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return casts
}

function authoredUnknownCasts(file: string, text: string, origin: RetainedPluginOrigin | undefined): UnknownCast[] {
  if (origin?.kind === 'exact') return []
  const current = unknownCastSyntax(file, text)
  if (origin === undefined) return current.map(item => item.cast)
  const originals = unknownCastSyntax(file, origin.upstream)
  const oldLines = origin.upstream.split('\n')
  const newLines = text.replaceAll('\r\n', '\n').split('\n')
  const used = new Set<number>()
  return current.filter((item) => {
    let first: number | undefined
    for (let line = item.start.line; line <= item.end.line; line++) {
      const original = origin.originalLine(line + 1)
      if (original === undefined || newLines[line] === undefined || newLines[line] !== oldLines[original - 1]) return true
      first ??= original - 1
      if (original - 1 !== first + line - item.start.line) return true
    }
    if (first === undefined) return true
    const index = originals.findIndex(old => old.kind === item.kind && old.start.line === first
      && old.end.line === first + item.end.line - item.start.line
      && old.start.character === item.start.character && old.end.character === item.end.character)
    if (index < 0 || used.has(index)) return true
    used.add(index)
    return false
  }).map(item => item.cast)
}

function isSource(file: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file)
    && !file.startsWith('vendor/')
    // These exact source snapshots are pinned in sources.json; owned sibling adapters remain scanned.
    && !file.startsWith('third_party/plugins/dsh-feishu/')
    && !file.startsWith('third_party/plugins/dsh-im/')
    && !file.startsWith('.agents/notes/archived/')
}

/**
 * Scan tracked source and non-ignored new source, including tests and configuration files.
 * @param repoRoot - repository root containing the Git index.
 * @returns every direct unknown assertion in the current working tree.
 * @throws if discovery omits a required source area or an eligible path is a symlink.
 */
export function scanUnknownCasts(repoRoot: string): UnknownCast[] {
  const retained = readRetainedPluginOrigins(repoRoot)
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).split('\0').map(file => file.replaceAll('\\', '/')).filter(isSource))].sort()
  const readSource = createRegularRepositorySourceReader(repoRoot)
  const present = new Map(files.flatMap((file) => {
    const bytes = readSource(file)
    return bytes === undefined ? [] : [[file, bytes.toString('utf8')] as const]
  }))
  for (const area of ['packages/', 'apps/', 'scripts/', 'website/']) {
    if (![...present.keys()].some(file => file.startsWith(area))) {
      throw new Error(`verify-no-unknown-casts: source discovery omitted ${area}`)
    }
  }
  return [...present].flatMap(([file, text]) => authoredUnknownCasts(file, text, retained.get(file)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBaseline(repoRoot: string): UnknownCastBaseline {
  const value: unknown = JSON.parse(readFileSync(resolve(repoRoot, baselinePath), 'utf8'))
  if (!isRecord(value)) throw new Error('verify-no-unknown-casts: baseline must be a file-to-counts object')
  const baseline: UnknownCastBaseline = {}
  for (const [file, counts] of Object.entries(value)) {
    if (!isSource(file) || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')
      || !isRecord(counts) || Object.keys(counts).length === 0) {
      throw new Error(`verify-no-unknown-casts: invalid baseline file: ${file}`)
    }
    const parsed: Record<string, number> = {}
    for (const [fingerprint, count] of Object.entries(counts)) {
      if (!/^[a-f0-9]{64}$/u.test(fingerprint) || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`verify-no-unknown-casts: invalid baseline count: ${file}:${fingerprint}`)
      }
      parsed[fingerprint] = count
    }
    baseline[file] = parsed
  }
  return baseline
}

/**
 * Count exact assertions without granting a file-wide allowance.
 * @param casts - observed assertions.
 * @returns path and fingerprint counts in stable order for comparison and pruning.
 */
export function countUnknownCasts(casts: readonly UnknownCast[]): UnknownCastBaseline {
  const baseline: UnknownCastBaseline = {}
  for (const { file, fingerprint } of casts) {
    const counts = baseline[file] ??= {}
    counts[fingerprint] = (counts[fingerprint] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))
    .map(([file, counts]) => [file, Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))]))
}

/**
 * Enforce the recorded assertion inventory, optionally deleting retired allowances.
 * @param repoRoot - repository root to scan.
 * @param prune - remove stale entries only after establishing that no new assertion exists.
 * @returns the number of existing assertions still present.
 * @throws for new assertions, malformed inventories, or stale entries without pruning.
 */
export function verifyNoUnknownCasts(repoRoot: string, prune = false): number {
  const baseline = readBaseline(repoRoot)
  const casts = scanUnknownCasts(repoRoot)
  const current = countUnknownCasts(casts)
  const remaining = structuredClone(baseline)
  const added: UnknownCast[] = []
  for (const cast of casts) {
    const counts = remaining[cast.file]
    const allowance = counts?.[cast.fingerprint] ?? 0
    if (counts !== undefined && allowance > 0) counts[cast.fingerprint] = allowance - 1
    else added.push(cast)
  }
  if (added.length > 0) {
    throw new Error('verify-no-unknown-casts: new assertions to unknown are forbidden. Use a typed value or narrow the input.\n'
      + added.map(cast => `  ${cast.file}:${String(cast.line)} (${cast.fingerprint})`).join('\n'))
  }
  const stale = Object.entries(remaining).flatMap(([file, counts]) => Object.entries(counts)
    .filter(([, count]) => count > 0).map(([fingerprint]) => `  ${file} (${fingerprint})`))
  if (stale.length > 0) {
    if (!prune) {
      throw new Error('verify-no-unknown-casts: remove retired baseline entries with pnpm run verify-no-unknown-casts --prune.\n'
        + stale.join('\n'))
    }
    writeFileSync(resolve(repoRoot, baselinePath), `${JSON.stringify(current, null, 2)}\n`)
  }
  return casts.length
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length === 1 && args[0] !== '--prune')) {
      throw new Error('Usage: pnpm run verify-no-unknown-casts [--prune]')
    }
    const count = verifyNoUnknownCasts(root, args[0] === '--prune')
    console.log(`verify-no-unknown-casts: no new assertions; ${String(count)} existing assertions remain.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
