import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { smokePreparedRuntime } from '../scripts/smoke-prepared-runtime.ts'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'
import { verifyRuntimeArchive } from '../scripts/verify-runtime-archive.ts'
import { runConcurrent } from '../../../scripts/release/process.ts'

const { payload } = vi.hoisted(() => ({ payload: vi.fn(async (..._args: unknown[]) => ({ stdout: '' })) }))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: payload }) }
})
vi.mock('../scripts/smoke-runtime.ts', () => ({ smokeDesktopRuntime: vi.fn(async () => {}) }))
vi.mock('../scripts/verify-runtime-archive.ts', () => ({ verifyRuntimeArchive: vi.fn(async () => {}) }))
vi.mock('../../../scripts/release/process.ts', () => ({ runConcurrent: vi.fn(async () => {}) }))

const roots: string[] = []
const hostArch = Object.getOwnPropertyDescriptor(process, 'arch')!
afterEach(() => {
  Object.defineProperty(process, 'arch', hostArch)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

it('smokes an x64 target verified on an arm64 build host without revalidating against the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-target-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: 'darwin' as const, arch: 'x64' }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  Object.defineProperty(process, 'arch', { ...hostArch, value: 'arm64' })
  await expect(verifyDesktopRuntime(root, fixture.release.version, { ...target, arch: process.arch }))
    .rejects.toThrow(/incompatible/u)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  const electron = join(root, 'target-electron')
  const resources = join(root, 'runtime')
  await smokePreparedRuntime(root, electron, resources, descriptor)
  expect(payload.mock.calls[0]![0]).toBe(electron)
  expect(payload.mock.calls[0]![1]).toEqual(expect.arrayContaining([root, resources]))
  expect(smokeDesktopRuntime).toHaveBeenCalledWith(root, electron, descriptor, expect.any(Object), resources)
  const environment = vi.mocked(smokeDesktopRuntime).mock.calls[0]![3]
  expect(existsSync(environment.NARB_NATIVE_CACHE_DIR!)).toBe(false)
})

it.each([false, true])('verifies archive bytes before Electron Host smoke and cleans its cache (child fails: %s)', async (fail) => {
  const root = mkdtempSync(join(tmpdir(), 'archived-runtime-target-'))
  roots.push(root)
  const descriptor = runtimeFixture(root)
  const archived = join(root, 'app.asar', 'dsh')
  const electron = join(root, 'muse-med.exe')
  const resources = join(root, 'runtime')
  if (fail) vi.mocked(runConcurrent).mockRejectedValueOnce(new Error('archived Host failed'))
  const result = smokePreparedRuntime(archived, electron, resources, descriptor)
  if (fail) await expect(result).rejects.toThrow('archived Host failed')
  else await result
  expect(verifyRuntimeArchive).toHaveBeenCalledWith(join(root, 'app.asar'), descriptor)
  expect(vi.mocked(verifyRuntimeArchive).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runConcurrent).mock.invocationCallOrder[0]!)
  expect(runConcurrent).toHaveBeenCalledWith(electron, expect.arrayContaining([archived, electron, resources]), expect.any(Object))
  expect(smokeDesktopRuntime).not.toHaveBeenCalled()
  const environment = vi.mocked(runConcurrent).mock.calls[0]![2]!.env!
  expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(existsSync(environment.NARB_NATIVE_CACHE_DIR!)).toBe(false)
})

it('does not execute an archived runtime whose integrity check fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rejected-runtime-target-'))
  roots.push(root)
  vi.mocked(verifyRuntimeArchive).mockRejectedValueOnce(new Error('archive changed'))
  await expect(smokePreparedRuntime(join(root, 'app.asar', 'dsh'), process.execPath, root, runtimeFixture(root)))
    .rejects.toThrow('archive changed')
  expect(payload).not.toHaveBeenCalled()
  expect(runConcurrent).not.toHaveBeenCalled()
  expect(smokeDesktopRuntime).not.toHaveBeenCalled()
})
