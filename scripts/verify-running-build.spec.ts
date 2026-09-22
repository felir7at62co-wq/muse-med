/** The running-build check: what it judges, and how it reads a profile's module tree. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STALE_TOLERANCE_MS,
  chainedPackages,
  inspectPackage,
  loadedPackages,
  moduleDirectories,
  newestMtime,
  verdictOf,
  workspacePackages,
} from './verify-running-build.ts'

const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** One temporary directory the spec owns. */
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'verify-running-build-'))
  temporary.push(directory)
  return directory
}

/** Write one file, creating its parents. */
function write(path: string, contents = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
}

/** Stamp one path's modification time, in seconds since the epoch. */
function stamp(path: string, seconds: number): void {
  utimesSync(path, seconds, seconds)
}

describe('verdictOf', () => {
  const facts = { loadsWorkspacePackage: true, hasBundle: true, newestSourceMs: 1_000, bundleMs: 2_000 }

  it('passes a bundle newer than its sources', () => {
    expect(verdictOf(facts).verdict).toBe('current')
  })

  it('reports a bundle older than its sources, with the rebuild commands', () => {
    const judged = verdictOf({ ...facts, newestSourceMs: 5_000 })
    expect(judged.verdict).toBe('stale')
    expect(judged.fix).toContain('build:lib:host')
    expect(judged.fix).toContain('tsdown')
  })

  it('tolerates a bundle written within the same second as its source', () => {
    expect(verdictOf({ ...facts, newestSourceMs: facts.bundleMs + STALE_TOLERANCE_MS }).verdict)
      .toBe('current')
  })

  it('reports a package this checkout never built a bundle for', () => {
    expect(verdictOf({ ...facts, hasBundle: false }).verdict).toBe('missing_bundle')
  })
  it('passes a profile copy that is as new as this checkout', () => {
    expect(verdictOf({ ...facts, loadsWorkspacePackage: false }).verdict).toBe('copied')
  })

  it('reports a profile copy this checkout has since moved past, naming the repair', () => {
    const judged = verdictOf({ ...facts, loadsWorkspacePackage: false, newestSourceMs: 5_000 })
    expect(judged.verdict).toBe('behind')
    expect(judged.fix).toContain('重启宿主')
  })
})

describe('newestMtime', () => {
  it('returns the newest file and ignores a missing one', () => {
    const root = tempDir()
    write(join(root, 'a.ts'))
    write(join(root, 'b.ts'))
    stamp(join(root, 'a.ts'), 1_000)
    stamp(join(root, 'b.ts'), 3_000)
    expect(newestMtime([join(root, 'a.ts'), join(root, 'b.ts'), join(root, 'gone.ts')])).toBe(3_000_000)
  })

  it('returns zero when there is no file at all', () => {
    expect(newestMtime([])).toBe(0)
  })
})

describe('workspacePackages', () => {
  it('maps each package name to its directory and skips non-packages', () => {
    const root = tempDir()
    write(join(root, 'packages', 'drama', 'alpha', 'package.json'), JSON.stringify({ name: '@x/alpha' }))
    write(join(root, 'packages', 'drama', 'beta', 'package.json'), 'not json')
    mkdirSync(join(root, 'packages', 'drama', 'loose'), { recursive: true })
    const found = workspacePackages(root)
    expect([...found.keys()]).toEqual(['@x/alpha'])
    expect(found.get('@x/alpha')).toBe(join(root, 'packages', 'drama', 'alpha'))
  })

  it('returns nothing when the checkout has no packages directory', () => {
    expect(workspacePackages(tempDir()).size).toBe(0)
  })
})

describe('loadedPackages', () => {
  it('follows a link to the directory the profile really loads', () => {
    const root = tempDir()
    const real = join(root, 'checkout', 'packages', 'drama', 'alpha')
    mkdirSync(real, { recursive: true })
    const scope = join(root, 'profile', 'node_modules', '@deepseek-ai')
    mkdirSync(scope, { recursive: true })
    symlinkSync(real, join(scope, 'dsh-alpha'), 'junction')
    expect(loadedPackages(join(root, 'profile', 'node_modules')))
      .toEqual([{ name: '@deepseek-ai/dsh-alpha', resolved: real }])
  })

  it('returns nothing when the profile has no scope directory', () => {
    expect(loadedPackages(join(tempDir(), 'node_modules'))).toEqual([])
  })
})

