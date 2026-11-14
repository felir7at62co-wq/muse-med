/** Check unsigned desktop workflow ordering, resource caches and signing policy. */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import { desktopTargetBuildPaths } from '../scripts/desktop-build-paths.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { desktopElectronBuilderEnvironment, desktopPrepareMediaRuntimeArguments, resolveDesktopPackageTarget } from '../scripts/package-target.ts'

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected workflow mapping')
  return value as Record<string, unknown>
}

it('runs draft ownership and saved-source regressions before dependency installation on both native targets', () => {
  const workflow = record(load(readFileSync(new URL('../../../.github/workflows/muse-desktop.yml', import.meta.url), 'utf8')))
  const steps = record(record(workflow.jobs).build).steps
  if (!Array.isArray(steps)) throw new Error('Expected packaging steps')
  const safety = steps.map((step: unknown) => record(step)).find(step => step.name === 'Check draft build ownership and saved source ranges')
  expect(safety).toMatchObject({ 'working-directory': 'packages/drama/skills', env: { PYTHONUTF8: '1' } })
  expect(safety).not.toHaveProperty('if')
  expect(safety?.run).toBe('python -B -m unittest tests.render.test_windows_aa_draft tests.render.test_windows_aa_protocol tests.render.test_draft_stage_guard tests.render.test_draft_integrity')
  expect(steps.indexOf(safety)).toBeLessThan(steps.findIndex((step: unknown) => record(step).name === 'Install immutable dependencies'))
})

it('builds the Host peers before qualifying download bundles on a clean checkout', () => {
  const workflow = record(load(readFileSync(new URL('../../../.github/workflows/muse-desktop.yml', import.meta.url), 'utf8')))
  const steps = record(record(workflow.jobs).build).steps
  if (!Array.isArray(steps)) throw new Error('Expected packaging steps')
  const commands = steps.map((step: unknown) => record(step).run)
  const build = commands.findIndex(command => typeof command === 'string' && command.includes('pnpm run build:lib:host'))
  const qualification = commands.findIndex(command => typeof command === 'string' && command.includes('third_party/plugins/download-pack.test.mjs'))
  expect(build).toBeGreaterThanOrEqual(0)
  expect(qualification).toBeGreaterThan(build)
})

it('qualifies native macOS identity and signature rejection before assembling an update candidate', () => {
  const workflow = record(load(readFileSync(new URL('../../../.github/workflows/muse-desktop.yml', import.meta.url), 'utf8')))
  const steps = record(record(workflow.jobs).build).steps
  if (!Array.isArray(steps)) throw new Error('Expected packaging steps')
  const native = steps.map((step: unknown) => record(step)).find(step => step.name === 'Check native macOS DMG identity and signature verification')
  if (!native || typeof native.run !== 'string') throw new Error('Expected native macOS DMG verification')
  expect(native.if).toBe("matrix.target == 'mac-arm64'")
  expect(native.run).toContain('--config vitest.e2e.config.ts apps/desktop/tests/macos-update-package.e2e.ts')
  expect(native.run).toContain('--retry 0')
  expect(native.run).toContain('--outputFile="$RUNNER_TEMP/muse-candidate-update-native/result.json"')
  expect(steps.indexOf(native)).toBeLessThan(steps.findIndex((step: unknown) => record(step).name === 'Build and verify the assembled application'))
})

it('allows ad-hoc resource sealing for unsigned PR packages without publisher signing', () => {
  const workflow = record(load(readFileSync(new URL('../../../.github/workflows/muse-desktop.yml', import.meta.url), 'utf8')))
  const steps = record(record(workflow.jobs).build).steps
  if (!Array.isArray(steps)) throw new Error('Expected packaging steps')
  const build = steps.map((step: unknown) => record(step)).find(step => step.name === 'Build and verify the assembled application')
  if (!build || typeof build.run !== 'string') throw new Error('Expected unsigned packaging command')
  expect(build.run).toMatch(/ --unsigned$/u)
  const environment = desktopElectronBuilderEnvironment({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main',
    CSC_LINK: '/private/publisher.p12', CSC_KEY_PASSWORD: 'fixture-password' }, true)
  expect(environment).not.toHaveProperty('CSC_LINK')
  expect(environment).not.toHaveProperty('CSC_KEY_PASSWORD')
  expect(environment.CSC_FOR_PULL_REQUEST).toBe('true')
  const require = createRequire(import.meta.url)
  const result = execFileSync(process.execPath, ['-e',
    'process.stdout.write(String(require(process.argv[1]).isSignAllowed(false)))',
    require.resolve('app-builder-lib/out/codeSign/macCodeSign.js')], {
    env: { ...process.env, CSC_FOR_PULL_REQUEST: undefined, ...environment },
    encoding: 'utf8', timeout: 10_000,
  })
  expect(result).toBe(String(process.platform === 'darwin'))
  const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'cn.muse.med',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: 'false', DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')
  expect(config.mac).toMatchObject({ identity: '-', forceCodeSigning: false, hardenedRuntime: true, notarize: false })
})

