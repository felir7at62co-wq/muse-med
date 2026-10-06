/** Production paths remain inside verified real directories without creating a project layout. */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { productionSubdirectory, resolveProductionRoot, verifiedDirectory } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-workspace-')))
  roots.push(root)
  const session = join(root, 'session'), configured = join(root, 'configured')
  await mkdir(session); await mkdir(configured)
  return { root, session, configured }
}

it('resolves the session directory before a configured fallback and leaves absent subdirectories uncreated', async () => {
  const f = await fixture()
  expect(await resolveProductionRoot({ sessionCwd: f.session, configuredRoot: f.configured }))
    .toEqual({ root: f.session, fromSession: true })
  expect(await resolveProductionRoot({ sessionCwd: ' ', configuredRoot: f.configured })).toEqual({ root: f.configured, fromSession: false })
  expect(await resolveProductionRoot({ configuredRoot: f.configured, configuredLabel: 'music root' })).toEqual({ root: f.configured, fromSession: false })
  expect(await productionSubdirectory(f.session, 'new', 'nested')).toBe(join(f.session, 'new', 'nested'))
  await expect(readFile(join(f.session, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await productionSubdirectory(f.session)).toBe(f.session)
})

it('refuses absent, relative and non-directory roots without replacing their contents', async () => {
  const f = await fixture(), file = join(f.root, 'file')
  await writeFile(file, 'retained')
  for (const path of ['', '  ', 'relative']) await expect(verifiedDirectory(path, 'root')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(verifiedDirectory(join(f.root, 'missing'), 'root')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(verifiedDirectory(file, 'root')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(await readFile(file, 'utf8')).toBe('retained')
  for (const input of [{}, { sessionCwd: ' ', configuredRoot: ' ' }, { sessionCwd: '' }]) {
    await expect(resolveProductionRoot(input)).rejects.toMatchObject({ code: 'DEPENDENCY_MISSING' })
  }
})

it('rejects direct and ancestor directory redirects', async () => {
  const f = await fixture(), alias = join(f.root, 'alias')
  await mkdir(join(f.configured, 'nested'))
  await symlink(f.configured, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(verifiedDirectory(alias, 'root')).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' })
  await expect(verifiedDirectory(join(alias, 'nested'), 'root')).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' })
  await symlink(f.configured, join(f.session, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(productionSubdirectory(f.session, 'redirect', 'nested')).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' })
})

it('allows existing real segments but rejects both traversal and sibling-prefix paths', async () => {
  const f = await fixture()
  await mkdir(join(f.session, 'real'))
  expect(await productionSubdirectory(f.session, 'real', 'new')).toBe(join(f.session, 'real', 'new'))
  await writeFile(join(f.session, 'file'), 'retained')
  expect(await productionSubdirectory(f.session, 'file')).toBe(join(f.session, 'file'))
  for (const part of ['..', '../configured', '../session-sibling', f.configured]) {
    await expect(productionSubdirectory(f.session, part)).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' })
  }
})
