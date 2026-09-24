/**
 * Upstream-sync triage against a fixture repository built from scratch.
 *
 * The triage removes judgement from the repeated half of an upstream sync: each conflicted path is
 * assigned an owner mechanically, from what HEAD and the upstream ref contain, so a maintainer only
 * decides the paths that genuinely need a decision. The fixture below produces all three owners at
 * once, with no remote and no network.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GENERATED_MANIFEST,
  classifyConflicts,
  groupByOwner,
  readGeneratedManifest,
  readMergeTrees,
  triage,
  type ConflictEntry,
} from './upstream-sync-triage.ts'

const REPO = join(import.meta.dirname, '..')

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, '.absent'), GIT_CONFIG_NOSYSTEM: '1' },
  })
}

function write(cwd: string, path: string, body: string): void {
  const target = join(cwd, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '--quiet', '--no-gpg-sign', '-m', message])
  return git(cwd, ['rev-parse', 'HEAD']).trim()
}

/**
 * Build a fork/upstream pair whose merge yields one conflict of each ownership.
 *
 * Paths are named for the side that still holds them, because that side owns the decision:
 * `fork-kept.txt` is edited by the fork and deleted upstream, so the product decides whether to keep
 * it. `upstream-kept.txt` is the mirror image, and upstream's deletion is upstream's call to accept.
 * `shared.txt` is edited by both, so its resolution merges two intentions and neither side owns it.
 */
function createFixture(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-triage-'))
  fixtures.push(root)
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'triage@example.invalid'])
  git(root, ['config', 'user.name', 'Triage Fixture'])
  git(root, ['config', 'commit.gpgsign', 'false'])

  write(root, 'shared.txt', 'base\n')
  write(root, 'fork-kept.txt', 'base\n')
  write(root, 'upstream-kept.txt', 'base\n')
  const base = commit(root, 'base')

  git(root, ['checkout', '--quiet', '-b', 'upstream', base])
  write(root, 'shared.txt', 'upstream edit\n')
  write(root, 'upstream-kept.txt', 'upstream edit\n')
  git(root, ['rm', '--quiet', 'fork-kept.txt'])
  const upstream = commit(root, 'upstream advances')

  git(root, ['checkout', '--quiet', '-b', 'fork', base])
  write(root, 'shared.txt', 'fork edit\n')
  write(root, 'fork-kept.txt', 'fork edit\n')
  git(root, ['rm', '--quiet', 'upstream-kept.txt'])
  commit(root, 'fork advances')
  git(root, ['branch', '--quiet', '-f', 'origin/master', upstream])
  git(root, ['checkout', '--quiet', 'fork'])

  expect(git(root, ['merge-base', 'HEAD', 'origin/master']).trim()).toBe(base)
  return { root, base }
}

function writePin(root: string, pinnedCommit: string): void {
  writeFileSync(join(root, 'upstream.json'), `${JSON.stringify({
    repository: 'https://example.invalid/upstream.git',
    pinnedCommit,
    pinnedVersion: '9.9.9',
    derivedFrom: 'git merge-base HEAD origin/master',
  }, undefined, 2)}\n`)
}

function writeManifest(root: string, paths: { path: string; generator: string }[]): string {
  const relative = '.local/generated-paths.json'
  write(root, relative, `${JSON.stringify({ description: 'fixture', paths })}\n`)
  return relative
}

const CONFLICTS: ConflictEntry[] = [
  { path: 'fork-kept.txt', kind: 'modify/delete' },
  { path: 'upstream-kept.txt', kind: 'modify/delete' },
  { path: 'shared.txt', kind: 'content' },
]

describe('readMergeTrees', () => {
  it('reports which sides hold each path', () => {
    const { root } = createFixture()
    const trees = readMergeTrees(root, 'origin/master')
    // Each kept-name file survives on exactly one side, so a test can see which side that is.
    expect(trees.head.has('fork-kept.txt')).toBe(true)
    expect(trees.upstream.has('fork-kept.txt')).toBe(false)
    expect(trees.head.has('upstream-kept.txt')).toBe(false)
    expect(trees.upstream.has('upstream-kept.txt')).toBe(true)
    expect(trees.head.has('shared.txt')).toBe(true)
    expect(trees.upstream.has('shared.txt')).toBe(true)
  })

  it('rejects a ref the repository does not have', () => {
    const { root } = createFixture()
    expect(() => readMergeTrees(root, 'origin/absent')).toThrow(/does not resolve/u)
  })
})

