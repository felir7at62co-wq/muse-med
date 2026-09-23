import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', folder: '', platform: 'win', license: true }))
vi.mock('../scripts/desktop-build-paths.mjs', () => ({
  resolveDesktopTargetBuildPaths: () => ({
    runtime: join(state.root, 'runtime'), downloads: join(state.root, 'downloads'), nodeExtract: join(state.root, 'extract'),
  }),
}))
vi.mock('node:child_process', () => ({ spawnSync: () => ({ status: 0, stdout: 'v24.17.0\n' }) }))
async function extracted(dir: string): Promise<void> {
  const root = join(dir, state.folder)
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(join(root, state.platform === 'win' ? 'node.exe' : 'bin/node'), 'fixture executable')
  if (state.license) await writeFile(join(root, 'LICENSE'), Buffer.from('upstream notices\r\n\x00complete bytes\r\n'))
}
vi.mock('extract-zip', () => ({ default: async (_archive: string, options: { dir: string }) => extracted(options.dir) }))
vi.mock('tar', () => ({ extract: async (options: { cwd: string }) => extracted(options.cwd) }))
afterEach(async () => {
  if (state.root !== '') await rm(state.root, { recursive: true, force: true })
  vi.resetModules()
})

it.each(['win', 'darwin'] as const)('preserves the complete upstream Node license for %s and refuses its absence', async (platform) => {
  state.root = await mkdtemp(join(tmpdir(), 'desktop-node-notices-'))
  state.platform = platform
  state.folder = `node-v24.17.0-${platform}-x64`
  state.license = true
  const downloads = join(state.root, 'downloads')
  await mkdir(downloads)
  const archive = `${state.folder}.${platform === 'win' ? 'zip' : 'tar.gz'}`
  const bytes = Buffer.from('verified archive fixture')
  await writeFile(join(downloads, archive), bytes)
  await writeFile(join(downloads, 'node-v24.17.0-SHASUMS256.txt'), `${createHash('sha256').update(bytes).digest('hex')}  ${archive}\n`)
  const { prepareNode } = await import('../scripts/prepare-runtime.ts')
  await prepareNode(platform, 'x64')
  const license = join(state.root, 'runtime/node/LICENSE')
  expect(await readFile(license)).toEqual(Buffer.from('upstream notices\r\n\x00complete bytes\r\n'))
  state.license = false
  await expect(prepareNode(platform, 'x64')).rejects.toThrow(/LICENSE/u)
  expect(await readFile(license)).toEqual(Buffer.from('upstream notices\r\n\x00complete bytes\r\n'))
})
