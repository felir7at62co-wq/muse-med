import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attempt } from '../../../scripts/release/process.ts'
import {
  assertCleanWorktree,
  assertPackagingInputs,
  assertReusableArtifacts,
  collectReusedArtifacts,
  describeReuse,
  describeSteps,
  desktopPackageSteps,
  dirtyWorktreeEntries,
  readDesktopPackageBaseline,
  runDesktopPackageSteps,
  selectPackageSteps,
  type DesktopPackageBaseline,
  type DesktopPackageRunStep,
} from '../scripts/package-steps.ts'

const created: string[] = []

/** Run one git command in a fixture repository and fail on a non-zero exit. */
function git(root: string, args: readonly string[]): string {
  const result = attempt('git', [...args], { cwd: root })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** Create a repository with one commit and a clean worktree. */
function tempRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-resume-'))
  created.push(root)
  git(root, ['init', '--quiet'])
  writeFileSync(join(root, 'tracked.txt'), 'committed\n')
  git(root, ['add', '.'])
  git(root, ['-c', 'user.email=spec@example.com', '-c', 'user.name=spec', 'commit', '--quiet', '-m', 'one'])
  return root
}

/** Commit an empty change, which moves HEAD without touching the worktree. */
function commitEmptyHead(root: string): void {
  git(root, ['-c', 'user.email=spec@example.com', '-c', 'user.name=spec', 'commit', '--allow-empty', '--quiet', '-m', 'two'])
}

/** One synthetic step that records that it ran. */
function recordingStep(root: string, id: 'S1' | 'S2' | 'S3', ran: string[]): DesktopPackageRunStep {
  return {
    id,
    title: `fixture ${id}`,
    artifacts: [],
    run: async () => { ran.push(`${id}:${root}`) },
  }
}

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('desktop package worktree guards', () => {
  it('reports every change except the harness state a packaging run may ignore', () => {
    const porcelain = [
      ' M .pi-glla/active.jsonl',
      '?? .pi-glla/',
      ' M packages/drama/tool-shot-script/src/index.ts',
      '?? apps/desktop/scripts/package-steps.ts',
      'R  old/name.ts -> packages/core/agent/src/renamed.ts',
      ' M "packages/core/agent/src/with space.ts"',
    ].join('\n')
    expect(dirtyWorktreeEntries(porcelain)).toEqual([
      ' M packages/drama/tool-shot-script/src/index.ts',
      '?? apps/desktop/scripts/package-steps.ts',
      'R  old/name.ts -> packages/core/agent/src/renamed.ts',
      ' M "packages/core/agent/src/with space.ts"',
    ])
    expect(dirtyWorktreeEntries('')).toEqual([])
  })

  it('refuses a dirty tree and accepts one whose only change is harness state', () => {
    const root = tempRepository()
    const clean = readDesktopPackageBaseline(root)
    expect(() => { assertCleanWorktree(clean) }).not.toThrow()

    mkdirSync(join(root, '.pi-glla'), { recursive: true })
    writeFileSync(join(root, '.pi-glla', 'active.jsonl'), '{}\n')
    expect(() => { assertCleanWorktree(readDesktopPackageBaseline(root)) }).not.toThrow()

    git(root, ['add', '.pi-glla/active.jsonl'])
    git(root, ['-c', 'user.email=spec@example.com', '-c', 'user.name=spec', 'commit', '--quiet', '-m', 'track harness state'])
    const baseline = readDesktopPackageBaseline(root)
    writeFileSync(join(root, '.pi-glla', 'active.jsonl'), '{"changed":true}\n')
    expect(() => { assertCleanWorktree(readDesktopPackageBaseline(root)) }).not.toThrow()
    expect(() => { assertPackagingInputs(root, baseline) }).not.toThrow()

    writeFileSync(join(root, 'tracked.txt'), 'edited in the tree\n')
    expect(() => { assertPackagingInputs(root, baseline) }).toThrow(/worktree changed[\s\S]*tracked\.txt/u)
    expect(() => { assertCleanWorktree(readDesktopPackageBaseline(root)) })
      .toThrow(/not clean[\s\S]*tracked\.txt/u)
  })

  it('refuses the next step once HEAD moved, and names the resume command', async () => {
    const root = tempRepository()
    const baseline = readDesktopPackageBaseline(root)
    const ran: string[] = []
    const steps: DesktopPackageRunStep[] = [
      { ...recordingStep(root, 'S1', ran), run: async () => { ran.push('S1'); commitEmptyHead(root) } },
      recordingStep(root, 'S2', ran),
      recordingStep(root, 'S3', ran),
    ]
    await expect(runDesktopPackageSteps({
      root,
      steps,
      selection: { first: 0, last: 3 },
      baseline,
      log: () => {},
    })).rejects.toThrow(/HEAD moved/u)
    expect(ran).toEqual(['S1'])
    expect(baseline.head).not.toBe(git(root, ['rev-parse', 'HEAD']).trim())
  })

  it('tells the operator how to resume after a step fails', async () => {
    const root = tempRepository()
    const baseline = readDesktopPackageBaseline(root)
    const lines: string[] = []
    const steps: DesktopPackageRunStep[] = [{
      id: 'S1',
      title: 'fixture S1',
      artifacts: [],
      run: async () => { throw new Error('pnpm run build:official exited with 1') },
    }]
    await expect(runDesktopPackageSteps({
      root,
      steps,
      selection: { first: 0, last: 1 },
      baseline,
      log: line => lines.push(line),
    })).rejects.toThrow(/build:official exited with 1/u)
    expect(lines.join('\n')).toMatch(/--from S1/u)
  })
})

