/** Media identities retain exact bytes and cancellation; cache misses do not hide read errors. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fileSha256, readCacheIdentity } from '../src/cache.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'episode-cache-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return { root, path: join(root, 'identity') }
}

it('hashes the original file without requiring a cancellation signal or modifying its bytes', async () => {
  const { path } = await fixture()
  await writeFile(path, 'abc')
  expect(await fileSha256(path)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(await fileSha256(path, new AbortController().signal)).toBe(await fileSha256(path))
  expect(await readFile(path, 'utf8')).toBe('abc')
})

it('honors cancellation before opening a missing source', async () => {
  const { path } = await fixture(), canceled = Error('Source operation was canceled')
  await expect(fileSha256(path, AbortSignal.abort(canceled))).rejects.toBe(canceled)
})

it('distinguishes a missing identity from an unreadable path and retains the complete saved identity', async () => {
  const { root, path } = await fixture()
  expect(await readCacheIdentity(path)).toBe('')
  await writeFile(path, 'original-source-sha\n')
  expect(await readCacheIdentity(path)).toBe('original-source-sha\n')
  await expect(readCacheIdentity(root)).rejects.toMatchObject({ code: 'EISDIR' })
})
