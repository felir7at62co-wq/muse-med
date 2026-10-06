import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopUpdateIdentity, isDesktopUpdateSourceUnavailable, loadDesktopUpdateSources } from '../src/update-sources.ts'
import { resolveDesktopMuseUpdateSources } from '../scripts/desktop-auto-update-environment.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function record(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'muse-update-sources-'))
  roots.push(root)
  const path = join(root, 'muse-update-sources.json')
  await writeFile(path, JSON.stringify(value))
  return path
}

describe('sealed Muse update sources', () => {
  it.each([['darwin', 'arm64', 'mac-arm64'], ['darwin', 'x64', 'mac-x64'], ['win32', 'x64', 'win-x64']] as const)(
    'loads the published TOS directory and GitHub fallback for %s %s', async (platform, arch, target) => {
      const sources = resolveDesktopMuseUpdateSources('1.0.2', platform, arch)
      expect(sources.primary.url).toBe(`https://muse.tos-cn-beijing.volces.com/releases/feeds/${target}/`)
      expect(sources.primary.channel).toBe('latest')
      expect(loadDesktopUpdateSources(await record(sources), '1.0.2')).toEqual([sources.primary, sources.fallback])
      expect(JSON.stringify(sources)).not.toMatch(/secret|accessKey|credential/iu)
    },
  )

  it('preserves the version-derived prerelease channel on both sources', async () => {
    const sources = resolveDesktopMuseUpdateSources('1.0.2-test.1', 'darwin', 'arm64')
    expect(sources.primary.channel).toBe('test')
    expect(sources.fallback.channel).toBe('test')
    expect(loadDesktopUpdateSources(await record(sources), sources.version)).toEqual([sources.primary, sources.fallback])
  })

  it('retains the configured feed when an older package has no source record', async () => {
    const path = await record(null)
    await rm(path)
    expect(loadDesktopUpdateSources(path, '1.0.1')).toEqual([])
  })

  it.each([
    null, { schemaVersion: 9 },
    { ...resolveDesktopMuseUpdateSources('1.0.2', 'win32', 'x64'), version: '1.0.1' },
    { ...resolveDesktopMuseUpdateSources('1.0.2', 'win32', 'x64'), primary: { provider: 'github' } },
    { ...resolveDesktopMuseUpdateSources('1.0.2', 'win32', 'x64'), fallback: { provider: 'github', channel: 'rc' } },
  ])('rejects invalid packaged record %j', async (value) => {
    const path = await record(value)
    expect(() => loadDesktopUpdateSources(path, '1.0.2')).toThrow()
  })

  it.each(['http://mirror.example.com/', 'https://user:password@mirror.example.com/',
    'https://mirror.example.com/?credential=secret', 'https://mirror.example.com/#fragment', 'https://mirror.example.com/feed'])(
    'rejects non-public feed URL %s', async (url) => {
      const sources = resolveDesktopMuseUpdateSources('1.0.2', 'win32', 'x64')
      const path = await record({ ...sources, primary: { ...sources.primary, url } })
      expect(() => loadDesktopUpdateSources(path, '1.0.2')).toThrow(/public HTTPS directory/u)
    },
  )
})

describe('mirror payload identity and failures', () => {
  const file = { url: 'payload.zip', sha512: Buffer.alloc(64, 1).toString('base64'), size: 42 }
  it('compares payload bytes independently of source URLs and file order', () => {
    const second = { ...file, sha512: Buffer.alloc(64, 2).toString('base64') }
    const original = desktopUpdateIdentity({ version: '1.0.2', files: [file, second] })
    expect(desktopUpdateIdentity({ version: '1.0.2', files: [second, { ...file, url: 'https://mirror.example.com/payload.zip' }] })).toBe(original)
    expect(desktopUpdateIdentity({ version: '1.0.3', files: [file, second] })).not.toBe(original)
  })

  it.each([undefined, [], [{ ...file, sha512: 'invalid' }], [{ ...file, size: 0 }]])('rejects missing or incomplete metadata %j', (files) => {
    expect(() => desktopUpdateIdentity({ version: '1.0.2', ...files === undefined ? {} : { files } })).toThrow()
  })

  it.each(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'])(
    'permits fallback after availability error %s', (code) => {
      expect(isDesktopUpdateSourceUnavailable(Object.assign(new Error('unavailable'), { code }))).toBe(true)
    },
  )
  it.each([403, 404, 408, 429, 500, 503, 599])('permits fallback for HTTP %s', (statusCode) => {
    expect(isDesktopUpdateSourceUnavailable({ statusCode })).toBe(true)
  })
  it.each([null, 'offline', new Error('disk full'), { code: 'ERR_CHECKSUM_MISMATCH' }, { statusCode: 401 }, { statusCode: 600 }])(
    'retains non-availability failure %j', (error) => { expect(isDesktopUpdateSourceUnavailable(error)).toBe(false) },
  )
})