describe('classifyConflicts', () => {
  it('assigns each deletion to the side that still holds the file', () => {
    const { root } = createFixture()
    const trees = readMergeTrees(root, 'origin/master')
    expect(classifyConflicts(CONFLICTS, trees, new Map())).toEqual([
      { path: 'fork-kept.txt', kind: 'modify/delete', owner: 'product', generator: null },
      { path: 'shared.txt', kind: 'content', owner: 'own', generator: null },
      { path: 'upstream-kept.txt', kind: 'modify/delete', owner: 'upstream', generator: null },
    ])
  })

  it('gives a declared generator ownership of a path neither side deleted', () => {
    const { root } = createFixture()
    const trees = readMergeTrees(root, 'origin/master')
    const generated = new Map([['shared.txt', 'scripts/gen-tool-catalog.ts']])
    expect(classifyConflicts([{ path: 'shared.txt', kind: 'content' }], trees, generated)).toEqual([
      { path: 'shared.txt', kind: 'content', owner: 'generated', generator: 'scripts/gen-tool-catalog.ts' },
    ])
  })

  it('keeps a deletion decision with the side that holds the file even when a generator claims the path', () => {
    const { root } = createFixture()
    const trees = readMergeTrees(root, 'origin/master')
    const generated = new Map([['fork-kept.txt', 'scripts/gen-tool-catalog.ts']])
    expect(classifyConflicts([{ path: 'fork-kept.txt', kind: 'modify/delete' }], trees, generated)).toEqual([
      { path: 'fork-kept.txt', kind: 'modify/delete', owner: 'product', generator: null },
    ])
  })

  it('orders ownership by path so a record is comparable run to run', () => {
    const { root } = createFixture()
    const trees = readMergeTrees(root, 'origin/master')
    const input: ConflictEntry[] = [
      { path: 'shared.txt', kind: 'content' },
      { path: 'upstream-kept.txt', kind: 'modify/delete' },
      { path: 'fork-kept.txt', kind: 'modify/delete' },
    ]
    expect(classifyConflicts(input, trees, new Map()).map(entry => entry.path))
      .toEqual(['fork-kept.txt', 'shared.txt', 'upstream-kept.txt'])
  })
})

describe('groupByOwner', () => {
  it('lists every path under exactly one owner', () => {
    // Both sides hold each path, so ownership can only be `own` or, where declared, `generated`.
    const trees = { head: new Set(['a.txt', 'b.txt', 'c.txt']), upstream: new Set(['a.txt', 'b.txt', 'c.txt']) }
    const entries = classifyConflicts([
      { path: 'a.txt', kind: 'content' },
      { path: 'b.txt', kind: 'content' },
      { path: 'c.txt', kind: 'content' },
    ], trees, new Map([['b.txt', 'scripts/gen-x.ts']]))
    expect(groupByOwner(entries)).toEqual({
      product: [],
      upstream: [],
      generated: ['b.txt'],
      own: ['a.txt', 'c.txt'],
    })
  })
})

describe('readGeneratedManifest', () => {
  it('reads declared ownership and an absent manifest as no declarations', () => {
    const { root } = createFixture()
    write(root, 'docs/tool-catalog.md', 'generated\n')
    const relative = writeManifest(root, [{ path: 'docs/tool-catalog.md', generator: 'scripts/gen-tool-catalog.ts' }])
    expect(readGeneratedManifest(root, relative).get('docs/tool-catalog.md')).toBe('scripts/gen-tool-catalog.ts')
    expect(readGeneratedManifest(root, '.local/absent.json').size).toBe(0)
  })

  it('fails loud on a malformed record or a declared path that does not exist', () => {
    const { root } = createFixture()
    write(root, '.local/bad.json', '{ "paths": [{ "path": "x", "generator": 3 }] }\n')
    expect(() => readGeneratedManifest(root, '.local/bad.json')).toThrow(/non-empty string/u)
    const relative = writeManifest(root, [{ path: 'docs/absent.md', generator: 'scripts/gen-absent.ts' }])
    expect(() => readGeneratedManifest(root, relative)).toThrow(/does not exist/u)
  })

  it('fails loud when two generators claim one path', () => {
    const { root } = createFixture()
    write(root, 'docs/shared.md', 'generated\n')
    const relative = writeManifest(root, [
      { path: 'docs/shared.md', generator: 'scripts/gen-a.ts' },
      { path: 'docs/shared.md', generator: 'scripts/gen-b.ts' },
    ])
    expect(() => readGeneratedManifest(root, relative)).toThrow(/claim/u)
  })
})

