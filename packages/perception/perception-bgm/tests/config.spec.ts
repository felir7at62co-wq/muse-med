/** Deployment configuration resolves only explicit or allowlisted existing paths. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultWeightsPath, resolvePython, resolveWeights, PYTHON_ENV_VAR, WEIGHTS_ENV_VAR } from '../src/config.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('prefers explicit paths, then environment paths, without guessing absent resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgm-config-'))
  roots.push(root)
  const configured = join(root, 'configured'), ambient = join(root, 'ambient')
  await writeFile(configured, 'resource')
  await writeFile(ambient, 'resource')
  vi.stubEnv(PYTHON_ENV_VAR, ambient)
  vi.stubEnv(WEIGHTS_ENV_VAR, ambient)
  expect(resolvePython(configured)).toBe(configured)
  expect(resolvePython(undefined)).toBe(ambient)
  expect(resolveWeights(configured)).toBe(configured)
  expect(resolveWeights(undefined)).toBe(ambient)
  for (const value of ['', '  ', 'relative', join(root, 'missing')]) {
    expect(resolvePython(value)).toBe('')
    expect(resolveWeights(value)).toBe(defaultWeightsPath())
  }
  vi.stubEnv(PYTHON_ENV_VAR, undefined)
  vi.stubEnv(WEIGHTS_ENV_VAR, undefined)
  expect(resolvePython(undefined)).toBe('')
  expect(resolveWeights(undefined)).toBe(defaultWeightsPath())
})
