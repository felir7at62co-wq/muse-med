/** Source identities retain cancellation and filesystem error semantics. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fileSha256, readCacheIdentity } from '../src/cache.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-cache-identity-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

it('streams the same source identity with and without an active cancellation token', async () => {
  const root = await fixture(), file = join(root, 'source.bin')
  const bytes = Buffer.alloc(256 * 1024, 0x3a)
  await writeFile(file, bytes)
  const expected = createHash('sha256').update(bytes).digest('hex')
  await expect(fileSha256(file)).resolves.toBe(expected)
  await expect(fileSha256(file, new AbortController().signal)).resolves.toBe(expected)
  const controller = new AbortController(), reason = new Error('source operation cancelled')
  controller.abort(reason)
  await expect(fileSha256(file, controller.signal)).rejects.toBe(reason)
})

it('distinguishes an absent identity from an unreadable identity', async () => {
  const root = await fixture(), file = join(root, 'identity.txt')
  await expect(readCacheIdentity(file)).resolves.toBe('')
  await writeFile(file, 'recorded-source-identity\n')
  await expect(readCacheIdentity(file)).resolves.toBe('recorded-source-identity\n')
  await expect(readCacheIdentity(root)).rejects.toMatchObject({ code: 'EISDIR' })
})
