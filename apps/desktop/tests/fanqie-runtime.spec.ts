/** Shared Python selection keeps current downloads independent of retired original binaries. */
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareDesktopFanqieEnvironment } from '../src/fanqie-runtime.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each(['darwin', 'win32'] as const)('uses the primary %s Python without installing original sources', async (platform) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-primary-fanqie-'))
  roots.push(root)
  const python = join(root, 'dependencies', 'python', ...(platform === 'win32' ? ['python.exe'] : ['bin', 'python3']))
  await mkdir(dirname(python), { recursive: true })
  await writeFile(python, 'python')
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ desktopVersion: '1.3.0', platform, arch: 'x64',
    python: '3.12.14', pythonPackages: { pycryptodome: '3.23.0' } }))
  expect(await prepareDesktopFanqieEnvironment({ primaryRuntime: root })).toEqual({ MUSE_FANQIE_PYTHON_PATH: await realpath(python) })
  await expect(readFile(join(root, 'private', 'hongguo'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a primary payload missing Crypto without silently using legacy sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-primary-no-crypto-'))
  roots.push(root)
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ desktopVersion: '1.3.0', platform: 'darwin', arch: 'arm64',
    python: '3.12.14', pythonPackages: {} }))
  await expect(prepareDesktopFanqieEnvironment({ primaryRuntime: root }))
    .rejects.toThrow('missing PyCryptodome')
})

it('rejects an interpreter path that is a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-primary-directory-'))
  roots.push(root)
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ desktopVersion: '1.3.0', platform: 'win32', arch: 'x64',
    python: '3.12.14', pythonPackages: { pycryptodome: '3.23.0' } }))
  await mkdir(join(root, 'dependencies/python/python.exe'), { recursive: true })
  await expect(prepareDesktopFanqieEnvironment({ primaryRuntime: root })).rejects.toThrow('not a regular file')
})

it.skipIf(process.platform === 'win32')('rejects a primary interpreter alias escaping the payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-primary-alias-'))
  roots.push(root)
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ desktopVersion: '1.3.0', platform: 'darwin', arch: 'arm64',
    python: '3.12.14', pythonPackages: { pycryptodome: '3.23.0' } }))
  const bin = join(root, 'dependencies/python/bin')
  await mkdir(bin, { recursive: true })
  await symlink(process.execPath, join(bin, 'python3'))
  await expect(prepareDesktopFanqieEnvironment({ primaryRuntime: root }))
    .rejects.toThrow('escapes its payload')
})
