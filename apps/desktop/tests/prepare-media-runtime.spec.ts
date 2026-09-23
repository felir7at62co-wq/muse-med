import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { assertMediaArchivePath, verifyMediaResource, validateMediaLock, verifyPreparedMediaRuntime } from '../scripts/prepare-media-runtime.ts'

it('rejects ZIP paths that can escape or alias Windows installation files', () => {
  for (const name of ['../x', '/x', 'C:/x', 'x/../../y', 'x\\y', 'x:stream', 'CON', 'a/NUL.txt', 'x. /y', 'x\u0000y']) {
    expect(() => { assertMediaArchivePath(name) }, name).toThrow()
  }
  expect(() => { assertMediaArchivePath('Lib/site-packages/pkg/module.py') }).not.toThrow()
})

it('requires resource hashes and credentials-free HTTPS sources before download', () => {
  const resource = { filename: 'python.zip', url: 'https://www.python.org/python.zip', sha256: 'a'.repeat(64), bytes: 12 }
  const valid = { version: 1, pythonVersion: '3.12.10', python: resource, ffmpeg: resource, model: resource, font: resource,
    vcRedist: { ...resource, productVersion: '14.51.36247.0' }, peInspector: resource, wheels: [resource], notices: [resource] }
  expect(() => validateMediaLock(valid)).not.toThrow()
  for (const patch of [{ sha256: '' }, { bytes: 0 }, { url: 'https://secret@example.com/x' }, { filename: '../x' }]) {
    expect(() => validateMediaLock({ ...valid, python: { ...resource, ...patch } })).toThrow()
  }
})

const fontBytes = Buffer.from('fixture-font')
const releaseLock = validateMediaLock({
  ...JSON.parse(await readFile(new URL('../scripts/media-runtime.lock.json', import.meta.url), 'utf8')),
  font: { filename: 'test.otf', url: 'https://example.com/test.otf', bytes: fontBytes.length,
    sha256: createHash('sha256').update(fontBytes).digest('hex') },
})

it('requires a hash-locked CJK font resource', () => {
  expect(() => validateMediaLock({ ...releaseLock, font: undefined })).toThrow(/resource/)
})

it('requires the offline Visual C++ redistributable and its exact product version', () => {
  expect(() => validateMediaLock({ ...releaseLock, vcRedist: undefined })).toThrow()
  expect(() => validateMediaLock({ ...releaseLock, vcRedist: { ...releaseLock.python, productVersion: 'latest' } })).toThrow()
})

it('reuses only a complete unchanged inventory and rejects extra files or changed locks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-inventory-'))
  try {
    const content = JSON.stringify(releaseLock)
    await writeFile(join(root, 'resources.lock.json'), content)
    const notice = await readFile(new URL('../scripts/pyav-source-bundle/SOURCE-NOTICES.txt', import.meta.url))
    await mkdir(join(root, 'licenses'))
    await writeFile(join(root, 'licenses', 'PYAV-SOURCE-NOTICES.txt'), notice)
    await mkdir(join(root, 'fonts'))
    await writeFile(join(root, 'fonts', releaseLock.font.filename), fontBytes)
    const files = [
      { path: `fonts/${releaseLock.font.filename}`, bytes: fontBytes.length, sha256: releaseLock.font.sha256 },
      { path: 'licenses/PYAV-SOURCE-NOTICES.txt', bytes: notice.length, sha256: createHash('sha256').update(notice).digest('hex') },
      { path: 'resources.lock.json', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') },
    ]
    await writeFile(join(root, 'media-runtime.json'), JSON.stringify({ version: 1, files }))
    await expect(verifyPreparedMediaRuntime(root, releaseLock)).resolves.toBeUndefined()
    await expect(verifyPreparedMediaRuntime(root, { ...releaseLock, pythonVersion: '3.13.0' })).rejects.toThrow(/input lock changed/)
    await writeFile(join(root, 'extra.py'), 'unreviewed')
    await expect(verifyPreparedMediaRuntime(root, releaseLock)).rejects.toThrow(/inventory/)
    expect(await readFile(join(root, 'extra.py'), 'utf8')).toBe('unreviewed')
    await rm(join(root, 'extra.py'))
    await writeFile(join(root, 'fonts', releaseLock.font.filename), 'modified')
    await expect(verifyPreparedMediaRuntime(root, releaseLock)).rejects.toThrow(/CJK font.*fresh output/)
    await rm(join(root, 'fonts', releaseLock.font.filename))
    await expect(verifyPreparedMediaRuntime(root, releaseLock)).rejects.toThrow(/CJK font.*fresh output/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([undefined, 'outdated notice'])('refuses absent or modified PyAV notices despite a matching inventory: %s', async (notice) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-notice-'))
  try {
    const content = JSON.stringify(releaseLock)
    await writeFile(join(root, 'resources.lock.json'), content)
    const files = [{ path: 'resources.lock.json', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }]
    if (notice !== undefined) {
      await mkdir(join(root, 'licenses'))
      await writeFile(join(root, 'licenses', 'PYAV-SOURCE-NOTICES.txt'), notice)
      files.unshift({ path: 'licenses/PYAV-SOURCE-NOTICES.txt', bytes: Buffer.byteLength(notice), sha256: createHash('sha256').update(notice).digest('hex') })
    }
    await writeFile(join(root, 'media-runtime.json'), JSON.stringify({ version: 1, files }))
    await expect(verifyPreparedMediaRuntime(root, releaseLock)).rejects.toThrow(/PyAV source notice.*fresh output/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses incomplete existing media instead of deleting or silently rebuilding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-existing-'))
  try {
    await writeFile(join(root, 'keep.txt'), 'user data')
    await expect(verifyPreparedMediaRuntime(root, releaseLock)).rejects.toThrow()
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('user data')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('verifies cached bytes rather than trusting a filename or declared size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-hash-'))
  try {
    const path = join(root, 'payload')
    await writeFile(path, 'payload')
    const resource = { filename: 'payload', url: 'https://example.com/payload', bytes: 7, sha256: createHash('sha256').update('payload').digest('hex') }
    await expect(verifyMediaResource(path, resource)).resolves.toBeUndefined()
    await writeFile(path, 'changed')
    await expect(verifyMediaResource(path, resource)).rejects.toThrow(/checksum/)
    expect(await readFile(path, 'utf8')).toBe('changed')
    await expect(verifyMediaResource(path, { ...resource, bytes: 8 })).rejects.toThrow(/size/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
