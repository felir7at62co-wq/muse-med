/** Development runtime overrides validate native payloads without preparing replacements. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareDevelopmentRuntime } from '../scripts/development-runtime.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function payload(manifest: unknown = { platform: process.platform, arch: process.arch }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop development runtime '))
  roots.push(root)
  await writeFile(join(root, 'runtime.json'), JSON.stringify(manifest))
  return root
}

function actions() {
  return { prepare: vi.fn(async () => undefined), verify: vi.fn(async (_directory: string) => undefined) }
}

it('prepares only the default runtime when the override is absent', async () => {
  const operations = actions()
  await expect(prepareDevelopmentRuntime(undefined, operations)).resolves.toBeUndefined()
  expect(operations.prepare).toHaveBeenCalledOnce()
  expect(operations.verify).not.toHaveBeenCalled()
})

it.each(['absolute', 'relative'] as const)('verifies the same absolute override directory from an %s path', async (kind) => {
  const directory = await payload()
  const override = kind === 'relative' ? relative(process.cwd(), directory) : directory
  const operations = actions()
  await expect(prepareDevelopmentRuntime(override, operations)).resolves.toBe(resolve(directory))
  expect(operations.verify).toHaveBeenCalledExactlyOnceWith(resolve(directory))
  expect(operations.prepare).not.toHaveBeenCalled()
})

it.each(['', ' ', '\t\n'])('rejects an empty override without preparation or verification (%j)', async (override) => {
  const operations = actions()
  await expect(prepareDevelopmentRuntime(override, operations)).rejects.toThrow('must not be empty')
  expect(operations.prepare).not.toHaveBeenCalled()
  expect(operations.verify).not.toHaveBeenCalled()
})

it.each([
  { platform: 'unsupported-platform', arch: process.arch },
  { platform: process.platform, arch: 'unsupported-arch' },
  {}, null, [], 'not a manifest',
])('rejects a nonnative or malformed manifest without falling back: %j', async (manifest) => {
  const directory = await payload(manifest)
  const operations = actions()
  await expect(prepareDevelopmentRuntime(directory, operations)).rejects.toThrow('must target')
  expect(operations.prepare).not.toHaveBeenCalled()
  expect(operations.verify).not.toHaveBeenCalled()
})

it('propagates verification failure without preparing a replacement', async () => {
  const directory = await payload()
  const operations = actions()
  const failure = new Error('payload verification failed')
  operations.verify.mockRejectedValue(failure)
  await expect(prepareDevelopmentRuntime(directory, operations)).rejects.toBe(failure)
  expect(operations.verify).toHaveBeenCalledExactlyOnceWith(resolve(directory))
  expect(operations.prepare).not.toHaveBeenCalled()
})

it('propagates default preparation failure without verifying an override', async () => {
  const operations = actions()
  const failure = new Error('default preparation failed')
  operations.prepare.mockRejectedValue(failure)
  await expect(prepareDevelopmentRuntime(undefined, operations)).rejects.toBe(failure)
  expect(operations.verify).not.toHaveBeenCalled()
})

it('refuses an unreadable manifest before either action', async () => {
  const directory = await payload()
  await rm(join(directory, 'runtime.json'))
  const operations = actions()
  await expect(prepareDevelopmentRuntime(directory, operations)).rejects.toThrow()
  expect(operations.prepare).not.toHaveBeenCalled()
  expect(operations.verify).not.toHaveBeenCalled()
})
