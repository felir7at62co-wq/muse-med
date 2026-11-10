/** Optional, explicit local v2 installation selection; runtime verification belongs to the downloader. */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

interface LocalInstallation {
  readonly version: 1
  readonly runtimeDir: string
  readonly stateDir: string
}

async function selectedEnvironment(value: LocalInstallation): Promise<NodeJS.ProcessEnv> {
  for (const path of [value.runtimeDir, value.stateDir]) {
    if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw new Error('Hongguo v2 installation path is invalid')
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Hongguo v2 installation directory is invalid')
  }
  const descriptor = await lstat(join(value.runtimeDir, 'v2-runtime.json'))
  if (!descriptor.isFile() || descriptor.isSymbolicLink()) throw new Error('Hongguo v2 runtime descriptor is missing')
  return { MUSE_HONGGUO_V2_RUNTIME_DIR: value.runtimeDir, MUSE_HONGGUO_V2_STATE_DIR: value.stateDir }
}

/**
 * Resolve explicit environment overrides or an optional private installation pointer.
 * @param productHome - Product-owned data root; no other installation is searched.
 * @param environment - Login-shell environment, which wins over a saved installation.
 * @returns The two v2 variables, or an empty object when no v2 installation is selected.
 */
export async function prepareDesktopHongguoV2Environment(productHome: string, environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const runtime = environment.MUSE_HONGGUO_V2_RUNTIME_DIR
  const state = environment.MUSE_HONGGUO_V2_STATE_DIR
  if (runtime !== undefined || state !== undefined) {
    if (!runtime || !state) throw new Error('Hongguo v2 requires both runtime and state directories')
    return selectedEnvironment({ version: 1, runtimeDir: runtime, stateDir: state })
  }
  const path = join(productHome, 'hongguo-v2', 'active-runtime.json')
  let info
  try { info = await lstat(path) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
  const parent = join(productHome, 'hongguo-v2')
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent) !== resolve(parent)) throw new Error('Hongguo v2 installation parent is invalid')
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384
    || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Hongguo v2 installation pointer is not a private regular file')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (value === null || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('runtimeDir' in value) || typeof value.runtimeDir !== 'string'
    || !('stateDir' in value) || typeof value.stateDir !== 'string') throw new Error('Hongguo v2 installation pointer is invalid')
  return selectedEnvironment({ version: 1, runtimeDir: value.runtimeDir, stateDir: value.stateDir })
}
