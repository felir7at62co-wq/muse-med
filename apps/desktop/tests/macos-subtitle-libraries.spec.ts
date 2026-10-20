import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { macSubtitleBuildIdentity, validateMacSubtitleLock, verifyMacSubtitleSources } from '../scripts/macos-subtitle-libraries.ts'

const raw: unknown = JSON.parse(readFileSync(new URL('../scripts/macos-subtitle-lock.json', import.meta.url), 'utf8'))

it('locks official text rendering sources and x264 with bounded hashes and license notices', () => {
  const lock = validateMacSubtitleLock(raw)
  expect(lock.libraries.map(library => library.name).sort()).toEqual(['freetype', 'fribidi', 'harfbuzz', 'libass', 'pkgconf', 'x264'])
  expect(lock.libraries.every(library => library.notices.length > 0)).toBe(true)
  for (const name of ['libass', 'freetype', 'harfbuzz', 'fribidi', 'pkgconf', 'x264']) {
    for (const change of [{ bytes: 0 }, { bytes: 41 * 1024 ** 2 }, { sha256: 'invalid' }, { url: 'https://example.com/source' }, { filename: '../source' }]) {
      const invalid = structuredClone(lock)
      Object.assign(invalid.libraries.find(library => library.name === name)!.source, change)
      expect(() => validateMacSubtitleLock(invalid)).toThrow()
    }
  }
})

it('rejects repeated libraries, missing notices and escaping license paths', () => {
  const lock = validateMacSubtitleLock(raw)
  expect(() => validateMacSubtitleLock(null)).toThrow('invalid lock')
  expect(() => validateMacSubtitleLock({ ...lock, version: 2 })).toThrow('invalid lock version')
  expect(() => validateMacSubtitleLock({ ...lock, libraries: [] })).toThrow('invalid lock version')
  const duplicate = structuredClone(lock)
  duplicate.libraries[1] = duplicate.libraries[0]!
  expect(() => validateMacSubtitleLock(duplicate)).toThrow('invalid library')
  for (const change of [{ path: '../COPYING' }, { name: '../COPYING' }, { bytes: -1 }, { sha256: 'invalid' }]) {
    const invalid = structuredClone(lock)
    Object.assign(invalid.libraries[0]!.notices[0]!, change)
    expect(() => validateMacSubtitleLock(invalid)).toThrow('invalid notice')
  }
  const missing = structuredClone(lock)
  missing.libraries[0]!.notices = []
  expect(() => validateMacSubtitleLock(missing)).toThrow('missing notices')
})

it('identifies architecture and complete recipe without staging paths', () => {
  const arm = macSubtitleBuildIdentity('arm64')
  expect(macSubtitleBuildIdentity('arm64')).toEqual(arm)
  expect(macSubtitleBuildIdentity('x64')).not.toEqual(arm)
  expect(JSON.stringify(arm)).not.toContain(process.cwd())
  expect(JSON.stringify(arm)).toMatch(/"recipeSha256":"[a-f0-9]{64}"/u)
})

it('refuses a cached payload without its matching dependency sources', async (test) => {
  const directory = await mkdtemp(join(tmpdir(), 'mac-subtitle-inventory-'))
  test.onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  await expect(verifyMacSubtitleSources(directory, 'arm64')).rejects.toThrow()
})
