/** Installed pnpm launchers remain Node-executable across native-bin and legacy releases. */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { resolvePnpmEntrypoint } from './pnpm-entrypoint.mjs'

it.each([
  [{ pnpm: 'bin/pnpm.mjs' }, 'bin/pnpm.mjs'],
  [{ pnpm: 'bin/pnpm.cjs' }, 'bin/pnpm.cjs'],
  ['bin/pnpm.cjs', 'bin/pnpm.cjs'],
  [{ pnpm: 'pnpm' }, 'bin/pnpm.mjs'],
  [{ pnpm: 'pnpm.exe' }, 'bin/pnpm.mjs'],
  [{ pnpm: 'pnpm' }, 'bin/pnpm.cjs'],
] as const)('resolves declared bin %j through its installed JavaScript launcher', async (bin, launcher) => {
  const root = await mkdtemp(join(tmpdir(), 'pnpm-entrypoint-'))
  try {
    const manifest = join(root, 'package.json')
    await writeFile(manifest, JSON.stringify({ name: 'pnpm', bin }))
    await mkdir(dirname(join(root, launcher)), { recursive: true })
    await writeFile(join(root, launcher), '')
    expect(resolvePnpmEntrypoint(manifest)).toBe(await realpath(join(root, launcher)))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a native bin without the published JavaScript compatibility launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pnpm-no-js-entry-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'pnpm' } }))
    await writeFile(join(root, 'pnpm'), 'native executable')
    expect(() => resolvePnpmEntrypoint(join(root, 'package.json'))).toThrow('no JavaScript launcher')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['../outside.cjs', '/outside.mjs', String.raw`C:\outside.mjs`])('rejects a declared package-external bin %s', async (bin) => {
  const root = await mkdtemp(join(tmpdir(), 'pnpm-outside-entry-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: bin } }))
    expect(() => resolvePnpmEntrypoint(join(root, 'package.json'))).toThrow('bin must stay inside')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a JavaScript launcher linked outside its package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pnpm-linked-entry-'))
  try {
    const directory = join(root, 'pnpm')
    await mkdir(directory)
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'pnpm.mjs'), '')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'pnpm' } }))
    await symlink(outside, join(directory, 'bin'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => resolvePnpmEntrypoint(join(directory, 'package.json'))).toThrow('launcher must stay inside')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('runs the pinned installed pnpm version through Node without a shell', async () => {
  const manifest = resolve('node_modules/pnpm/package.json')
  const installed: { version: string } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string }
  const result = spawnSync(process.execPath, [resolvePnpmEntrypoint(manifest), '--version'], { encoding: 'utf8', timeout: 15_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe(installed.version)
})