describe('desktop package reuse inventory', () => {
  /** A baseline whose commit time sits between the old and fresh artifacts. */
  function baselineAt(committedAtMs: number): DesktopPackageBaseline {
    return { head: 'a'.repeat(40), committedAtMs, treeChanges: [] }
  }

  it('lists what a resume reuses, and refuses artifacts older than the commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-reuse-'))
    created.push(root)
    const packed = join(root, 'packed')
    mkdirSync(packed, { recursive: true })
    const fresh = join(packed, 'fresh-1.0.0.tgz')
    const old = join(packed, 'old-1.0.0.tgz')
    writeFileSync(fresh, 'fresh bytes')
    writeFileSync(old, 'old bytes')
    const committedAtMs = Date.now() - 60_000
    const stale = new Date(committedAtMs - 60_000)
    utimesSync(old, stale, stale)
    const steps = [{
      id: 'S2' as const,
      title: 'pack the dsh family tarballs',
      artifacts: [
        { glob: 'packed/*.tgz', label: 'fixture tarballs', kind: 'files' as const },
        { glob: 'packed/missing.json', label: 'fixture record', kind: 'files' as const },
      ],
    }]

    const inventory = collectReusedArtifacts(root, steps, 1, baselineAt(committedAtMs))
    expect(inventory.missing).toEqual(['S2 declares packed/missing.json (fixture record) and nothing matches it'])
    expect(inventory.stale).toEqual([
      `S2 ${relative(root, old).replaceAll('\\', '/')} was last written ${stale.toISOString()},`
      + ` before ${'a'.repeat(12)} was committed at ${new Date(committedAtMs).toISOString()}`,
    ])
    const listing = describeReuse(inventory, true).join('\n')
    expect(listing).toMatch(/reuse S2 2 file\(s\)/u)
    expect(listing).toMatch(/packed\/fresh-1\.0\.0\.tgz/u)
    expect(listing).toMatch(/sha256=[0-9a-f]{16}/u)
    expect(() => { assertReusableArtifacts(inventory, baselineAt(committedAtMs)) })
      .toThrow(/2 artifact problem\(s\)[\s\S]*missing\.json[\s\S]*old-1\.0\.0\.tgz/u)

    utimesSync(old, new Date(), new Date())
    const repaired = collectReusedArtifacts(root, [{ ...steps[0]!, artifacts: [steps[0]!.artifacts[0]!] }], 1, baselineAt(committedAtMs))
    expect(() => { assertReusableArtifacts(repaired, baselineAt(committedAtMs)) }).not.toThrow()
  })
})

describe('desktop package step table', () => {
  it('names the thirteen steps in execution order and selects a range from the flags', () => {
    const steps = desktopPackageSteps(process.cwd(), 'win-x64', false)
    expect(steps.map(step => step.id)).toEqual([
      'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13',
    ])
    expect(steps.flatMap(step => step.artifacts).every(artifact => !artifact.glob.startsWith('/'))).toBe(true)
    expect(describeSteps(steps).join('\n')).toMatch(/S12 {2}materialize the dsh runtime tree/u)
    expect(selectPackageSteps(steps, undefined, undefined)).toEqual({ first: 0, last: 13 })
    expect(selectPackageSteps(steps, 'S8', undefined)).toEqual({ first: 7, last: 13 })
    expect(selectPackageSteps(steps, undefined, 'S12')).toEqual({ first: 11, last: 12 })
    expect(() => selectPackageSteps(steps, 'S1', 'S2')).toThrow(/mutually exclusive/u)
    expect(() => selectPackageSteps(steps, 'S14', undefined)).toThrow(/unknown step "S14"; expected one of S1/u)
  })

  it('declares each platform media payload for resumed packaging', () => {
    const media = (target: 'win-x64' | 'mac-arm64'): string[] =>
      desktopPackageSteps(process.cwd(), target, target === 'win-x64')
        .flatMap(step => step.artifacts.map(artifact => artifact.glob))
        .filter(glob => glob.includes('media'))
    expect(media('win-x64')).toEqual(['apps/desktop/.desktop-build/targets/win-x64/runtime/media'])
    expect(media('mac-arm64')).toEqual(['apps/desktop/.desktop-build/targets/mac-arm64/runtime/media'])
  })

  it('records the unsigned installer directory when the run is unsigned', () => {
    const globs = (unsigned: boolean): string[] =>
      desktopPackageSteps(process.cwd(), 'win-x64', unsigned)
        .at(-1)!.artifacts.map(artifact => artifact.glob)
    expect(globs(false)).toEqual(['apps/desktop/.desktop-build/targets/win-x64/artifacts'])
    expect(globs(true)).toEqual(['apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts'])
  })
})
