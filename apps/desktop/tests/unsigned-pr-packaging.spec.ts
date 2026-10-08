/** Check the unsigned PR workflow against electron-builder's signing policy. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { desktopElectronBuilderEnvironment } from '../scripts/package-target.ts'

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected workflow mapping')
  return value as Record<string, unknown>
}

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
  expect(config.mac).toMatchObject({ identity: '-', forceCodeSigning: false, hardenedRuntime: false, notarize: false })
})
