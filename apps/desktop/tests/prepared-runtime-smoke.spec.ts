import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { smokePreparedRuntime } from '../scripts/smoke-prepared-runtime.ts'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'
import { verifyRuntimeArchive } from '../scripts/verify-runtime-archive.ts'
import { runConcurrent } from '../../../scripts/release/process.ts'
import { prepareDesktopHongguoEnvironment } from '../src/hongguo-runtime.ts'

const { payload } = vi.hoisted(() => ({ payload: vi.fn(async (..._args: unknown[]) => ({ stdout: '' })) }))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: payload }) }
})
vi.mock('../scripts/smoke-runtime.ts', () => ({ smokeDesktopRuntime: vi.fn(async () => {}) }))
vi.mock('../scripts/verify-runtime-archive.ts', () => ({ verifyRuntimeArchive: vi.fn(async () => {}) }))
vi.mock('../../../scripts/release/process.ts', () => ({ runConcurrent: vi.fn(async () => {}) }))
vi.mock('../src/hongguo-runtime.ts', () => ({ prepareDesktopHongguoEnvironment: vi.fn(async (options: { productHome: string }) => {
  mkdirSync(join(options.productHome, 'source'), { recursive: true })
  return {
    MUSE_HONGGUO_LEGACY_APP_DIR: join(options.productHome, 'source'), MUSE_HONGGUO_BOOTSTRAP_DEVICES: '1',
    MUSE_HONGGUO_JAVA_PATH: join(options.productHome, 'java'), MUSE_HONGGUO_PYTHON_PATH: join(options.productHome, 'python'),
  }
}) }))

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
  const options = payload.mock.calls[0]![2] as { timeout: number; env: NodeJS.ProcessEnv }
  expect(options.timeout).toBe(300_000)
  expect(options.env.MUSE_HONGGUO_BOOTSTRAP_DEVICES).toBe('1')
  expect(prepareDesktopHongguoEnvironment).toHaveBeenCalledWith({
    runtime: join(resources, 'hongguo'), productHome: join(options.env.NARB_NATIVE_CACHE_DIR!, 'muse'),
  })
  expect(vi.mocked(prepareDesktopHongguoEnvironment).mock.invocationCallOrder[0]).toBeLessThan(payload.mock.invocationCallOrder[0]!)
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
  expect(prepareDesktopHongguoEnvironment).not.toHaveBeenCalled()
})

it('cleans the private home when native payload acceptance fails before Host startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'failed-native-runtime-'))
  roots.push(root)
  payload.mockRejectedValueOnce(new Error('native acceptance failed'))
  await expect(smokePreparedRuntime(root, process.execPath, root, runtimeFixture(root))).rejects.toThrow('native acceptance failed')
  const { productHome } = vi.mocked(prepareDesktopHongguoEnvironment).mock.calls[0]![0]
  expect(existsSync(productHome)).toBe(false)
  expect(smokeDesktopRuntime).not.toHaveBeenCalled()
  expect(runConcurrent).not.toHaveBeenCalled()
})

it('refuses to launch a target runtime when its Hongguo source preparation fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'failed-hongguo-preparation-'))
  roots.push(root)
  vi.mocked(prepareDesktopHongguoEnvironment).mockRejectedValueOnce(new Error('source changed'))
  await expect(smokePreparedRuntime(root, process.execPath, root, runtimeFixture(root))).rejects.toThrow('source changed')
  const { productHome } = vi.mocked(prepareDesktopHongguoEnvironment).mock.calls[0]![0]
  expect(existsSync(productHome)).toBe(false)
  expect(payload).not.toHaveBeenCalled()
  expect(smokeDesktopRuntime).not.toHaveBeenCalled()
})
