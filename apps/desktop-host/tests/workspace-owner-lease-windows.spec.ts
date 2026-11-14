/** Win32 kernel ownership protocol, with deterministic native API doubles. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ create: vi.fn(() => 7), wait: vi.fn(() => 0), release: vi.fn(() => 1),
  close: vi.fn(() => 1), move: vi.fn(() => 1) }))
vi.mock('koffi', () => ({ default: { load: () => ({ func: (_abi: string, name: string) => {
  if (name === 'CreateMutexW') return native.create
  if (name === 'WaitForSingleObject') return native.wait
  if (name === 'ReleaseMutex') return native.release
  if (name === 'CloseHandle') return native.close
  if (name === 'MoveFileExW') return native.move
  throw new Error(name)
} }) } }))
import { acquireWorkspaceOwner, publishWorkspacePath } from '../src/workspace-owner-lease.ts'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
if (originalPlatform === undefined) throw new Error('platform descriptor missing')
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.clearAllMocks() })

it('accepts abandoned kernel mutex ownership and releases it exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-owned-win32-'))
  Object.defineProperty(process, 'platform', { value: 'win32' })
  native.wait.mockReturnValueOnce(0x80)
  try {
    const owner = await acquireWorkspaceOwner(join(root, 'store.lock'))
    await expect(acquireWorkspaceOwner(join(root, 'store.lock'))).rejects.toThrow('already owned')
    await owner.release()
    await owner.release()
    expect(native.release).toHaveBeenCalledTimes(1)
    expect(native.close).toHaveBeenCalledTimes(1)
    expect(native.wait).toHaveBeenCalledWith(7, 0)
  } finally { Object.defineProperty(process, 'platform', originalPlatform); await rm(root, { recursive: true, force: true }) }
})

it('closes a contended mutex without releasing another process ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-owned-win32-'))
  Object.defineProperty(process, 'platform', { value: 'win32' })
  native.wait.mockReturnValueOnce(0x102)
  try {
    await expect(acquireWorkspaceOwner(join(root, 'store.lock'))).rejects.toThrow('already owned')
    expect(native.close).toHaveBeenCalledOnce()
    expect(native.release).not.toHaveBeenCalled()
  } finally { Object.defineProperty(process, 'platform', originalPlatform); await rm(root, { recursive: true, force: true }) }
})

it('publishes with write-through and explicitly selected replace semantics', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  await publishWorkspacePath('/source', '/target', false)
  expect(native.move).toHaveBeenLastCalledWith(toNamespacedPath('/source'), toNamespacedPath('/target'), 8)
  await publishWorkspacePath('/source', '/target', true)
  expect(native.move).toHaveBeenLastCalledWith(toNamespacedPath('/source'), toNamespacedPath('/target'), 9)
  native.move.mockReturnValueOnce(0)
  await expect(publishWorkspacePath('/source', '/target', true)).rejects.toThrow('durable publication failed')
})
