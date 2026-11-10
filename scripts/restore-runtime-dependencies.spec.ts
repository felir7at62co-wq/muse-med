/** Legacy deploy repair retains real dependency resolution, native assets, and one workspace peer. */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, expect, it } from 'vitest'
import { restoreRuntimeDependencies } from './restore-runtime-dependencies.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sdk-dependency-closure-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), staging = join(root, 'staging')
  await mkdir(source)
  await mkdir(staging)
  const pkg = async (directory: string, name: string, version: string, fields: Record<string, unknown> = {}) => {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, ...fields }))
    return directory
  }
  return { source, staging, pkg }
}

it('restores transitive Office and native PTY files and retains existing staged content', async () => {
  const f = await fixture()
  await f.pkg(f.source, 'runtime', '1', { dependencies: { office: '1', subprocess: '1' } })
  const office = await f.pkg(join(f.source, 'node_modules/office'), 'office', '1', { dependencies: { kit: '1' } })
  const kit = await f.pkg(join(office, 'node_modules/kit'), 'kit', '1', { optionalDependencies: { unavailable: '1' } })
  const subprocess = await f.pkg(join(f.source, 'node_modules/subprocess'), 'subprocess', '1', { dependencies: { pty: '1' } })
  const pty = await f.pkg(join(subprocess, 'node_modules/pty'), 'pty', '1')
  await mkdir(join(pty, 'prebuilds/win32-x64'), { recursive: true })
  await writeFile(join(pty, 'prebuilds/win32-x64/conpty.node'), 'native bytes')
  await writeFile(join(kit, 'worker.mjs'), 'worker bytes')
  await f.pkg(join(f.staging, 'node_modules/office'), 'office', '1')
  await writeFile(join(f.staging, 'node_modules/office/retained.txt'), 'keep')
  expect(await restoreRuntimeDependencies(f.source, f.staging)).toBe(3)
  expect(await readFile(join(f.staging, 'node_modules/kit/worker.mjs'), 'utf8')).toBe('worker bytes')
  expect(await readFile(join(f.staging, 'node_modules/pty/prebuilds/win32-x64/conpty.node'), 'utf8')).toBe('native bytes')
  expect(await readFile(join(f.staging, 'node_modules/office/retained.txt'), 'utf8')).toBe('keep')
  expect(await restoreRuntimeDependencies(f.source, f.staging)).toBe(0)
})

it('shares direct workspace peers and preserves conflicting third-party versions', async () => {
  const f = await fixture()
  await f.pkg(f.source, 'runtime', '1', { dependencies: { cordis: '1', plugin: '1', helper: '1' } })
  await f.pkg(join(f.source, 'node_modules/cordis'), 'cordis', '1')
  await f.pkg(join(f.source, 'node_modules/helper'), 'helper', '1')
  const plugin = await f.pkg(join(f.source, 'node_modules/plugin'), 'plugin', '1', {
    dependencies: { helper: '2' }, peerDependencies: { cordis: '1', absent: '*' },
    peerDependenciesMeta: { absent: { optional: true } },
  })
  await f.pkg(join(plugin, 'node_modules/helper'), 'helper', '2')
  await restoreRuntimeDependencies(f.source, f.staging)
  const nested = JSON.parse(await readFile(join(f.staging, 'node_modules/plugin/node_modules/helper/package.json'), 'utf8')) as { version: string }
  expect(nested.version).toBe('2')
  await expect(stat(join(f.staging, 'node_modules/plugin/node_modules/cordis'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a missing required transitive dependency instead of publishing an incomplete closure', async () => {
  const f = await fixture()
  await f.pkg(f.source, 'runtime', '1', { dependencies: { plugin: '1' } })
  await f.pkg(join(f.source, 'node_modules/plugin'), 'plugin', '1', { dependencies: { absent: '1' } })
  await expect(restoreRuntimeDependencies(f.source, f.staging)).rejects.toThrow('absent required by plugin')
})

it('reports a missing direct dependency before traversing children', async () => {
  const f = await fixture()
  await f.pkg(f.source, 'runtime', '1', { dependencies: { absent: '1' } })
  await expect(restoreRuntimeDependencies(f.source, f.staging)).rejects.toThrow('absent required by runtime')
})
