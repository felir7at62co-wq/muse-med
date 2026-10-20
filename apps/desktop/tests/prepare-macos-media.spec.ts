import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { macMediaConfigureArguments, macMediaRecipeIdentity, requireMacMediaCapabilities, validateMacMediaLock } from '../scripts/prepare-macos-media.ts'
import * as subtitles from '../scripts/macos-subtitle-libraries.ts'

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
  expect(() => validateMacMediaLock({ ...lock, notices: [] })).toThrow('invalid notices')
  expect(() => validateMacMediaLock({ ...lock, notices: [lock.notices[0], lock.notices[0], lock.notices[0]] })).toThrow('invalid notices')
})
it.each(['arm64', 'x64'] as const)('builds %s subtitle and H264 executables without nonfree or host discovery', (arch) => {
  const args = macMediaConfigureArguments(arch)
  expect(args).toContain('--disable-autodetect')
  expect(args).toContain('--enable-zlib')
  expect(args).toContain('--enable-gpl')
  for (const library of ['libass', 'libfreetype', 'libharfbuzz', 'libfribidi', 'libx264']) expect(args).toContain(`--enable-${library}`)
  expect(args).toContain('--pkg-config=pkgconf')
  expect(args).toContain('--pkg-config-flags=--static')
  expect(args).toContain('--disable-nonfree')
  expect(args).toContain('--disable-version3')
  expect(args).toContain(arch === 'arm64' ? '--arch=arm64' : '--arch=x86_64')
})

it('reuses cached media only while source, architecture, options and both executables match', async (test) => {
  const verify = vi.spyOn(subtitles, 'verifyMacSubtitleSources').mockResolvedValue()
  test.onTestFinished(() => { verify.mockRestore() })
  const { createHash } = await import('node:crypto')
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const paths = await import('node:path')
  const { reusableMacMedia } = await import('../scripts/prepare-macos-media.ts')
  const directory = await mkdtemp(paths.join(os.tmpdir(), 'muse-mac-media-cache-'))
  test.onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('locked source')
  const sha = (input: Buffer) => createHash('sha256').update(input).digest('hex')
  const lock = validateMacMediaLock(structuredClone(source))
  lock.source = { ...lock.source, bytes: bytes.length, sha256: sha(bytes) }
  await mkdir(paths.join(directory, 'sources'), { recursive: true })
  await mkdir(paths.join(directory, 'notices'), { recursive: true })
  lock.notices = lock.notices.map(notice => ({ ...notice, bytes: bytes.length, sha256: sha(bytes) }))
  for (const notice of lock.notices) await writeFile(paths.join(directory, 'notices', notice.filename), bytes)
  await mkdir(paths.join(directory, 'ffmpeg', 'bin'), { recursive: true })
  await writeFile(paths.join(directory, 'sources', lock.source.filename), bytes)
  const binaries = ['ffmpeg', 'ffprobe'].map(name => ({ name, sha256: sha(Buffer.from(name)) }))
  for (const binary of binaries) await writeFile(paths.join(directory, 'ffmpeg', 'bin', binary.name), binary.name)
  const manifest = { arch: 'arm64', source: lock.source, configure: macMediaConfigureArguments('arm64'), binaries,
    recipeIdentity: macMediaRecipeIdentity('arm64') }
  await mkdir(paths.join(directory, 'sources', 'recipe'), { recursive: true })
  for (const name of ['prepare-macos-media.ts', 'macos-subtitle-libraries.ts', 'media-resources.ts',
    'macos-media-lock.json', 'macos-subtitle-lock.json']) {
    await writeFile(paths.join(directory, 'sources', 'recipe', name), readFileSync(new URL(`../scripts/${name}`, import.meta.url)))
  }
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify(manifest))
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(true)
  expect(await reusableMacMedia(directory, lock, 'x64')).toBe(false)
  await writeFile(paths.join(directory, 'notices', 'COPYING.GPLv2'), 'changed license')
  await expect(reusableMacMedia(directory, lock, 'arm64')).rejects.toThrow()
  await writeFile(paths.join(directory, 'notices', 'COPYING.GPLv2'), bytes)
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify({ ...manifest, recipeIdentity: 'old recipe' }))
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(false)
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify(manifest))
  verify.mockRejectedValueOnce(new Error('changed dependency source'))
  await expect(reusableMacMedia(directory, lock, 'arm64')).rejects.toThrow('changed dependency source')
  await writeFile(paths.join(directory, 'ffmpeg', 'bin', 'ffprobe'), 'modified executable')
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(false)
  await writeFile(paths.join(directory, 'ffmpeg', 'bin', 'ffprobe'), 'ffprobe')
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify({ ...manifest, binaries: [binaries[0], binaries[0]] }))
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(false)
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify({ ...manifest, configure: [] }))
  expect(await reusableMacMedia(directory, lock, 'arm64')).toBe(false)
  await writeFile(paths.join(directory, 'macos-media.json'), JSON.stringify(manifest))
  await writeFile(paths.join(directory, 'sources', 'recipe', 'prepare-macos-media.ts'), 'changed recipe')
  await expect(reusableMacMedia(directory, lock, 'arm64')).rejects.toThrow('retained build recipe differs')
})

const version = 'ffmpeg version 9.0.2\nconfiguration: --enable-gpl --enable-libass --enable-libx264'
const filters = ' ... ass V->V\n ... subtitles V->V\n ... drawtext V->V\n ... loudnorm A->A\n'
const encoders = ' V....D libx264 H264\n A....D aac AAC\n'

it('requires executable subtitle and H264/AAC capabilities rather than configure flags alone', () => {
  expect(() => { requireMacMediaCapabilities(version, filters, encoders) }).not.toThrow()
  for (const filter of ['ass', 'subtitles', 'drawtext', 'loudnorm']) {
    const partial = filters.split('\n').filter(line => line.trim().split(/\s+/u)[1] !== filter).join('\n')
    expect(() => { requireMacMediaCapabilities(version, partial, encoders) }).toThrow(`missing required ${filter} filter`)
  }
  for (const encoder of ['libx264', 'aac']) {
    const partial = encoders.split('\n').filter(line => line.trim().split(/\s+/u)[1] !== encoder).join('\n')
    expect(() => { requireMacMediaCapabilities(version, filters, partial) }).toThrow(`missing required ${encoder} encoder`)
  }
  expect(() => { requireMacMediaCapabilities(version, filters.replace('ass V->V', 'allpass A->A'), encoders) }).toThrow('missing required ass')
  expect(() => { requireMacMediaCapabilities(`${version} --enable-nonfree`, filters, encoders) }).toThrow('licensing configuration')
  expect(() => { requireMacMediaCapabilities(`${version} --enable-version3`, filters, encoders) }).toThrow('licensing configuration')
  expect(() => { requireMacMediaCapabilities(version.replace('--enable-gpl', '--disable-gpl'), filters, encoders) }).toThrow('licensing configuration')
})
