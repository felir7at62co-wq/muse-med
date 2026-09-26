import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DEFAULT_MUSE_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  MUSE_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultDshHome,
  defaultMuseHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  resolveDshHome,
  resolveMuseHome,
} from '@deepseek-ai/dsh-home-paths'

/** Operating-system homes created by {@link stubOsHome}, removed after each test. */
const tempHomes: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true })
})

/**
 * Point `homedir()` at a temp directory whose legacy `.dsh` and muse `.muse`
 * default homes exist only when the case asks for them. POSIX reads `HOME`
 * and Windows reads `USERPROFILE`, so both are stubbed.
 * @param defaults - which default home directories to create inside the temp home.
 * @returns the temp operating-system home now reported by `homedir()`.
 */
async function stubOsHome(defaults: { legacy?: boolean; muse?: boolean } = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-os-home-'))
  tempHomes.push(home)
  if (defaults.legacy === true) await mkdir(join(home, DSH_HOME_DIR_NAME))
  if (defaults.muse === true) await mkdir(join(home, MUSE_HOME_DIR_NAME))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  return home
}

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.dsh')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('owns the shared default muse home directory name', () => {
    expect(MUSE_HOME_DIR_NAME).toBe('.muse')
    expect(DEFAULT_MUSE_HOME_DISPLAY).toBe('~/.muse')
    expect(defaultMuseHome()).toBe(join(homedir(), '.muse'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before MUSE_HOME, DSH_HOME, and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { MUSE_HOME: '~/env-muse', DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
  })

  it('lets MUSE_HOME win over DSH_HOME when both are set', () => {
    expect(resolveDshHome(undefined, { MUSE_HOME: '~/env-muse', DSH_HOME: '~/env-dsh' }))
      .toBe(join(homedir(), 'env-muse'))
  })

  it('treats an empty or whitespace-only override as unset', async () => {
    const home = await stubOsHome({ legacy: true })
    expect(resolveDshHome(undefined, { DSH_HOME: '' })).toBe(join(home, DSH_HOME_DIR_NAME))
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(join(home, DSH_HOME_DIR_NAME))
    expect(resolveDshHome(undefined, { MUSE_HOME: '', DSH_HOME: '~/env-dsh' })).toBe(join(homedir(), 'env-dsh'))
    expect(resolveDshHome(undefined, { MUSE_HOME: '   ', DSH_HOME: '~/env-dsh' })).toBe(join(homedir(), 'env-dsh'))
  })

  it('normalizes relative MUSE_HOME and DSH_HOME values the same way', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: './relative-dsh' })).toBe(resolve('./relative-dsh'))
    expect(resolveDshHome(undefined, { MUSE_HOME: './relative-muse' })).toBe(resolve('./relative-muse'))
  })

  it('keeps an existing legacy default home when no override is set', async () => {
    const home = await stubOsHome({ legacy: true })

    expect(resolveDshHome(undefined, {})).toBe(join(home, DSH_HOME_DIR_NAME))
  })

  it('selects the muse default on a machine with no legacy home', async () => {
    const home = await stubOsHome()

    expect(resolveDshHome(undefined, {})).toBe(join(home, MUSE_HOME_DIR_NAME))
  })

  it('keeps the legacy default when a muse home exists beside it', async () => {
    const home = await stubOsHome({ legacy: true, muse: true })

    expect(resolveDshHome(undefined, {})).toBe(join(home, DSH_HOME_DIR_NAME))
  })

  it('resolves the muse home independently of the legacy default', async () => {
    const home = await stubOsHome({ legacy: true })

    expect(resolveMuseHome()).toBe(join(home, MUSE_HOME_DIR_NAME))
    expect(resolveMuseHome(undefined, { MUSE_HOME: '~/env-muse' })).toBe(join(homedir(), 'env-muse'))
    expect(resolveMuseHome('/tmp/explicit-muse', { MUSE_HOME: '~/env-muse' })).toBe(resolve('/tmp/explicit-muse'))
    expect(resolveMuseHome(undefined, { MUSE_HOME: '  ' })).toBe(join(home, MUSE_HOME_DIR_NAME))
  })

  it('labels the resolved muse default home as ~/.muse', async () => {
    const home = await stubOsHome()

    expect(dshHomeDisplay(resolve(defaultMuseHome()))).toBe('~/.muse')
    expect(dshHomeDisplay(resolveDshHome(undefined, {}))).toBe('~/.muse')
    expect(dshHomeDisplay(join(home, 'elsewhere'))).toBe('$DSH_HOME')
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.dsh')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it.each([
    ['~/env-dsh', join(homedir(), 'env-dsh')],
    ['./relative-dsh', resolve('./relative-dsh')],
  ] as const)('resolves cache paths with DSH_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([undefined, '', '   '] as const)('resolves cache paths with blank DSH_HOME=%j to the legacy default home', async (home) => {
    const osHome = await stubOsHome({ legacy: true })
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(osHome, DSH_HOME_DIR_NAME, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(osHome, DSH_HOME_DIR_NAME, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-dsh' })).toBe(join(homedir(), 'explicit-dsh', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-dsh' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-dsh/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-dsh', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
