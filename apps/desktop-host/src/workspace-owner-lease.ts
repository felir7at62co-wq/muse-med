/** Exclusive kernel ownership of the Desktop workspace successor store.
 * @module @deepseek-ai/dsh-desktop-host/workspace-owner-lease
 */
import { createHash } from 'node:crypto'
import { mkdir, open, realpath, stat, rename } from 'node:fs/promises'
import { basename, dirname, join, resolve, toNamespacedPath } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

/** Held exclusive store owner; closing releases its kernel resource. */
export interface WorkspaceOwnerLease {
  /** Release the held kernel object once; resolves after its handle closes. */
  release(): Promise<void>
}
const heldPaths = new Set<string>()

/**
 * Acquire the same kernel object for every spelling of a store path.
 * @param path - Lock path beside the successor store, never inside a renamed directory.
 * @returns the owner lease, or rejects while another process owns the store.
 */
export async function acquireWorkspaceOwner(path: string): Promise<WorkspaceOwnerLease> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 })
  const canonical = join(await realpath(dirname(resolve(path))), basename(path))
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  if (heldPaths.has(key)) throw new Error('workspace successor store is already owned')
  heldPaths.add(key)
  let release: (() => Promise<void>) | undefined
  try {
    release = process.platform === 'win32' ? await lockWindows(key) : await lockPosix(canonical)
  } catch (error) {
    heldPaths.delete(key)
    throw error
  }
  let released = false
  return { release: async () => {
    if (released) return
    released = true
    try { await release() } finally { heldPaths.delete(key) }
  } }
}

async function lockPosix(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(path, 'a+', 0o600)
    try {
      await tryLockExclusive(handle.fd)
      const [held, current] = await Promise.all([handle.stat({ bigint: true }), stat(path, { bigint: true })])
      if (held.dev === current.dev && held.ino === current.ino) return () => handle.close()
    } catch (error) {
      await handle.close()
      throw error
    }
    await handle.close()
  }
  throw new Error('workspace owner lock path changed while acquiring')
}

type WinCall = (handle: number, value: number) => number
type CloseCall = (handle: number) => number
type CreateCall = (security: null, owned: number, name: string) => number
async function lockWindows(path: string): Promise<() => Promise<void>> {
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll')
  const create = kernel.func('__stdcall', 'CreateMutexW', 'intptr', ['void*', 'int', 'str16']) as CreateCall
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']) as WinCall
  const release = kernel.func('__stdcall', 'ReleaseMutex', 'int', ['intptr']) as CloseCall
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as CloseCall
  const handle = create(null, 0, `Local\\muse-workspace-owner-${createHash('sha256').update(path).digest('hex')}`)
  if (handle === 0) throw new Error('workspace owner mutex could not be opened')
  const status = wait(handle, 0)
  // WAIT_ABANDONED transfers a mutex after its previous owning process died.
  if (status !== 0 && status !== 0x80) {
    close(handle)
    throw new Error('workspace successor store is already owned or unavailable')
  }
  return () => {
    const unlocked = release(handle)
    const closed = close(handle)
    if (unlocked === 0 || closed === 0) return Promise.reject(new Error('workspace owner mutex release failed'))
    return Promise.resolve()
  }
}

/**
 * Atomically publish a store file or its complete migration directory.
 * @param source - Same-volume staging path.
 * @param target - Final path.
 * @param replace - Whether an existing target may be replaced.
 */
export async function publishWorkspacePath(source: string, target: string, replace: boolean): Promise<void> {
  if (process.platform !== 'win32') { await rename(source, target); return }
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll')
  const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as (from: string, to: string, flags: number) => number
  // WRITE_THROUGH; no cross-volume copy fallback is allowed.
  if (move(toNamespacedPath(source), toNamespacedPath(target), 8 | (replace ? 1 : 0)) === 0) {
    throw new Error('workspace store durable publication failed')
  }
}
