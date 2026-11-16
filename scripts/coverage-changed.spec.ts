import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
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
})
