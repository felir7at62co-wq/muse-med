/**
 * Run the per-file 100% coverage gate for only the packages a change touches.
 *
 * The changed paths come from `change-scope` against an explicit base, including staged, unstaged and untracked
 * work. Each package with a changed `src/` or `tests/` path contributes its own `tests/` directory and its
 * `src/` files as the coverage scope, so the CI thresholds and exclusions in `vitest.config.ts` apply to exactly
 * that source. Behavior covered only by another package's tests needs that test path through `--tests`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { renderChangeScope } from './change-scope.ts'

const PACKAGE_PATH = /^(packages\/[^/]+\/[^/]+)\/(?:src|tests)\//u

/**
 * Select the coverage-gated packages whose source or tests a change touches.
 * @param paths Changed repository paths.
 * @returns Sorted `packages/<group>/<package>` directories.
 */
export function changedPackages(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap(path => PACKAGE_PATH.exec(path)?.[1] ?? []))].sort()
}

/**
 * Build the Vitest arguments that run the packages' tests and gate only their source.
 * @param packages Package directories from {@link changedPackages}.
 * @param extraTests Further test files or directories that cover those packages.
 * @returns Arguments after the Vitest executable.
 */
export function coverageArguments(packages: readonly string[], extraTests: readonly string[]): string[] {
  return ['run', ...packages.map(dir => `${dir}/tests/`), ...extraTests, '--coverage',
    ...packages.map(dir => `--coverage.include=${dir}/src/**/*.{ts,tsx}`)]
}

function main(): void {
  const { values } = parseArgs({ options: {
    base: { type: 'string' },
    head: { type: 'string' },
    tests: { type: 'string', multiple: true, default: [] },
    'dry-run': { type: 'boolean', default: false },
  } })
  if (values.base === undefined) {
    console.error('coverage-changed: --base <verified base ref> is required, for example --base origin/main after fetching it')
    process.exitCode = 2
    return
  }
  const root = resolve(import.meta.dirname, '..')
  const scope = JSON.parse(renderChangeScope(['--base', values.base, ...values.head === undefined ? [] : ['--head', values.head]], root)) as {
    paths: Record<'committed' | 'staged' | 'unstaged' | 'untracked', string[]>
  }
  const packages = changedPackages(Object.values(scope.paths).flat())
  if (packages.length === 0) {
    console.log(`coverage-changed: no coverage-gated package source or tests changed since ${values.base}`)
    return
  }
  const missing = packages.filter(dir => !existsSync(join(root, dir, 'tests')))
  if (missing.length > 0 && values.tests.length === 0) {
    console.error(`coverage-changed: no local tests for ${missing.join(', ')}; provide owning tests with --tests <path>`)
    process.exitCode = 2
    return
  }
  const args = coverageArguments(packages, values.tests)
  for (const directory of missing) args.splice(args.indexOf(`${directory}/tests/`), 1)
  console.log(`coverage-changed: ${packages.join(', ')}\n  vitest ${args.join(' ')}`)
  if (values['dry-run']) return
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), ...args], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
  if (result.status !== 0) {
    console.error('coverage-changed: an uncovered line may still be covered by another package\'s tests in CI; add those with --tests <path>, or find them with `pnpm exec vitest related <file> --run`')
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) main()
