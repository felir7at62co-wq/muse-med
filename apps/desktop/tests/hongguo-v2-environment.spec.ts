/** Optional v2 selection never imports a different product's installation or replaces v1 state. */
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareDesktopHongguoV2Environment } from '../src/hongguo-v2-environment.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-v2-selection-')))
  roots.push(root)
  const runtimeDir = join(root, 'runtime'), stateDir = join(root, 'hongguo-v2')
  await mkdir(runtimeDir); await mkdir(stateDir)
  await writeFile(join(runtimeDir, 'v2-runtime.json'), '{}')
  return { root, runtimeDir, stateDir, pointer: join(stateDir, 'active-runtime.json') }
}
it('leaves unconfigured installations unchanged', async () => {
  const f = await fixture()
  expect(await prepareDesktopHongguoV2Environment(f.root, {})).toEqual({})
})
it('uses a private saved installation and lets explicit paired paths take precedence', async () => {
  const f = await fixture()
  await writeFile(f.pointer, JSON.stringify({ version: 1, runtimeDir: f.runtimeDir, stateDir: f.stateDir }), { mode: 0o600 })
  const expected = { MUSE_HONGGUO_V2_RUNTIME_DIR: f.runtimeDir, MUSE_HONGGUO_V2_STATE_DIR: f.stateDir }
  expect(await prepareDesktopHongguoV2Environment(f.root, {})).toEqual(expected)
  await writeFile(f.pointer, 'invalid')
  expect(await prepareDesktopHongguoV2Environment(f.root, expected)).toEqual(expected)
})
it('refuses incomplete explicit configuration and invalid saved versions', async () => {
  const f = await fixture()
  await expect(prepareDesktopHongguoV2Environment(f.root, { MUSE_HONGGUO_V2_RUNTIME_DIR: f.runtimeDir })).rejects.toThrow('requires both')
  await writeFile(f.pointer, JSON.stringify({ version: 2, runtimeDir: f.runtimeDir, stateDir: f.stateDir }), { mode: 0o600 })
  await expect(prepareDesktopHongguoV2Environment(f.root, {})).rejects.toThrow('pointer is invalid')
})
it('refuses a linked pointer or runtime descriptor', async () => {
  const f = await fixture(), target = join(f.root, 'target.json')
  await writeFile(target, JSON.stringify({ version: 1, runtimeDir: f.runtimeDir, stateDir: f.stateDir }), { mode: 0o600 })
  await symlink(target, f.pointer)
  await expect(prepareDesktopHongguoV2Environment(f.root, {})).rejects.toThrow('private regular file')
  await rm(join(f.runtimeDir, 'v2-runtime.json')); await symlink(target, join(f.runtimeDir, 'v2-runtime.json'))
  await expect(prepareDesktopHongguoV2Environment(f.root, { MUSE_HONGGUO_V2_RUNTIME_DIR: f.runtimeDir, MUSE_HONGGUO_V2_STATE_DIR: f.stateDir })).rejects.toThrow('descriptor')
})
it.skipIf(process.platform === 'win32')('rejects a world-readable installation pointer', async () => {
  const f = await fixture()
  await writeFile(f.pointer, JSON.stringify({ version: 1, runtimeDir: f.runtimeDir, stateDir: f.stateDir }), { mode: 0o644 })
  await expect(prepareDesktopHongguoV2Environment(f.root, {})).rejects.toThrow('private regular file')
})