describe('module resolution chain', () => {
  /** One directory holding a linked `@deepseek-ai/dsh-alpha` that reaches `real`. */
  function chainLink(directory: string, real: string): void {
    const scope = join(directory, 'node_modules', '@deepseek-ai')
    mkdirSync(scope, { recursive: true })
    symlinkSync(real, join(scope, 'dsh-alpha'), 'junction')
  }

  it('reads the profile, its parent, and the shared root, nearest first', () => {
    const root = tempDir()
    const profile = join(root, 'profiles', 'web')
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'profiles', 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    expect(moduleDirectories(profile)).toEqual([
      join(profile, 'node_modules'),
      join(root, 'profiles', 'node_modules'),
      join(root, 'node_modules'),
    ])
  })

  it('skips a directory that does not exist rather than reporting it', () => {
    const profile = join(tempDir(), 'profiles', 'web')
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    expect(moduleDirectories(profile)).toEqual([join(profile, 'node_modules')])
  })

  it('reports a package found above the profile, which is where a preset row resolves', () => {
    const root = tempDir()
    const profile = join(root, 'profiles', 'web')
    const mounted = join(root, 'checkout', 'alpha')
    mkdirSync(profile, { recursive: true })
    mkdirSync(mounted, { recursive: true })
    chainLink(join(root, 'profiles'), mounted)
    expect(chainedPackages(profile)).toEqual([{ name: '@deepseek-ai/dsh-alpha', resolved: mounted }])
  })

  it('reports the nearer entry when both the profile and its parent hold the package', () => {
    const root = tempDir()
    const profile = join(root, 'profiles', 'web')
    const near = join(root, 'checkout', 'near')
    const far = join(root, 'checkout', 'far')
    mkdirSync(near, { recursive: true })
    mkdirSync(far, { recursive: true })
    chainLink(profile, near)
    chainLink(join(root, 'profiles'), far)
    expect(chainedPackages(profile)).toEqual([{ name: '@deepseek-ai/dsh-alpha', resolved: near }])
  })
})

describe('inspectPackage', () => {
  it('calls a package current when its bundle is newer than every source', () => {
    const root = tempDir()
    const workspace = join(root, 'packages', 'drama', 'alpha')
    write(join(workspace, 'src', 'index.ts'))
    write(join(workspace, 'lib', 'index.js'))
    stamp(join(workspace, 'src', 'index.ts'), 1_000)
    stamp(join(workspace, 'lib', 'index.js'), 2_000)
    const row = inspectPackage({ name: '@x/alpha', loaded: workspace, workspace })
    expect(row).toMatchObject({ verdict: 'current', fix: '' })
    expect(row.newestSource).not.toBe('')
    expect(row.bundle).not.toBe('')
  })

  it('calls a package stale when a source is newer than its bundle', () => {
    const root = tempDir()
    const workspace = join(root, 'packages', 'drama', 'alpha')
    write(join(workspace, 'src', 'index.ts'))
    write(join(workspace, 'lib', 'index.js'))
    stamp(join(workspace, 'lib', 'index.js'), 1_000)
    stamp(join(workspace, 'src', 'index.ts'), 9_000)
    expect(inspectPackage({ name: '@x/alpha', loaded: workspace, workspace }).verdict).toBe('stale')
  })

  it('calls a current copy outside this checkout copied, not a failure', () => {
    const root = tempDir()
    const workspace = join(root, 'packages', 'drama', 'alpha')
    write(join(workspace, 'src', 'index.ts'))
    write(join(workspace, 'lib', 'index.js'))
    stamp(join(workspace, 'src', 'index.ts'), 1_000)
    stamp(join(workspace, 'lib', 'index.js'), 2_000)
    const vendored = join(root, 'profile', 'vendor', 'alpha')
    mkdirSync(vendored, { recursive: true })
    expect(inspectPackage({ name: '@x/alpha', loaded: vendored, workspace }).verdict).toBe('copied')
  })

  it('ignores a package this checkout does not build', () => {
    const row = inspectPackage({ name: '@x/other', loaded: join(tempDir(), 'elsewhere') })
    expect(row).toMatchObject({ verdict: 'not_built_here', fix: '' })
  })
})
