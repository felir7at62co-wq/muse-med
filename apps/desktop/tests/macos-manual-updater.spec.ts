/** Manual DMG downloads retain release identity and distinct user installation authorization. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadExecutorTask, DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import type { ResolvedUpdateFileInfo } from 'electron-updater'
import { createMacOSManualUpdater, readMacOSManualUpdateAppId, selectMacOSUpdateDiskImage } from '../src/macos-manual-updater.ts'

const f = vi.hoisted(() => ({ path: '', quit: vi.fn(), open: vi.fn(async () => ''), verify: vi.fn(async () => undefined), clear: vi.fn(async () => undefined),
  options: undefined as DownloadUpdateOptions | undefined, requests: [] as string[], bytes: Buffer.from('verified disk image') }))
vi.mock('electron', () => ({ shell: { openPath: f.open } }))
vi.mock('../src/macos-update-package.ts', async load => ({ ...await load<typeof import('../src/macos-update-package.ts')>(), verifyMacOSUpdatePackage: f.verify }))
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeAppUpdater extends EventEmitter {
    app = { quit: f.quit }
    downloadedUpdateHelper = { clear: f.clear }
    httpExecutor = { download: async (url: URL, path: string) => { f.requests.push(url.href); await writeFile(path, f.bytes) } }
    async downloadUpdate(): Promise<string[]> {
      if (f.options === undefined) throw new Error('fixture has no release')
      return this.doDownloadUpdate(f.options)
    }
    async doDownloadUpdate(_options: DownloadUpdateOptions): Promise<string[]> { throw new Error('fixture must override download') }
    async executeDownload(task: DownloadExecutorTask): Promise<string[]> {
      await task.task(f.path, { headers: {}, cancellationToken: task.downloadUpdateOptions.cancellationToken }, null, async () => undefined)
      await task.done?.({ ...task.downloadUpdateOptions.updateInfoAndProvider.info, downloadedFile: f.path })
      return [f.path]
    }
    dispatchUpdateDownloaded(event: unknown): void { this.emit('update-downloaded', event) }
  }
  return { default: { AppUpdater: FakeAppUpdater } }
})

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'muse-manual-update-test-'))
  roots.push(path)
  return path
}
function file(name: string, body = f.bytes): ResolvedUpdateFileInfo {
  return { url: new URL(`https://muse.example.com/${name}`), info: { url: name, sha512: createHash('sha512').update(body).digest('base64'), size: body.length } }
}
beforeEach(() => { vi.clearAllMocks(); f.requests = []; f.verify.mockResolvedValue(undefined); f.open.mockResolvedValue('') })
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('sealed manual macOS update mode', () => {
  it('retains native updater validation when the installed application has no manual marker', async () => {
    expect(readMacOSManualUpdateAppId(join(await root(), 'missing.json'), '1.0.4')).toBeUndefined()
  })
  it.each([null, {}, { schemaVersion: 1, version: '1.0.2', appId: 'cn.muse.med', installationMode: 'manual-dmg' },
    { schemaVersion: 1, version: '1.0.4', appId: 'cn.muse.med', installationMode: 'disable-verification' }])('rejects unrecognized or mismatched marker %j', async (value) => {
    const path = join(await root(), 'mode.json')
    await writeFile(path, JSON.stringify(value))
    expect(() => readMacOSManualUpdateAppId(path, '1.0.4')).toThrow('mode is invalid')
  })
  it('reads only the installed version’s complete manual marker', async () => {
    const path = join(await root(), 'mode.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, version: '1.0.4', appId: 'cn.muse.med', installationMode: 'manual-dmg' }))
    expect(readMacOSManualUpdateAppId(path, '1.0.4')).toBe('cn.muse.med')
  })
  it('selects the exact same-architecture product DMG and requires complete HTTPS hash metadata', () => {
    const arm = file('muse-med-1.0.4-mac-arm64.dmg')
    const intel = file('muse-med-1.0.4-mac-x64.dmg')
    expect(selectMacOSUpdateDiskImage([intel, arm, file('muse-med-1.0.4-mac-arm64.zip')], '1.0.4', 'arm64')).toEqual(arm)
    for (const files of [[intel], [arm, arm], [{ ...arm, info: { ...arm.info, sha512: 'invalid' } }],
      [{ ...arm, info: { ...arm.info, size: 0 } }], [{ ...arm, url: new URL(arm.url.href.replace('https:', 'http:')) }]]) {
      expect(() => selectMacOSUpdateDiskImage(files, '1.0.4', 'arm64')).toThrow('macOS update')
    }
  })
})

describe('user-authorized manual updater', () => {
  async function updater() {
    f.path = join(await root(), 'update.dmg')
    const info = file(`muse-med-1.0.4-mac-${process.arch}.dmg`)
    const { CancellationToken, Provider } = await vi.importActual<typeof import('electron-updater')>('electron-updater')
    class Feed extends Provider<import('electron-updater').UpdateInfo> {
      constructor() { super({ platform: 'darwin', executor: null!, isUseMultipleRangeRequest: false }) }
      async getLatestVersion() {
        return { version: '1.0.4', files: [info.info], path: info.info.url, sha512: info.info.sha512,
          releaseDate: '2026-10-07T00:00:00.000Z' }
      }
      resolveFiles() { return [info] }
    }
    f.options = { updateInfoAndProvider: { info: await new Feed().getLatestVersion(), provider: new Feed() },
      requestHeaders: {}, cancellationToken: new CancellationToken() }
    return createMacOSManualUpdater('cn.muse.med')
  }
  it('opens no installer on download; verifies and opens the exact file only on installation authorization', async () => {
    const u = await updater()
    const events: unknown[] = []
    u.on('update-downloaded', (event) => { events.push(event) })
    await u.downloadUpdate()
    expect(u.installationMode).toBe('manual-dmg')
    expect(events).toHaveLength(1)
    expect(f.verify).toHaveBeenCalledWith(expect.objectContaining({ path: f.path, appId: 'cn.muse.med', version: '1.0.4' }))
    expect(f.open).not.toHaveBeenCalled()
    expect(f.quit).not.toHaveBeenCalled()
    await u.verifyPreparedUpdate()
    await u.openPreparedInstaller()
    expect(f.open).toHaveBeenCalledWith(f.path)
    expect(f.quit).toHaveBeenCalledOnce()
    expect(f.requests).toEqual([`https://muse.example.com/muse-med-1.0.4-mac-${process.arch}.dmg`])
  })
  it('rejects changed cached bytes before opening and retains the running application', async () => {
    const u = await updater()
    await u.downloadUpdate()
    await writeFile(f.path, Buffer.alloc(f.bytes.length))
    await expect(u.verifyPreparedUpdate()).rejects.toThrow('SHA-512')
    await expect(u.openPreparedInstaller()).rejects.toThrow('no verified disk image')
    expect(f.open).not.toHaveBeenCalled()
    expect(f.quit).not.toHaveBeenCalled()
  })
  it('clears invalid application packages without reporting readiness', async () => {
    const u = await updater()
    const ready = vi.fn()
    u.on('update-downloaded', ready)
    f.verify.mockRejectedValue(new Error('invalid signature'))
    await expect(u.downloadUpdate()).rejects.toThrow('invalid signature')
    expect(f.clear).toHaveBeenCalledOnce()
    expect(ready).not.toHaveBeenCalled()
    await expect(u.verifyPreparedUpdate()).rejects.toThrow('no verified disk image')
  })
  it('propagates installer-open failure without quitting', async () => {
    const u = await updater()
    await u.downloadUpdate()
    f.open.mockResolvedValue('disk image open failed')
    await expect(u.openPreparedInstaller()).rejects.toThrow('disk image open failed')
    expect(f.quit).not.toHaveBeenCalled()
  })
})
