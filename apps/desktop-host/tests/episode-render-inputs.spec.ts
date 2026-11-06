/** Real local file capture and exclusive staging retain measured bytes and ownership. */
import { createHash } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { captureEpisodeDirectory, inspectEpisodeFile, stageEpisodeFile } from '../src/episode-render-inputs.ts'

const signal = () => new AbortController().signal
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-episode-input-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.mp4')
  await writeFile(source, 'captured original bytes')
  return { root, source, target: join(root, 'staged.mp4') }
}

it('hashes complete local files larger than the provider video download ceiling', async () => {
  const f = await fixture(), bytes = 512 * 1024 * 1024 + 17
  const file = await open(f.source, 'r+')
  try { await file.truncate(0); await file.truncate(bytes) } finally { await file.close() }
  const expected = createHash('sha256'), zero = Buffer.alloc(65536)
  for (let remaining = bytes; remaining > 0; remaining -= zero.length) {
    expected.update(zero.subarray(0, Math.min(remaining, zero.length)))
  }
  expect(await inspectEpisodeFile(f.source, signal())).toEqual({ path: f.source, bytes, sha256: expected.digest('hex') })
})

it('stages exact captured bytes into a new file with its own inode', async () => {
  const f = await fixture(), facts = await inspectEpisodeFile(f.source, signal())
  expect(facts).toEqual({ path: f.source, bytes: Buffer.byteLength('captured original bytes'), sha256: hash('captured original bytes') })
  expect(await stageEpisodeFile(facts, f.target, signal())).toEqual({ ...facts, path: f.target })
  expect(await readFile(f.target)).toEqual(await readFile(f.source))
  expect((await lstat(f.target)).ino).not.toBe((await lstat(f.source)).ino)
})

it('refuses an occupied target without changing its contents or inode', async () => {
  const f = await fixture(), facts = await inspectEpisodeFile(f.source, signal())
  await writeFile(f.target, 'existing owner bytes')
  const before = await lstat(f.target)
  await expect(stageEpisodeFile(facts, f.target, signal())).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(f.target, 'utf8')).toBe('existing owner bytes')
  expect(await lstat(f.target)).toMatchObject({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs })
})

it('removes only its failed new stage when the current source differs from captured facts', async () => {
  const f = await fixture(), facts = await inspectEpisodeFile(f.source, signal())
  await writeFile(f.source, 'changed since capture')
  await expect(stageEpisodeFile(facts, f.target, signal())).rejects.toThrow('differs from its captured facts')
  await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(f.source, 'utf8')).toBe('changed since capture')
})

it('leaves the source unchanged when opening a missing target parent fails', async () => {
  const f = await fixture(), facts = await inspectEpisodeFile(f.source, signal())
  await expect(stageEpisodeFile(facts, join(f.root, 'missing', 'target.mp4'), signal())).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await inspectEpisodeFile(f.source, signal())).toEqual(facts)
})

it('refuses a directory input and propagates an absent source', async () => {
  const f = await fixture()
  await expect(inspectEpisodeFile(f.root, signal())).rejects.toThrow('canonical regular file')
  await expect(inspectEpisodeFile(join(f.root, 'absent.mp4'), signal())).rejects.toMatchObject({ code: 'ENOENT' })
})

// Windows file symlinks require a developer-mode or privilege setting that this fixture does not change.
it.skipIf(process.platform === 'win32')('refuses a file symlink without replacing an occupied link target', async () => {
  const f = await fixture(), alias = join(f.root, 'alias.mp4')
  await symlink(f.source, alias)
  await expect(inspectEpisodeFile(alias, signal())).rejects.toThrow('canonical regular file')
  const facts = await inspectEpisodeFile(f.source, signal())
  await expect(stageEpisodeFile(facts, alias, signal())).rejects.toMatchObject({ code: 'EEXIST' })
  expect((await lstat(alias)).isSymbolicLink()).toBe(true)
  expect(await readFile(f.source, 'utf8')).toBe('captured original bytes')
})

it('honors cancellation before reading or allocating a target', async () => {
  const f = await fixture(), facts = await inspectEpisodeFile(f.source, signal()), control = new AbortController()
  control.abort(new Error('capture cancelled before IO'))
  await expect(inspectEpisodeFile(join(f.root, 'absent'), control.signal)).rejects.toThrow('capture cancelled before IO')
  await expect(stageEpisodeFile(facts, f.target, control.signal)).rejects.toThrow('capture cancelled before IO')
  await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('captures every file in a nested font directory in stable order with exact byte facts', async () => {
  const f = await fixture(), root = join(f.root, 'fonts')
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'a.otf'), 'first font bytes')
  await writeFile(join(root, 'nested', 'b.ttf'), 'second font bytes')
  expect(await captureEpisodeDirectory(root, 3, signal())).toEqual([
    { path: join(root, 'a.otf'), bytes: 16, sha256: hash('first font bytes') },
    { path: join(root, 'nested', 'b.ttf'), bytes: 17, sha256: hash('second font bytes') },
  ])
  await expect(captureEpisodeDirectory(root, 2, signal())).rejects.toThrow('entry limit')
})

it('refuses empty font directories and cancelled traversals', async () => {
  const f = await fixture(), root = join(f.root, 'fonts'), control = new AbortController()
  await mkdir(root)
  await expect(captureEpisodeDirectory(root, 8, signal())).rejects.toThrow('font directory is empty')
  control.abort(new Error('font capture cancelled'))
  await expect(captureEpisodeDirectory(root, 8, control.signal)).rejects.toThrow('font capture cancelled')
})

// Windows file symlinks require a developer-mode or privilege setting that this fixture does not change.
it.skipIf(process.platform === 'win32')('refuses a nested font symlink rather than hashing outside the selected directory', async () => {
  const f = await fixture(), root = join(f.root, 'fonts')
  await mkdir(root)
  await symlink(f.source, join(root, 'alias.otf'))
  await expect(captureEpisodeDirectory(root, 8, signal())).rejects.toThrow('canonical regular file')
})

it('treats linked source aliases as exact bytes while staging an independent copy', async () => {
  const f = await fixture(), alias = join(f.root, 'hard-linked-source.mp4')
  await link(f.source, alias)
  const facts = await inspectEpisodeFile(alias, signal())
  await stageEpisodeFile(facts, f.target, signal())
  await writeFile(f.source, 'new linked source bytes')
  expect(await readFile(f.target, 'utf8')).toBe('captured original bytes')
})