it('prewarms private Windows FFmpeg in the cache read by media packaging', () => {
  const workflow = record(load(readFileSync(new URL('../../../.github/workflows/muse-desktop.yml', import.meta.url), 'utf8')))
  const steps = record(record(workflow.jobs).build).steps
  if (!Array.isArray(steps)) throw new Error('Expected packaging steps')
  const preload = steps.map((step: unknown) => record(step)).find(step => step.name === 'Cache the locked private Windows FFmpeg resource')
  if (!preload || typeof preload.run !== 'string') throw new Error('Expected private FFmpeg preload')
  const args = desktopPrepareMediaRuntimeArguments(resolveDesktopPackageTarget('win-x64', 'win32', 'x64'),
    desktopTargetBuildPaths('win-x64'), false)
  if (!args || args.indexOf('--cache') < 0) throw new Error('Expected Windows media cache')
  const cache = args[args.indexOf('--cache') + 1]
  if (!cache) throw new Error('Expected media cache argument')
  const expectedCache = relative(fileURLToPath(new URL('../../../', import.meta.url)), cache).replaceAll('\\', '/')
  expect(preload.run.match(/ --dir ([^\s]+)$/u)?.[1]).toBe(expectedCache)
  expect(steps.indexOf(preload)).toBeLessThan(steps.findIndex((step: unknown) => record(step).name === 'Build and verify the assembled application'))
  expect(preload.if).toBe("matrix.target == 'win-x64'")
  expect(record(preload.env).GH_TOKEN).toBe('${{ github.token }}')
})

it('checks the unauthenticated TOS route before building an encrypted export', () => {
  const workflow = record(load(readFileSync(new URL('../../../.github/workflows/muse-desktop.yml', import.meta.url), 'utf8')))
  const steps = record(record(workflow.jobs).build).steps
  if (!Array.isArray(steps)) throw new Error('Expected packaging steps')
  const setup = steps.map((step: unknown) => record(step)).find(step => step.uses === 'actions/setup-node@v7.0.0')
  if (!setup) throw new Error('Expected CI Node setup')
  expect(record(setup.with)['node-version']).toBe("${{ matrix.target == 'win-x64' && '26.13.0' || '24' }}")
  const route = steps.map((step: unknown) => record(step)).find(step => step.name === 'Check the candidate export network route')
  if (!route || typeof route.run !== 'string') throw new Error('Expected TOS route check')
  expect(route.if).toBe("matrix.target == 'win-x64' && inputs.export_candidate_to_tos")
  expect(route.env).toBeUndefined()
  expect(route.run).toContain("method: 'HEAD'")
  expect(route.run).toContain('https://muse.tos-s3-cn-beijing.volces.com/')
  expect(steps.indexOf(route)).toBeLessThan(steps.findIndex((step: unknown) => record(step).name === 'Build and verify the assembled application'))
})

it('refuses an unfixed HTTP parser before contacting the export route', () => {
  const workflow = record(load(readFileSync(new URL('../../../.github/workflows/muse-desktop.yml', import.meta.url), 'utf8')))
  const steps = record(record(workflow.jobs).build).steps
  if (!Array.isArray(steps)) throw new Error('Expected packaging steps')
  const route = steps.map((step: unknown) => record(step)).find(step => step.name === 'Check the candidate export network route')
  if (!route || typeof route.run !== 'string') throw new Error('Expected route command')
  const prefix = 'node --input-type=module -e "'
  expect(route.run.startsWith(prefix) && route.run.endsWith('"')).toBe(true)
  const command = route.run.slice(prefix.length, -1)
  for (const [version, accepted] of [['7.30.1', false], ['8.12.2', true]] as const) {
    const script = `Object.defineProperty(process.versions, 'undici', { value: ${JSON.stringify(version)} });
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls++; return new Response(null, { status: 200 }); };
      ${command}; console.log(JSON.stringify({ fetchCalls }));`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10_000,
      env: Object.fromEntries(Object.entries(process.env)
        .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|NODE_OPTIONS|BASH_ENV/iu.test(name))),
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(accepted ? 0 : 1)
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')).toEqual({ fetchCalls: accepted ? 1 : 0 })
  }
})
