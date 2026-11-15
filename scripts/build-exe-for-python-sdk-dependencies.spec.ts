/** Runtime deployment keeps its installed dependency versions inside the packaged tree. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { restoreRuntimeDependencies } from './build-exe-for-python-sdk-dependencies.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-dependencies-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const source = join(root, 'source'), staging = join(root, 'staging')
  async function packageAt(directory: string, fields: Record<string, unknown>) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '1.0.0', ...fields }))
    await writeFile(join(directory, 'payload.js'), 'export default true\n')
    return directory
  }
  return { source, staging, packageAt }
}

it('restores missing transitive packages, shares peers and retains conflicting nested versions', async () => {
  const { source, staging, packageAt } = await fixture()
  const dependencies = { first: '1', second: '1', shared: '1' }
  await packageAt(source, { dependencies })
  await packageAt(staging, { dependencies })
  await packageAt(join(source, 'node_modules/first'), { name: 'first', dependencies: { codec: '1' }, peerDependencies: { shared: '1' } })
  await packageAt(join(source, 'node_modules/second'), { name: 'second', dependencies: { codec: '2' }, peerDependencies: { shared: '1' } })
  await packageAt(join(source, 'node_modules/shared'), { name: 'shared', dependencies: { first: '1' } })
  await packageAt(join(source, 'node_modules/codec'), { name: 'codec' })
  await packageAt(join(source, 'node_modules/second/node_modules/codec'), { name: 'codec', version: '2.0.0' })
  await packageAt(join(staging, 'node_modules/first'), { name: 'first', dependencies: { codec: '1' }, peerDependencies: { shared: '1' } })
  expect(await restoreRuntimeDependencies(source, staging)).toHaveLength(4)
  expect(await restoreRuntimeDependencies(source, staging)).toEqual([])
  expect(JSON.parse(await readFile(join(staging, 'node_modules/codec/package.json'), 'utf8'))).toHaveProperty('version', '1.0.0')
  expect(JSON.parse(await readFile(join(staging, 'node_modules/second/node_modules/codec/package.json'), 'utf8')))
    .toHaveProperty('version', '2.0.0')
  await expect(readFile(join(staging, 'node_modules/first/node_modules/shared/package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('omits absent optional packages and rejects absent required dependencies', async () => {
  const { source, staging, packageAt } = await fixture()
  const optional = { optionalDependencies: { missing: '1' }, peerDependencies: { optionalPeer: '1' },
    peerDependenciesMeta: { optionalPeer: { optional: true } } }
  await packageAt(source, optional)
  await packageAt(staging, optional)
  expect(await restoreRuntimeDependencies(source, staging)).toEqual([])
  await packageAt(staging, { dependencies: { missing: '1' } })
  await expect(restoreRuntimeDependencies(source, staging)).rejects.toThrow('Runtime dependency missing required by deployment')
})

it('copies a dependency into deployment instead of retaining an ancestor package lookup', async () => {
  const { source, staging, packageAt } = await fixture()
  await packageAt(source, { dependencies: { codec: '1' } })
  await packageAt(staging, { dependencies: { codec: '1' } })
  await packageAt(join(source, 'node_modules/codec'), { name: 'codec' })
  await packageAt(join(staging, '../node_modules/codec'), { name: 'codec' })
  expect(await restoreRuntimeDependencies(source, staging)).toHaveLength(1)
  expect(await readFile(join(staging, 'node_modules/codec/payload.js'), 'utf8')).toContain('export default true')
})

it('rejects a conflicting direct dependency without overwriting its installed files', async () => {
  const { source, staging, packageAt } = await fixture()
  await packageAt(source, { dependencies: { codec: '1' } })
  await packageAt(staging, { dependencies: { codec: '1' } })
  await packageAt(join(source, 'node_modules/codec'), { name: 'codec' })
  await packageAt(join(staging, 'node_modules/codec'), { name: 'codec', version: '2.0.0' })
  await expect(restoreRuntimeDependencies(source, staging)).rejects.toThrow('Runtime dependency version conflicts')
  expect(JSON.parse(await readFile(join(staging, 'node_modules/codec/package.json'), 'utf8'))).toHaveProperty('version', '2.0.0')
})
