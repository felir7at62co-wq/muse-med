import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { macMediaConfigureArguments, validateMacMediaLock } from '../scripts/prepare-macos-media.ts'

const source: unknown = JSON.parse(readFileSync(new URL('../scripts/macos-media-lock.json', import.meta.url), 'utf8'))
it('requires the official version, bounded source and exact source hash', () => {
  const lock = validateMacMediaLock(source)
  for (const change of [{ filename: '../ffmpeg' }, { bytes: 0 }, { sha256: 'invalid' }, { url: 'https://example.com/ffmpeg' }]) {
    const invalid = structuredClone(lock)
    Object.assign(invalid.source, change)
    expect(() => validateMacMediaLock(invalid)).toThrow('invalid resource')
  }
  expect(() => validateMacMediaLock({ ...lock, source: undefined })).toThrow('invalid resource')
  expect(() => validateMacMediaLock({ ...lock, version: 2 })).toThrow('invalid release')
})
it.each(['arm64', 'x64'] as const)('builds standalone %s executables without GPL, nonfree or host dependencies', (arch) => {
  const args = macMediaConfigureArguments(arch)
  expect(args).toContain('--disable-autodetect')
  expect(args).toContain('--disable-gpl')
  expect(args).toContain('--disable-nonfree')
  expect(args).toContain(arch === 'arm64' ? '--arch=arm64' : '--arch=x86_64')
})

it('reuses cached media only while source, architecture, options and both executables match', async (test) => {
  const { createHash } = await import('node:crypto')
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const paths = await import('node:path')
  const { reusableMacMedia } = await import('../scripts/prepare-macos-media.ts')
  const directory = await mkdtemp(paths.join(os.tmpdir(), 'muse-mac-media-cache-'))
  test.onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('locked source')
  const sha = (input: Buffer) => createHash('sha256').update(input).digest('hex')
  const lock = validateMacMediaLock(source)
  lock.source = { ...lock.source, bytes: bytes.length, sha256: sha(bytes) }
  await mkdir(paths.join(directory, 'sources'), { recursive: true })
  await mkdir(paths.join(directory, 'ffmpeg', 'bin'), { recursive: true })
  await writeFile(paths.join(directory, 'sources', lock.source.filename), bytes)
  const binaries = ['ffmpeg', 'ffprobe'].map(name => ({ name, sha256: sha(Buffer.from(name)) }))
  for (const binary of binaries) await writeFile(paths.join(directory, 'ffmpeg', 'bin', binary.name), binary.name)
  const manifest = { arch: 'arm64', source: lock.source, configure: macMediaConfigureArguments('arm64'), binaries }
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify(manifest))
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(true)
  expect(await reusableMacMedia(directory, lock, 'x64')).toBe(false)
  await writeFile(paths.join(directory, 'ffmpeg', 'bin', 'ffprobe'), 'modified executable')
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(false)
  await writeFile(paths.join(directory, 'ffmpeg', 'bin', 'ffprobe'), 'ffprobe')
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify({ ...manifest, binaries: [binaries[0], binaries[0]] }))
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(false)
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify({ ...manifest, configure: [] }))
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(false)
})
