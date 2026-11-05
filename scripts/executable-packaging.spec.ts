import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { executableDeployEnvironment } from './executable-packaging.ts'
import { materializeStagedLinks } from './build-exe-for-python-sdk-staging.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exe-deploy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const staging = join(root, 'staging')
  await mkdir(source)
  await mkdir(join(staging, 'node_modules'), { recursive: true })
  return { root, source, staging, modules: join(staging, 'node_modules') }
}

it('preserves exact package build decisions when local deployment paths become absolute URLs', async () => {
  const test = await fixture()
  const allowed = `@fixture/runtime@${pathToFileURL(join(test.root, 'source/with spaces')).href}`
  const denied = `@fixture/denied@${pathToFileURL(join(test.root, 'source/denied')).href}`
  const equivalent = `@fixture/equivalent@${pathToFileURL(join(test.root, 'source/equivalent')).href}`
  const policy = {
    '@fixture/runtime@file:source/with spaces': true,
    '@fixture/denied@file:source/denied': true,
    [denied]: false,
    '@fixture/equivalent@file:source/equivalent': true,
    '@fixture/equivalent@file:./source/equivalent': false,
    '@fixture/other@file:../outside': true,
    thirdParty: false,
  }
  const pnpm = join(test.root, 'pnpm.mjs')
  await writeFile(pnpm, `console.log(${JSON.stringify(JSON.stringify(policy))})\n`)
  const environment = executableDeployEnvironment(test.root, { ...process.env, npm_execpath: pnpm })

  expect(JSON.parse(environment.PNPM_CONFIG_ALLOW_BUILDS ?? '')).toEqual({ ...policy, [allowed]: true, [equivalent]: false })
})

it('rejects an unresolved build decision before deployment', async () => {
  const test = await fixture()
  const pnpm = join(test.root, 'pnpm.mjs')
  await writeFile(pnpm, 'console.log(\'{"undecided":"set this to true or false"}\')\n')
  expect(() => executableDeployEnvironment(test.root, { ...process.env, npm_execpath: pnpm }))
    .toThrow('allowBuilds must map package identities to booleans')
})

it('materializes a package junction without deleting its source and drops linked command directories', async () => {
  const test = await fixture()
  await mkdir(join(test.source, 'peer'))
  await writeFile(join(test.source, 'peer/index.js'), 'intact')
  await symlink(join(test.source, 'peer'), join(test.modules, 'peer'), 'junction')
  await symlink(join(test.source, 'peer'), join(test.modules, '.bin'), 'junction')
  await materializeStagedLinks(test.staging)
  expect((await lstat(join(test.modules, 'peer'))).isSymbolicLink()).toBe(false)
  expect(await readFile(join(test.modules, 'peer/index.js'), 'utf8')).toBe('intact')
  expect(await readFile(join(test.source, 'peer/index.js'), 'utf8')).toBe('intact')
  await expect(lstat(join(test.modules, '.bin'))).rejects.toThrow('ENOENT')
})
