import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changedPackages, coverageArguments } from './coverage-changed.ts'

describe('changedPackages', () => {
  it('selects each package once whose source or tests changed, ignoring docs, apps and scripts', () => {
    expect(changedPackages([
      'packages/boot/app-boot/src/index.ts',
      'packages/boot/app-boot/tests/compatibility-preflight.spec.ts',
      'packages/boot/app-boot/README.md',
      'packages/session/session-coordinator/tests/coordinator.spec.ts',
      'packages/util/brand/package.json',
      'apps/desktop-host/src/index.ts',
      'scripts/coverage-changed.ts',
      'packages/README.md',
    ])).toEqual(['packages/boot/app-boot', 'packages/session/session-coordinator'])
  })
})

describe('coverageArguments', () => {
  it('runs the packages and extra tests while gating only the packages source', () => {
    expect(coverageArguments(['packages/boot/app-boot', 'packages/util/brand'], ['apps/cli/tests/resolved-profile-boot.spec.ts'])).toEqual([
      'run', 'packages/boot/app-boot/tests/', 'packages/util/brand/tests/', 'apps/cli/tests/resolved-profile-boot.spec.ts',
      '--coverage',
      '--coverage.include=packages/boot/app-boot/src/**/*.{ts,tsx}',
      '--coverage.include=packages/util/brand/src/**/*.{ts,tsx}',
    ])
  })
})

describe('coverage-changed command', () => {
  it('refuses to guess a base', () => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'coverage-changed.ts')], { encoding: 'utf8', timeout: 30_000 })
    expect(result.signal).toBeNull()
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--base <verified base ref> is required')
  })

  it('keeps source without local tests in the coverage scope and requires an explicit test owner', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coverage-without-tests-')))
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true })
      for (const file of ['coverage-changed.ts', 'change-scope.ts']) {
        writeFileSync(join(root, 'scripts', file), readFileSync(resolve(import.meta.dirname, file)))
      }
      const git = (...args: string[]): string => {
        const result = spawnSync('git', ['-c', 'user.name=Coverage test', '-c', 'user.email=coverage@example.invalid',
          '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' })
        if (result.status !== 0) throw new Error(result.stderr)
        return result.stdout.trim()
      }
      git('init', '-q')
      const source = join(root, 'packages', 'test', 'no-tests', 'src', 'index.ts')
      mkdirSync(dirname(source), { recursive: true })
      writeFileSync(source, 'export const count = 1\n')
      git('add', '.')
      git('commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      writeFileSync(source, 'export const count = 2\n')
      const invoke = (...args: string[]) => spawnSync(process.execPath,
        [join(root, 'scripts/coverage-changed.ts'), '--base', base, '--dry-run', ...args],
        { cwd: root, encoding: 'utf8', timeout: 30_000 })
      const missing = invoke()
      expect(missing.error).toBeUndefined()
      expect(missing.signal).toBeNull()
      expect(missing.status).toBe(2)
      expect(missing.stderr).toContain('no local tests for packages/test/no-tests')
      const selected = invoke('--tests', 'apps/cli/tests/owner.spec.ts')
      expect(selected.error).toBeUndefined()
      expect(selected.signal).toBeNull()
      expect(selected.status).toBe(0)
      expect(selected.stdout).toContain('--coverage.include=packages/test/no-tests/src/**/*.{ts,tsx}')
      expect(selected.stdout).toContain('apps/cli/tests/owner.spec.ts')
      expect(selected.stdout).not.toContain('packages/test/no-tests/tests/')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
