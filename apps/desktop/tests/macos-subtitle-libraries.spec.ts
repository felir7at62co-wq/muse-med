import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { SpawnOptions } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { macSubtitleBuildIdentity, obtainMacSubtitleSource, validateMacSubtitleLock, verifyMacSubtitleSources } from '../scripts/macos-subtitle-libraries.ts'

const transport = vi.hoisted(() => ({ primaryFailure: '', mirrorFailure: '', archive: 'locked x264 fixture', calls: [] as string[] }))
vi.mock('node:child_process', async (load) => {
  const actual = await load<typeof import('node:child_process')>()
  return { ...actual, spawn: (binary: string, args: string[], options: SpawnOptions) => {
    if (binary !== '/usr/bin/git') throw new Error(`Unexpected source-test command ${binary}`)
    transport.calls.push(args.join(' '))
    const fetch = args.indexOf('fetch')
    let script = ''
    if (fetch !== -1) {
      const failure = args.some(value => value.includes('code.videolan.org')) ? transport.primaryFailure : transport.mirrorFailure
      script = failure ? `process.stderr.write(${JSON.stringify(failure)}); process.exit(128)` : ''
    } else if (args.includes('archive')) {
      const output = args.find(value => value.startsWith('--output='))!.slice('--output='.length)
      script = `require('node:fs').writeFileSync(${JSON.stringify(output)}, ${JSON.stringify(transport.archive)})`
    }
    return actual.spawn(process.execPath, ['-e', script], options)
  } }
})
afterEach(() => {
  transport.primaryFailure = ''; transport.mirrorFailure = ''; transport.archive = 'locked x264 fixture'; transport.calls.length = 0
})

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

it('permits only the declared GitHub x264 mirror and no archive mirrors', () => {
  const lock = validateMacSubtitleLock(raw)
  const x264 = lock.libraries.find(library => library.name === 'x264')!
  expect(x264.mirrors).toEqual(['https://github.com/mirror/x264.git'])
  for (const mirrors of [undefined, [], ['https://example.com/x264.git'], ['https://github.com/mirror/x264.git', 'https://example.com']]) {
    const changed = structuredClone(lock)
    Object.assign(changed.libraries.find(library => library.name === 'x264')!, { mirrors })
    expect(() => validateMacSubtitleLock(changed)).toThrow('invalid x264 mirror')
  }
  const changed = structuredClone(lock)
  changed.libraries[0]!.mirrors = ['https://github.com/mirror/x264.git']
  expect(() => validateMacSubtitleLock(changed)).toThrow('invalid official archive')
})

async function sourceFixture() {
  const cache = await mkdtemp(join(tmpdir(), 'mac-subtitle-source-'))
  onTestFinished(async () => { await rm(cache, { recursive: true, force: true }) })
  const library = structuredClone(validateMacSubtitleLock(raw).libraries.find(item => item.name === 'x264')!)
  library.source.bytes = Buffer.byteLength(transport.archive)
  library.source.sha256 = createHash('sha256').update(transport.archive).digest('hex')
  return { cache, library, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }
}

it('uses the primary source alone when it succeeds and reuses only verified cached bytes', async () => {
  const f = await sourceFixture()
  const path = await obtainMacSubtitleSource(f.library, f.cache, f.env)
  expect(await readFile(path, 'utf8')).toBe(transport.archive)
  expect(transport.calls.filter(call => call.includes(' fetch '))).toHaveLength(1)
  expect(transport.calls.join('\n')).not.toContain('github.com')
  const count = transport.calls.length
  expect(await obtainMacSubtitleSource(f.library, f.cache, f.env)).toBe(path)
  expect(transport.calls).toHaveLength(count)
  await writeFile(path, 'changed cached archive')
  await expect(obtainMacSubtitleSource(f.library, f.cache, f.env)).rejects.toThrow()
  expect(transport.calls).toHaveLength(count)
})

it.each(['Could not resolve host: code.videolan.org', 'Failed to connect to code.videolan.org port 443',
  'OpenSSL SSL_connect: SSL_ERROR_SYSCALL', 'The requested URL returned error: 503'])(
  'uses the declared mirror after primary network failure: %s', async (failure) => {
    const f = await sourceFixture()
    transport.primaryFailure = failure
    const path = await obtainMacSubtitleSource(f.library, f.cache, f.env)
    expect(await readFile(path, 'utf8')).toBe(transport.archive)
    const fetches = transport.calls.filter(call => call.includes(' fetch '))
    expect(fetches).toHaveLength(2)
    expect(fetches[0]).toContain(f.library.source.url)
    expect(fetches[1]).toContain('https://github.com/mirror/x264.git')
    expect(fetches.every(call => call.endsWith(f.library.release))).toBe(true)
    expect(await readdir(f.cache)).toEqual([f.library.source.filename])
  },
)

it.each(['fatal: could not read Username', 'fatal: remote error: upload-pack: not our ref',
  'fatal: repository not found', 'The requested URL returned error: 403'])(
  'does not mask a primary non-network failure: %s', async (failure) => {
    const f = await sourceFixture()
    transport.primaryFailure = failure
    await expect(obtainMacSubtitleSource(f.library, f.cache, f.env)).rejects.toThrow('git source fetch failed')
    expect(transport.calls.filter(call => call.includes(' fetch '))).toHaveLength(1)
    expect(await readdir(f.cache)).toEqual([])
  },
)

it('rejects mirror fetch failures and altered mirror bytes without publishing a cache entry', async () => {
  const f = await sourceFixture()
  transport.primaryFailure = 'Could not resolve host: code.videolan.org'
  transport.mirrorFailure = 'Could not resolve host: github.com'
  await expect(obtainMacSubtitleSource(f.library, f.cache, f.env)).rejects.toThrow('git source fetch failed')
  expect(await readdir(f.cache)).toEqual([])
  transport.mirrorFailure = ''
  transport.archive = 'x'.repeat(f.library.source.bytes)
  await expect(obtainMacSubtitleSource(f.library, f.cache, f.env)).rejects.toThrow('checksum')
  expect(await readdir(f.cache)).toEqual([])
})

it('does not fall back when primary fetch succeeds but its archived bytes differ', async () => {
  const f = await sourceFixture()
  transport.archive = 'x'.repeat(f.library.source.bytes)
  await expect(obtainMacSubtitleSource(f.library, f.cache, f.env)).rejects.toThrow('checksum')
  expect(transport.calls.filter(call => call.includes(' fetch '))).toHaveLength(1)
  expect(transport.calls.join('\n')).not.toContain('github.com')
  expect(await readdir(f.cache)).toEqual([])
})