describe('this repository\'s generated manifest', () => {
  it('ships the declared manifest as a delivered file beside this script', () => {
    // The default path must be delivered with the repository: a checkout without it could not
    // triage at all. `--cached --others --exclude-standard` accepts a file that is committed or
    // merely new, and rejects one sitting under an ignored directory, which is the defect this
    // assertion exists to prevent recurring.
    expect(DEFAULT_GENERATED_MANIFEST.startsWith('.local/')).toBe(false)
    expect(existsSync(join(REPO, DEFAULT_GENERATED_MANIFEST))).toBe(true)
    const delivered = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n')
    expect(delivered).toContain(DEFAULT_GENERATED_MANIFEST)
  })

  it('declares existing, uniquely owned paths that include the recurring conflicts', () => {
    const outputs = readGeneratedManifest(REPO, DEFAULT_GENERATED_MANIFEST)
    expect(outputs.get('docs/tool-catalog.md')).toBe('scripts/gen-tool-catalog.ts')
    expect(outputs.get('docs/config-catalog.md')).toBe('scripts/gen-config-catalog.ts')
    expect(outputs.get('docs/module-graph.md')).toBe('scripts/gen-module-graph.ts')
    expect(outputs.get('docs/module-graph.zh.md')).toBe('scripts/gen-module-graph.ts')
    expect(outputs.get('docs/module-graph.i18n.yaml')).toBe('scripts/gen-module-graph.ts')
    expect(outputs.size).toBeGreaterThanOrEqual(19)
    for (const [path, generator] of outputs) {
      expect(path.startsWith('/')).toBe(false)
      expect(generator).toMatch(/^scripts\/gen-[a-z-]+\.ts$/u)
    }
  })

  it('names a generator that exists for every declared path', () => {
    const outputs = readGeneratedManifest(REPO, DEFAULT_GENERATED_MANIFEST)
    for (const generator of new Set(outputs.values())) {
      expect(readFileSync(join(REPO, generator), 'utf8').length).toBeGreaterThan(0)
    }
  })
})

describe('triage', () => {
  it('classifies every conflict, confirms the pin, and mutates nothing', () => {
    const { root, base } = createFixture()
    writePin(root, base)
    const before = git(root, ['status', '--porcelain'])
    const refsBefore = git(root, ['show-ref'])

    const record = triage(root, { ref: 'origin/master' })

    expect(record.pinnedCommit).toBe(base)
    expect(record.conflicts).toEqual([
      { path: 'fork-kept.txt', kind: 'modify/delete', owner: 'product', generator: null },
      { path: 'shared.txt', kind: 'content', owner: 'own', generator: null },
      { path: 'upstream-kept.txt', kind: 'modify/delete', owner: 'upstream', generator: null },
    ])
    expect(record.counts).toEqual({ product: 1, upstream: 1, generated: 0, own: 1 })
    expect(record.safe).toBe(true)
    expect(git(root, ['status', '--porcelain'])).toBe(before)
    expect(git(root, ['show-ref'])).toBe(refsBefore)
  })

  it('classifies every path, leaving none unowned', () => {
    const { root, base } = createFixture()
    writePin(root, base)
    const record = triage(root, { ref: 'origin/master' })
    const grouped = groupByOwner(record.conflicts)
    expect(Object.values(grouped).flat().sort()).toEqual(record.conflicts.map(entry => entry.path))
  })

  it('refuses a stale pin instead of triaging the wrong move', () => {
    const { root } = createFixture()
    writePin(root, 'd'.repeat(40))
    expect(() => triage(root, { ref: 'origin/master' })).toThrow(/would not describe the move/u)
  })
})
