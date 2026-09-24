/**
 * Rehearsal behaviour against a fixture repository built from scratch.
 *
 * Every case runs against a temporary repository with its own local refs, so the suite needs no
 * remote and no network: the fork and "upstream" are two branches of one local repository, and
 * the conflicts are real Git conflicts rather than stubbed parser input.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RehearsalError,
  classifyConflicts,
  confirmPin,
  parseMergeTree,
  readUpstreamPin,
  rehearse,
  resolveRefCommit,
} from './upstream-sync-rehearsal.ts'

const SCRIPT = join(import.meta.dirname, 'upstream-sync-rehearsal.ts')

/**
 * Absolute URL of the TypeScript loader this repository uses for source launch.
 *
 * The loader is named by its installed path rather than by the bare `tsx/esm` specifier: the child
 * process runs with a fixture as its working directory, which has no `node_modules` to resolve a
 * bare specifier from.
 */
const TSX_LOADER = pathToFileURL(
  join(dirname(resolve(createRequire(import.meta.url).resolve('tsx/package.json'))), 'dist/esm/index.mjs'),
).href

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(cwd, '.gitconfig-absent'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
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
 * Build a repository where the fork and upstream diverge, both edit one file, and each side
 * deletes a file the other side edited.
 * @returns The fixture root and the commits needed to assert against them.
 */
function createFixture(): { root: string; base: string; upstream: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rehearsal-'))
  fixtures.push(root)
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'user.name', 'Rehearsal Fixture'])
  git(root, ['config', 'commit.gpgsign', 'false'])

  write(root, 'both.txt', 'shared base\n')
  write(root, 'fork-deletes.txt', 'base\n')
  write(root, 'upstream-deletes.txt', 'base\n')
  write(root, 'shared-only.txt', 'untouched by either side\n')
  const base = commit(root, 'base')

  // Upstream advances: edits both.txt, edits the file the fork will delete, deletes the file the
  // fork will edit, and adds a file of its own.
  git(root, ['checkout', '--quiet', '-b', 'upstream', base])
  write(root, 'both.txt', 'upstream edit\n')
  write(root, 'fork-deletes.txt', 'upstream edit\n')
  git(root, ['rm', '--quiet', 'upstream-deletes.txt'])
  write(root, 'upstream-only.txt', 'upstream addition\n')
  const upstream = commit(root, 'upstream advances')

  // The fork advances from the same base: edits both.txt differently, deletes one file, edits the
  // file upstream deleted, and adds a file of its own.
  git(root, ['checkout', '--quiet', '-b', 'fork', base])
  write(root, 'both.txt', 'fork edit\n')
  git(root, ['rm', '--quiet', 'fork-deletes.txt'])
  write(root, 'upstream-deletes.txt', 'fork edit\n')
  write(root, 'fork-only.txt', 'fork addition\n')
  commit(root, 'fork advances')
  git(root, ['branch', '--quiet', '-f', 'origin/master', upstream])
  git(root, ['checkout', '--quiet', 'fork'])

  const mergerBase = git(root, ['merge-base', 'HEAD', 'origin/master']).trim()
  expect(mergerBase).toBe(base)
  return { root, base, upstream }
}

function writePin(root: string, pinnedCommit: string): void {
  writeFileSync(join(root, 'upstream.json'), `${JSON.stringify({
    repository: 'https://example.invalid/upstream.git',
    pinnedCommit,
    pinnedVersion: '9.9.9',
    derivedFrom: 'git merge-base HEAD origin/master',
  }, undefined, 2)}\n`)
}

describe('readUpstreamPin', () => {
  it('rejects a missing pin file by name', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rehearsal-'))
    fixtures.push(root)
    expect(() => readUpstreamPin(root)).toThrow(/no upstream\.json/u)
  })

  it('rejects a pin whose fields are absent or empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rehearsal-'))
    fixtures.push(root)
    writeFileSync(join(root, 'upstream.json'), `${JSON.stringify({ repository: 'x', pinnedCommit: '' })}\n`)
    expect(() => readUpstreamPin(root)).toThrow(/pinnedCommit/u)
  })
})

describe('parseMergeTree', () => {
  it('separates a written tree from conflicts and accepts a clean merge', () => {
    const clean = parseMergeTree('a'.repeat(40))
    expect(clean).toEqual({ tree: 'a'.repeat(40), conflicts: [] })
    expect(parseMergeTree('')).toEqual({ tree: '', conflicts: [] })
  })

  it('reads both conflict kinds and ignores auto-merge chatter', () => {
    const stdout = [
      'b'.repeat(40),
      'Auto-merging shared-only.txt',
      'CONFLICT (content): Merge conflict in both.txt',
      'CONFLICT (modify/delete): gone.txt deleted in origin/master and modified in HEAD. Version HEAD of gone.txt left in tree.',
    ].join('\n')
    expect(parseMergeTree(stdout).conflicts).toEqual([
      { path: 'both.txt', kind: 'content' },
      { path: 'gone.txt', kind: 'modify/delete' },
    ])
  })
})

