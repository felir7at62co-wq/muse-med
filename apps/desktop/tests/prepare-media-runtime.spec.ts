import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { assertMediaArchivePath, verifyMediaResource, validateMediaLock, verifyPreparedMediaRuntime, bgmDescriptorSection, REDISTRIBUTION_NOTICE, prepareMediaRuntime } from '../scripts/prepare-media-runtime.ts'
import { validateBgmRuntimeLock } from '../scripts/prepare-bgm-runtime.ts'

type Entry = { path: string; bytes: number; sha256: string }

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const entry = (path: string, value: string | Buffer): Entry => ({ path, bytes: Buffer.byteLength(value), sha256: digest(value) })

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
  font: { filename: 'test.otf', url: 'https://example.com/test.otf', bytes: fontBytes.length, sha256: digest(fontBytes) },
})
const bgmReleaseLock = validateBgmRuntimeLock(JSON.parse(await readFile(new URL('../scripts/bgm-runtime.lock.json', import.meta.url), 'utf8')))

/** Write the metadata a prepared emotion-runtime subtree carries, without its payload files. */
async function writeBgmFixture(root: string): Promise<Entry[]> {
  const directory = join(root, 'bgm')
  await mkdir(directory, { recursive: true })
  const lockText = JSON.stringify(bgmReleaseLock)
  await writeFile(join(directory, 'resources.lock.json'), lockText)
  const payload = JSON.stringify({ version: 1, files: [entry('resources.lock.json', lockText)] })
  await writeFile(join(directory, 'bgm-runtime.json'), payload)
  return ['bgm/resources.lock.json', 'bgm/bgm-runtime.json'].map((path, index) =>
    index === 0 ? entry(path, lockText) : entry(path, payload))
}

/** Write a complete reusable payload: both locks, notices, font, emotion runtime and descriptor. */
async function writeMediaFixture(root: string): Promise<void> {
  const lockText = JSON.stringify(releaseLock)
  await writeFile(join(root, 'resources.lock.json'), lockText)
  const notice = await readFile(new URL('../scripts/pyav-source-bundle/SOURCE-NOTICES.txt', import.meta.url))
  await mkdir(join(root, 'licenses'), { recursive: true })
  await writeFile(join(root, 'licenses', 'PYAV-SOURCE-NOTICES.txt'), notice)
  await mkdir(join(root, 'fonts'), { recursive: true })
  await writeFile(join(root, 'fonts', releaseLock.font.filename), fontBytes)
  const files = [...await writeBgmFixture(root), entry('resources.lock.json', lockText),
    entry(`fonts/${releaseLock.font.filename}`, fontBytes),
    entry('licenses/PYAV-SOURCE-NOTICES.txt', notice)].sort((left, right) => left.path.localeCompare(right.path))
  await writeFile(join(root, 'media-runtime.json'),
    JSON.stringify({ version: 1, bgm: bgmDescriptorSection(bgmReleaseLock), files }))
}

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
    await writeMediaFixture(root)
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).resolves.toBeUndefined()
    await expect(verifyPreparedMediaRuntime(root, { ...releaseLock, pythonVersion: '3.13.0' }, bgmReleaseLock)).rejects.toThrow(/input lock changed/)
    await writeFile(join(root, 'extra.py'), 'unreviewed')
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).rejects.toThrow(/inventory/)
    expect(await readFile(join(root, 'extra.py'), 'utf8')).toBe('unreviewed')
    await rm(join(root, 'extra.py'))
    await writeFile(join(root, 'fonts', releaseLock.font.filename), 'modified')
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).rejects.toThrow(/CJK font.*fresh output/)
    await rm(join(root, 'fonts', releaseLock.font.filename))
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).rejects.toThrow(/CJK font.*fresh output/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a payload whose emotion-runtime descriptor or subtree contradicts the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-bgm-'))
  try {
    await writeMediaFixture(root)
    const descriptor = JSON.parse(await readFile(join(root, 'media-runtime.json'), 'utf8')) as { version: number; bgm: unknown; files: unknown }
    await writeFile(join(root, 'media-runtime.json'),
      JSON.stringify({ ...descriptor, bgm: { ...(descriptor.bgm as object), license: 'MIT' } }))
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).rejects.toThrow(/BGM descriptor changed/)
    // A subtree that lost its own metadata is still caught, because the payload
    // inventory and the emotion-runtime verifier both read the same file set.
    await writeFile(join(root, 'media-runtime.json'), JSON.stringify({ ...descriptor, bgm: bgmDescriptorSection(bgmReleaseLock) }))
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).resolves.toBeUndefined()
    await rm(join(root, 'bgm', 'bgm-runtime.json'))
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).rejects.toThrow(/inventory|bgm reuse/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('requires the emotion-runtime lock before touching the filesystem', async () => {
  await expect(prepareMediaRuntime({ output: join(tmpdir(), 'dsh-media-absent-output'), cache: join(tmpdir(), 'dsh-media-absent-cache'),
    buildPython: 'python', lock: releaseLock, bgmLock: {} as never, bgmCache: join(tmpdir(), 'dsh-bgm-absent-cache') }))
    .rejects.toThrow(/bgm/u)
})

it('states the bundled emotion runtime noncommercial limit in the redistribution notice', () => {
  expect(REDISTRIBUTION_NOTICE).toContain('CC-BY-NC-4.0')
  expect(REDISTRIBUTION_NOTICE).toContain('NONCOMMERCIAL use only')
  expect(REDISTRIBUTION_NOTICE).toContain('no personal Python environment or user cache is copied')
  expect(REDISTRIBUTION_NOTICE).not.toContain('No MERT inference model')
})

it.each([undefined, 'outdated notice'])('refuses absent or modified PyAV notices despite a matching inventory: %s', async (notice) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-notice-'))
  try {
    const lockText = JSON.stringify(releaseLock)
    await writeFile(join(root, 'resources.lock.json'), lockText)
    const files = [entry('resources.lock.json', lockText)]
    if (notice !== undefined) {
      await mkdir(join(root, 'licenses'))
      await writeFile(join(root, 'licenses', 'PYAV-SOURCE-NOTICES.txt'), notice)
      files.unshift(entry('licenses/PYAV-SOURCE-NOTICES.txt', notice))
    }
    await writeFile(join(root, 'media-runtime.json'), JSON.stringify({ version: 1, files }))
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).rejects.toThrow(/PyAV source notice.*fresh output/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses incomplete existing media instead of deleting or silently rebuilding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-existing-'))
  try {
    await writeFile(join(root, 'keep.txt'), 'user data')
    await expect(verifyPreparedMediaRuntime(root, releaseLock, bgmReleaseLock)).rejects.toThrow()
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('user data')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('verifies cached bytes rather than trusting a filename or declared size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-hash-'))
  try {
    const path = join(root, 'payload')
    await writeFile(path, 'payload')
    const resource = { filename: 'payload', url: 'https://example.com/payload', bytes: 7, sha256: digest('payload') }
    await expect(verifyMediaResource(path, resource)).resolves.toBeUndefined()
    await writeFile(path, 'changed')
    await expect(verifyMediaResource(path, resource)).rejects.toThrow(/checksum/)
    expect(await readFile(path, 'utf8')).toBe('changed')
    await expect(verifyMediaResource(path, { ...resource, bytes: 8 })).rejects.toThrow(/size/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
