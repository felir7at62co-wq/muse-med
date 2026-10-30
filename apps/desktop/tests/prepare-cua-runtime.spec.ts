/** Complete Cua releases stay relocatable and reject changed cache or payload bytes. */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { cuaRuntimeExecutable, prepareCuaRuntime, smokeCuaRuntime, validateCuaRuntimeLock, verifyPreparedCuaRuntime } from '../scripts/prepare-cua-runtime.ts'

const { spawnCua } = vi.hoisted(() => ({ spawnCua: vi.fn((_command: string, _args: string[], _options: { env: NodeJS.ProcessEnv }) =>
  ({ stdout: 'cua-driver 0.28.0\n', stderr: '', status: 0, signal: null, error: undefined })) }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawnSync: spawnCua }))

const releaseLock = validateCuaRuntimeLock(JSON.parse(await readFile(new URL('../scripts/cua-runtime.lock.json', import.meta.url), 'utf8')))
const roots: string[] = []
afterEach(async () => {
  spawnCua.mockClear()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(omit?: string) {
  const root = await mkdtemp(join(tmpdir(), 'muse-cua-runtime-'))
  roots.push(root)
  const cache = join(root, 'cache'), output = join(root, 'runtime', 'cua')
  await mkdir(cache)
  const runtimeFiles = ['cua-driver.exe', 'cua-cursor-theme.exe', 'cua-driver-uia.exe',
    'cua_driver_sdk.dll', 'cua_driver_node_runtime.node', 'cua_driver_abi.h']
  const filenames = [...runtimeFiles, 'LICENSE']
  const files = Object.fromEntries(runtimeFiles.filter(name => name !== omit).map(name =>
    [`cua-driver-rs-0.28.0-windows-x86_64/${name}`, Buffer.from(`original ${name}\n`)]))
  const archive = zipSync(files)
  const resource = { ...releaseLock.targets['win-x64'], bytes: archive.byteLength,
    sha256: createHash('sha256').update(archive).digest('hex') }
  const license = Buffer.from('original LICENSE\n')
  const lock = { ...releaseLock, targets: { 'win-x64': resource }, license: { ...releaseLock.license,
    bytes: license.byteLength, sha256: createHash('sha256').update(license).digest('hex') } }
  await writeFile(join(cache, resource.filename), archive)
  await writeFile(join(cache, lock.license.filename), omit === 'LICENSE' ? 'changed license' : license)
  return { root, cache, output, lock, filenames }
}

it('pins the official release and a license from the same source version', () => {
  expect(releaseLock.driverVersion).toBe('0.28.0')
  expect(releaseLock.targets['win-x64'].sha256).toBe('dbae495361a3d5862f7ed57cb82dc7a83f46e7a9ab111a6a23a8acaa79ec6265')
  for (const changes of [{ filename: 'cua-driver-rs-0.28.0-windows-x86_64-binary.zip' },
    { url: 'https://github.com/trycua/cua/releases/latest/download/install.ps1' }, { sha256: 'invalid' }, { bytes: 0 }]) {
    expect(() => validateCuaRuntimeLock({ ...releaseLock,
      targets: { 'win-x64': { ...releaseLock.targets['win-x64'], ...changes } } })).toThrow(/complete official/u)
  }
  expect(() => validateCuaRuntimeLock({ ...releaseLock, targets: {} })).toThrow(/lock/u)
  expect(() => validateCuaRuntimeLock({ ...releaseLock, license: undefined })).toThrow(/license/u)
  expect(() => validateCuaRuntimeLock({ ...releaseLock,
    license: { ...releaseLock.license, url: 'https://raw.githubusercontent.com/trycua/cua/main/LICENSE.md' } })).toThrow(/license/u)
})

it('resolves the driver beside its native sidecars', () => {
  expect(cuaRuntimeExecutable('/runtime/cua')).toBe(join('/runtime/cua', 'cua-driver.exe'))
})

it('prepares the actual six-file release with its separately locked license and reuses the offline payload', async () => {
  const payload = await fixture()
  expect(await prepareCuaRuntime(payload)).toBe(payload.output)
  for (const filename of payload.filenames) {
    expect(await readFile(join(payload.output, filename), 'utf8')).toBe(`original ${filename}\n`)
  }
  await expect(verifyPreparedCuaRuntime(payload.output, payload.lock)).resolves.toBeUndefined()
  expect(await prepareCuaRuntime(payload)).toBe(payload.output)
  const descriptor = JSON.parse(await readFile(join(payload.output, 'cua-runtime.json'), 'utf8')) as { target: string; driverVersion: string }
  expect(descriptor).toMatchObject({ target: 'win-x64', driverVersion: '0.28.0' })
})

it.each(['cua-driver-uia.exe', 'cua_driver_sdk.dll'])('rejects an incomplete release missing %s', async (filename) => {
  const payload = await fixture(filename)
  await expect(prepareCuaRuntime(payload)).rejects.toThrow()
  await expect(readFile(join(payload.output, 'cua-runtime.json'))).rejects.toThrow()
})

it('rejects a changed license rather than publishing the upstream archive without its authorization notice', async () => {
  const payload = await fixture('LICENSE')
  await expect(prepareCuaRuntime(payload)).rejects.toThrow(/size mismatch/u)
  await expect(readFile(join(payload.output, 'cua-runtime.json'))).rejects.toThrow()
})

it('retains changed cache bytes and refuses to publish them', async () => {
  const payload = await fixture()
  const path = join(payload.cache, payload.lock.targets['win-x64'].filename)
  await writeFile(path, 'changed cache')
  await expect(prepareCuaRuntime(payload)).rejects.toThrow(/size mismatch/u)
  expect(await readFile(path, 'utf8')).toBe('changed cache')
})

it('refuses to repair a modified sidecar in an existing payload', async () => {
  const payload = await fixture()
  await prepareCuaRuntime(payload)
  await writeFile(join(payload.output, 'cua_driver_sdk.dll'), 'changed sidecar')
  await expect(prepareCuaRuntime(payload)).rejects.toThrow(/payload changed/u)
  expect(await readFile(join(payload.output, 'cua_driver_sdk.dll'), 'utf8')).toBe('changed sidecar')
})

it.skipIf(process.platform !== 'win32')('checks version without installer arguments or ambient credentials', () => {
  vi.stubEnv('MUSE_CUA_TEST_TOKEN', 'private test value')
  smokeCuaRuntime('/runtime/cua', '0.28.0')
  expect(spawnCua).toHaveBeenCalledWith(cuaRuntimeExecutable('/runtime/cua'), ['--version'], expect.objectContaining({
    windowsHide: true, timeout: 30_000,
  }))
  const options = spawnCua.mock.calls.at(-1)?.[2]
  expect(options?.env).not.toHaveProperty('MUSE_CUA_TEST_TOKEN')
})
