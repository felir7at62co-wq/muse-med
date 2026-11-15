/** Prepare the Windows Computer Use runtime from the complete, hash-locked Cua release. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { inventory, obtain, shortStage, unzip, type MediaResource } from './media-resources.ts'

/** Official Windows release and its separately locked source-version license. */
export interface CuaRuntimeLock {
  version: 1
  driverVersion: string
  license: MediaResource
  targets: { 'win-x64': MediaResource }
}

const runtimeFiles = ['cua-driver.exe', 'cua-cursor-theme.exe', 'cua-driver-uia.exe',
  'cua_driver_sdk.dll', 'cua_driver_node_runtime.node', 'cua_driver_abi.h', 'LICENSE']

/** Reject unversioned sources, installer scripts and a missing source-version license.
 * @param value - Parsed release lock.
 * @returns Validated complete Windows release lock.
 */
export function validateCuaRuntimeLock(value: unknown): CuaRuntimeLock {
  if (typeof value !== 'object' || value === null) throw new Error('Cua runtime: expected lock object')
  const lock = value as CuaRuntimeLock
  if (lock.version !== 1 || typeof lock.driverVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(lock.driverVersion)
    || !lock.targets || Object.keys(lock.targets).length !== 1) throw new Error('Cua runtime: unsupported lock')
  const file = lock.targets['win-x64']
  const filename = `cua-driver-rs-${lock.driverVersion}-windows-x86_64.zip`
  if (!file || file.filename !== filename || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
    || file.url !== `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${lock.driverVersion}/${filename}`) {
    throw new Error('Cua runtime: complete official Windows release required')
  }
  const license = lock.license
  if (!license || license.filename !== `cua-driver-${lock.driverVersion}-LICENSE.md`
    || !Number.isSafeInteger(license.bytes) || license.bytes <= 0
    || typeof license.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(license.sha256)
    || license.url !== `https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v${lock.driverVersion}/LICENSE.md`) {
    throw new Error('Cua runtime: official source-version license required')
  }
  return lock
}

/** Resolve the executable beside its required native libraries and helper processes.
 * @param root - Prepared `runtime/cua` directory.
 * @returns Absolute or caller-relative executable path matching the supplied root.
 */
export function cuaRuntimeExecutable(root: string): string {
  return join(root, 'cua-driver.exe')
}

async function verifyRuntimeFiles(root: string): Promise<void> {
  for (const file of runtimeFiles) {
    const entry = await lstat(join(root, file))
    if (!entry.isFile() || entry.size === 0) throw new Error(`Cua runtime: missing release file ${file}`)
  }
}

/** Check the native CLI version without installing services or requesting desktop permissions.
 * @param root - Complete Windows runtime directory.
 * @param version - Locked Cua version.
 */
export function smokeCuaRuntime(root: string, version: string): void {
  if (process.platform !== 'win32') return
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|COMSPEC|PATHEXT)$/iu.test(key)))
  const result = spawnSync(cuaRuntimeExecutable(root), ['--version'], {
    env, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true,
  })
  if (result.error || result.signal || result.status !== 0
    || !(result.stdout + result.stderr).split(/\s+/u).includes(version)) {
    throw new Error('Cua runtime: executable version smoke failed')
  }
}

/** Verify an existing payload without modifying a mismatched cache or installation.
 * @param root - Prepared runtime directory.
 * @param lock - Expected official release input.
 */
export async function verifyPreparedCuaRuntime(root: string, lock: CuaRuntimeLock): Promise<void> {
  if (!(await lstat(root)).isDirectory()) throw new Error('Cua runtime: regular payload directory required')
  const descriptor = JSON.parse(await readFile(join(root, 'cua-runtime.json'), 'utf8')) as {
    version: number
    target: string
    driverVersion: string
    lockHash: string
    files: unknown
  }
  if (descriptor.version !== 1 || descriptor.target !== 'win-x64' || descriptor.driverVersion !== lock.driverVersion
    || descriptor.lockHash !== createHash('sha256').update(JSON.stringify(lock)).digest('hex')
    || JSON.stringify((await inventory(root)).filter(file => file.path !== 'cua-runtime.json')) !== JSON.stringify(descriptor.files)) {
    throw new Error('Cua runtime: payload changed; prepare a fresh output')
  }
  await verifyRuntimeFiles(root)
}

/** Publish the full Windows release with its original sidecars and the locked upstream MIT license.
 * @param options - Output directory, immutable download cache and official release lock.
 * @returns Complete `runtime/cua` directory.
 */
export async function prepareCuaRuntime(options: { output: string; cache: string; lock: CuaRuntimeLock }): Promise<string> {
  const lock = validateCuaRuntimeLock(options.lock), output = resolve(options.output)
  let exists = false
  try { await lstat(output); exists = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (exists) {
    await verifyPreparedCuaRuntime(output, lock)
    smokeCuaRuntime(output, lock.driverVersion)
    return output
  }
  await mkdir(options.cache, { recursive: true })
  await mkdir(dirname(output), { recursive: true })
  const stage = await shortStage(output)
  try {
    const extracted = join(stage, '_archive')
    await unzip(await obtain(lock.targets['win-x64'], options.cache), extracted)
    const releaseDirectory = `cua-driver-rs-${lock.driverVersion}-windows-x86_64`
    const roots = await readdir(extracted)
    if (roots.length !== 1 || roots[0] !== releaseDirectory
      || !(await lstat(join(extracted, releaseDirectory))).isDirectory()) {
      throw new Error('Cua runtime: complete release archive directory required')
    }
    for (const entry of await readdir(join(extracted, releaseDirectory))) {
      await cp(join(extracted, releaseDirectory, entry), join(stage, entry), { recursive: true, errorOnExist: true, force: false })
    }
    await rm(extracted, { recursive: true })
    await cp(await obtain(lock.license, options.cache), join(stage, 'LICENSE'), { errorOnExist: true, force: false })
    await verifyRuntimeFiles(stage)
    await writeFile(join(stage, 'resources.lock.json'), JSON.stringify(lock, null, 2) + '\n')
    smokeCuaRuntime(stage, lock.driverVersion)
    await writeFile(join(stage, 'cua-runtime.json'), JSON.stringify({
      version: 1, target: 'win-x64', driverVersion: lock.driverVersion,
      lockHash: createHash('sha256').update(JSON.stringify(lock)).digest('hex'), files: await inventory(stage),
    }, null, 2) + '\n')
    await verifyPreparedCuaRuntime(stage, lock)
    await rename(stage, output)
    return output
  } finally { await rm(stage, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, cache: { type: 'string' } } })
  if (!values.output || !values.cache) throw new Error('Cua runtime: output and cache required')
  const lock = validateCuaRuntimeLock(JSON.parse(await readFile(new URL('./cua-runtime.lock.json', import.meta.url), 'utf8')))
  await prepareCuaRuntime({ output: values.output, cache: values.cache, lock })
}