describe('confirmPin', () => {
  it('accepts the pin Git derives and rejects a stale one with both commits named', () => {
    const { root, base } = createFixture()
    writePin(root, base)
    expect(confirmPin(root, 'origin/master')).toBe(base)

    writePin(root, 'c'.repeat(40))
    expect(() => confirmPin(root, 'origin/master')).toThrow(RehearsalError)
    expect(() => confirmPin(root, 'origin/master')).toThrow(new RegExp(`${'c'.repeat(40)}.*${base}`, 'su'))
  })

  it('fails on a ref that does not exist instead of passing silently', () => {
    const { root, base } = createFixture()
    writePin(root, base)
    expect(() => resolveRefCommit(root, 'origin/absent')).toThrow(/does not resolve to a commit/u)
    expect(() => confirmPin(root, 'origin/absent')).toThrow(/does not resolve to a commit/u)
  })
})

describe('rehearse', () => {
  it('confirms the pin, classifies both conflict kinds, and changes nothing', () => {
    const { root, base, upstream } = createFixture()
    writePin(root, base)
    const before = git(root, ['status', '--porcelain'])
    const refsBefore = git(root, ['show-ref'])

    const report = rehearse(root, { ref: 'origin/master' })

    expect(report.pinnedCommit).toBe(base)
    expect(report.refCommit).toBe(upstream)
    expect(report.tree).toMatch(/^[0-9a-f]{40}$/u)
    expect(report.contentConflicts).toBe(1)
    expect(report.modifyDeleteConflicts).toBe(2)
    expect(report.conflicts).toEqual([
      { path: 'both.txt', kind: 'content' },
      { path: 'fork-deletes.txt', kind: 'modify/delete' },
      { path: 'upstream-deletes.txt', kind: 'modify/delete' },
    ])
    expect(report.workingTreeUnchanged).toBe(true)
    expect(report.refsUnchanged).toBe(true)

    // The safety property is asserted against the fixture itself, not only via the report flags.
    expect(git(root, ['status', '--porcelain'])).toBe(before)
    expect(git(root, ['show-ref'])).toBe(refsBefore)
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(git(root, ['rev-parse', 'fork']).trim())
    expect(existsSync(join(root, 'fork-deletes.txt'))).toBe(false)
    expect(existsSync(join(root, 'upstream-deletes.txt'))).toBe(true)
  })

  it('refuses to rehearse against a ref the pin does not record', () => {
    const { root, base } = createFixture()
    writePin(root, 'c'.repeat(40))
    expect(() => rehearse(root, { ref: 'origin/master' })).toThrow(/would not describe the move/u)
    expect(base).not.toBe('c'.repeat(40))
  })

  it('names which side of a modify/delete conflict Git leaves in the tree', () => {
    const { root, base } = createFixture()
    writePin(root, base)
    const report = rehearse(root, { ref: 'origin/master' })
    // Git reports the direction rather than resolving it: a file upstream deleted survives, and a
    // file the fork deleted stays deleted. Both are product decisions, so both must be nameable.
    expect(report.conflicts.filter(candidate => candidate.kind === 'modify/delete').map(candidate => candidate.path))
      .toEqual(['fork-deletes.txt', 'upstream-deletes.txt'])
    expect(existsSync(join(root, 'fork-deletes.txt'))).toBe(false)
    expect(readFileSync(join(root, 'upstream-deletes.txt'), 'utf8')).toBe('fork edit\n')
  })

  it('leaves untracked files in the fixture alone', () => {
    const { root, base } = createFixture()
    writePin(root, base)
    write(root, 'scratch.txt', 'untracked\n')
    const before = git(root, ['status', '--porcelain'])
    rehearse(root, { ref: 'origin/master' })
    expect(git(root, ['status', '--porcelain'])).toBe(before)
  })
})

describe('classifyConflicts', () => {
  it('sorts by path and counts each kind', () => {
    const result = classifyConflicts([
      { path: 'z.txt', kind: 'modify/delete' },
      { path: 'a.txt', kind: 'content' },
      { path: 'b.txt', kind: 'content' },
    ])
    expect(result.conflicts.map(entry => entry.path)).toEqual(['a.txt', 'b.txt', 'z.txt'])
    expect(result.contentConflicts).toBe(2)
    expect(result.modifyDeleteConflicts).toBe(1)
  })
})

describe('command line', () => {
  it('exits non-zero and names the mismatch when the pin is stale', () => {
    const { root, base } = createFixture()
    writePin(root, 'c'.repeat(40))
    const outcome = runCli(root)
    expect(outcome.status).not.toBe(0)
    expect(outcome.stderr).toContain('c'.repeat(40))
    expect(outcome.stderr).toContain(base)
  })

  it('prints the classified summary and writes the report when asked', () => {
    const { root, base } = createFixture()
    writePin(root, base)
    const outcome = runCli(root, ['--out', 'rehearsal.json'])
    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toContain('3 conflicted file(s): 1 content, 2 modify/delete')
    expect(outcome.stdout).toContain('working tree unchanged=true refs unchanged=true')
    const report = JSON.parse(readFileSync(join(root, 'rehearsal.json'), 'utf8')) as { conflicts: unknown[] }
    expect(report.conflicts).toHaveLength(3)
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    const { root, base } = createFixture()
    writePin(root, base)
    const outcome = runCli(root, ['--ref'])
    expect(outcome.status).not.toBe(0)
    expect(outcome.stderr).toContain('requires a value')
  })
})

/**
 * Run the rehearsal CLI inside a fixture repository.
 *
 * `--repo` is how the CLI is pointed away from the checkout it belongs to; the child is a bare Node
 * process, so it also needs the TypeScript loader this repository uses for source launch.
 */
function runCli(cwd: string, args: readonly string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--repo', cwd, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${TSX_LOADER}`,
        GIT_CONFIG_GLOBAL: join(cwd, '.gitconfig-absent'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}
