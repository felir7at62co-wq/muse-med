import { EventEmitter } from 'node:events'
import type { DesktopUpdater } from '../src/update-coordinator.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease } from '../src/release.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import { zh } from '../src/locale.ts'
import type { DesktopUpdateSource } from '../src/update-sources.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({
  default: { autoUpdater: { autoDownload: true, autoInstallOnAppQuit: true } },
}))

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

describe('desktop release metadata', () => {
  it('accepts one exact release identity for Electron and dsh', () => {
    expect(parseDesktopRelease({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })).toEqual({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })
  })

  it('rejects invalid versions and unsupported host protocols', () => {
    const base = {
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    }
    expect(() => parseDesktopRelease({ ...base, version: 'latest' })).toThrow(/invalid desktop release metadata/u)
    expect(() => parseDesktopRelease({ ...base, hostProtocolVersion: 999 })).toThrow(/invalid desktop release metadata/u)
  })
})

type CheckResult = NonNullable<Awaited<ReturnType<DesktopUpdater['checkForUpdates']>>>

const coordinators: InstanceType<typeof DesktopUpdateCoordinator>[] = []
afterEach(() => { for (const item of coordinators.splice(0)) item.dispose() })

function fixture(channel?: string, sources: readonly DesktopUpdateSource[] = [], manual = false) {
  const events = new EventEmitter()
  const checkForUpdates = vi.fn(async (): Promise<CheckResult> => ({
    isUpdateAvailable: true,
    updateInfo: { version: '1.1.0-rc.2' },
  }))
  const downloadUpdate = vi.fn(async () => {
    events.emit('download-progress', { percent: 58 })
    events.emit('download-progress', { percent: 100 })
    events.emit('update-downloaded', { version: '1.1.0-rc.2' })
    return ['verified-package']
  })
  const quitAndInstall = vi.fn()
  const setFeedURL = vi.fn<(source: DesktopUpdateSource) => void>()
  const beforeRestart = vi.fn(async () => true)
  const downloadResult = vi.fn()
  const verifyPreparedUpdate = vi.fn(async () => undefined)
  const openPreparedInstaller = vi.fn(async () => undefined)
  const states: DesktopUpdateState[] = []
  const updater = Object.assign(events, { checkForUpdates, downloadUpdate, quitAndInstall, setFeedURL, channel,
    ...manual ? { installationMode: 'manual-dmg' as const, verifyPreparedUpdate, openPreparedInstaller } : {},
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: false })
  const coordinator = new DesktopUpdateCoordinator(
    (state) => { states.push(state); return state },
    beforeRestart, updater, () => true, () => '1.1.0-alpha.1', downloadResult, sources,
  )
  coordinators.push(coordinator)
  return { coordinator, updater, events, states, checkForUpdates, downloadUpdate, quitAndInstall,
    setFeedURL, beforeRestart, downloadResult, verifyPreparedUpdate, openPreparedInstaller }
}

describe('manual macOS installation authorization', () => {
  it('keeps a verified download ready when the user defers, without opening an installer or stopping tasks', async () => {
    const f = fixture(undefined, [], true)
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    f.beforeRestart.mockResolvedValue(false)
    expect(f.coordinator.installationMode).toBe('manual-dmg')
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    expect(f.verifyPreparedUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })
  it('rejects changed cached bytes before task authorization and permits an explicit retry', async () => {
    const f = fixture(undefined, [], true)
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    f.verifyPreparedUpdate.mockRejectedValueOnce(new Error('SHA-512 mismatch'))
    expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download', message: 'SHA-512 mismatch' })
    expect(f.beforeRestart).not.toHaveBeenCalled()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'ready' })
    expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'installing' })
    expect(f.beforeRestart).toHaveBeenCalledOnce()
  })
  it('propagates an asynchronous installer-open failure through the normal installation recovery state', async () => {
    const f = fixture(undefined, [], true)
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    f.openPreparedInstaller.mockRejectedValueOnce(new Error('open failed'))
    expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'install', message: 'open failed' })
  })
  it('retains native installation mode for publisher-signed and older applications', () => {
    expect(fixture().coordinator.installationMode).toBe('native')
  })
})

const mirrorSources: readonly DesktopUpdateSource[] = [
  { provider: 'generic', url: 'https://mirror.example.com/', channel: 'rc' },
  { provider: 'github', owner: 'example', repo: 'muse', channel: 'rc' },
]
const mirrorInfo = { version: '1.1.0-rc.2', files: [{ url: 'payload.zip', sha512: Buffer.alloc(64, 1).toString('base64'), size: 42 }] }

describe('desktop update mirrors', () => {
  it('checks TOS first and uses GitHub only after an availability failure', async () => {
    const f = fixture(undefined, mirrorSources)
    f.checkForUpdates.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValue({ isUpdateAvailable: true, updateInfo: mirrorInfo })
    expect(await f.coordinator.check()).toMatchObject({ phase: 'available', version: mirrorInfo.version })
    expect(f.setFeedURL.mock.calls.map(call => call[0])).toEqual(mirrorSources)
    await f.coordinator.download(mirrorInfo.version)
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('downloads through the fallback only when version, size and SHA-512 remain identical', async () => {
    const f = fixture(undefined, mirrorSources)
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: mirrorInfo })
    await f.coordinator.check()
    expect(f.setFeedURL).toHaveBeenCalledOnce()
    f.downloadUpdate.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { statusCode: 503 }))
    expect(await f.coordinator.download(mirrorInfo.version)).toMatchObject({ phase: 'ready', version: mirrorInfo.version })
    expect(f.setFeedURL.mock.calls.map(call => call[0])).toEqual(mirrorSources)
    expect(f.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each(['version', 'size', 'sha512'] as const)('rejects fallback changes to %s after download confirmation', async (field) => {
    const f = fixture(undefined, mirrorSources)
    f.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: mirrorInfo })
    await f.coordinator.check()
    const changed = structuredClone(mirrorInfo)
    if (field === 'version') changed.version = '1.2.0'
    else if (field === 'size') changed.files[0]!.size++
    else changed.files[0]!.sha512 = Buffer.alloc(64, 2).toString('base64')
    f.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: changed })
    f.downloadUpdate.mockRejectedValueOnce(Object.assign(new Error('not found'), { statusCode: 404 }))
    const result = await f.coordinator.download(mirrorInfo.version)
    expect(result).toMatchObject({ phase: 'error', failedOperation: 'download' })
    if (result.phase !== 'error') throw new Error('expected a rejected fallback')
    expect(result.message).toContain('fallback payload differs')
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('retains checksum rejection without trying another source', async () => {
    const f = fixture(undefined, mirrorSources)
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: mirrorInfo })
    await f.coordinator.check()
    f.downloadUpdate.mockRejectedValueOnce(Object.assign(new Error('checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' }))
    expect(await f.coordinator.download(mirrorInfo.version)).toMatchObject({ phase: 'error', failedOperation: 'download' })
    expect(f.setFeedURL).toHaveBeenCalledOnce()
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('stops source switching when a pending primary check is disposed', async () => {
    const f = fixture(undefined, mirrorSources)
    const result = Promise.withResolvers<CheckResult>()
    f.checkForUpdates.mockImplementationOnce(() => result.promise)
    const pending = f.coordinator.check()
    await Promise.resolve()
    f.coordinator.dispose()
    result.reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
    await pending
    expect(f.setFeedURL).toHaveBeenCalledOnce()
    expect(f.states).toEqual([])
  })
})

describe('desktop update coordinator', () => {
  it('keeps safe preparation diagnostics separate and clears them on an explicit retry', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    f.beforeRestart.mockRejectedValueOnce(new DesktopUpdatePreparationError('stop-failed', zh.updateStopFailed, 'exit 0; shutdown acknowledged false'))
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'error', version: '1.1.0-rc.2',
      failedOperation: 'install', preparationFailure: 'stop-failed', message: zh.updateStopFailed,
      technicalDetails: 'exit 0; shutdown acknowledged false' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    f.beforeRestart.mockResolvedValueOnce(false)
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('retains an asynchronous installer failure after quitAndInstall returns', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    await f.coordinator.install('1.1.0-rc.2')
    f.events.emit('error', new Error('installer could not start'))
    expect(f.coordinator.state).toMatchObject({ phase: 'error', failedOperation: 'install', message: 'installer could not start' })
  })

  it('waits for platform preparation after its downloaded event and rejects stale download approval', async () => {
    const f = fixture()
    const prepared = Promise.withResolvers<string[]>()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('update-downloaded', { version: '1.1.0-rc.2' })
      return prepared.promise
    })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0-rc.1')).rejects.toThrow(/stale/u)
    const downloading = f.coordinator.download('1.1.0-rc.2')
    await Promise.resolve()
    await Promise.resolve()
    try {
      expect(f.coordinator.state.phase).not.toBe('ready')
      await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    } finally { prepared.resolve(['verified']); await downloading }
    expect(f.coordinator.state.phase).toBe('ready')
  })

  it('consumes late updater errors until an in-flight check settles after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<CheckResult>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    await Promise.resolve()
    f.coordinator.dispose()
    expect(() => f.events.emit('error', new Error('late network failure'))).not.toThrow()
    checked.reject(new Error('offline'))
    await pending
    await Promise.resolve()
    expect(f.events.listenerCount('error')).toBe(0)
  })

  it('checks, downloads on demand, then requires separate installation approval', async () => {
    const f = fixture()
    await f.coordinator.check()
    expect(f.downloadUpdate).not.toHaveBeenCalled()
    await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    await f.coordinator.download('1.1.0-rc.2')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    expect(f.beforeRestart).not.toHaveBeenCalled()
    expect(f.coordinator.state).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    await f.coordinator.install('1.1.0-rc.2')
    expect(f.beforeRestart).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(f.states.map(state => state.phase)).toEqual([
      'available', 'downloading', 'downloading', 'verifying', 'ready', 'installing',
    ])
    expect(f.updater).toMatchObject({
      autoDownload: false, autoInstallOnAppQuit: false,
      allowPrerelease: true, allowDowngrade: false,
    })
  })

  it('leaves the packaged update channel untouched', () => {
    const f = fixture('rc')
    expect(f.updater.channel).toBe('rc')
  })

  it('joins checks and downloads without retargeting a prepared release', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<CheckResult>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const checking = f.coordinator.check()
    const manual = f.coordinator.check(true)
    const firstDownload = f.coordinator.download('1.1.0-rc.2')
    const secondDownload = f.coordinator.download('1.1.0-rc.2')
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-rc.2' } })
    await Promise.all([checking, manual, firstDownload, secondDownload])
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    await f.coordinator.check(true)
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    await expect(f.coordinator.install('1.2.0')).rejects.toThrow(/not ready/u)
  })

  it('keeps automatic failures silent and exposes a manual caller joining the same check', async () => {
    const f = fixture()
    f.checkForUpdates.mockRejectedValue(new Error('offline'))
    expect(await f.coordinator.check()).toMatchObject({ phase: 'error', failedOperation: 'check' })
    expect(f.states).toEqual([])
    await Promise.all([f.coordinator.check(), f.coordinator.check(true)])
    expect(f.states).toEqual([expect.objectContaining({ phase: 'error', failedOperation: 'check' })])
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it.each(['1.0.0', '1.1.0-alpha.1', 'invalid'])('does not download or install inapplicable version %s', async (version) => {
    const f = fixture()
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version } })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0-rc.2')).rejects.toThrow(/no checked update/u)
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it('retains retry state after download failure and never equates 100 percent with readiness', async () => {
    const f = fixture()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('download-progress', { percent: 100 })
      throw new Error('signature rejected')
    })
    await f.coordinator.check()
    expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
    await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    await f.coordinator.download('1.1.0-rc.2')
    expect(f.coordinator.state.phase).toBe('ready')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('refuses handoff after failed task preparation while retaining the prepared package', async () => {
    const f = fixture()
    f.beforeRestart.mockRejectedValueOnce(new Error('tasks could not stop'))
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'install' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    await f.coordinator.install('1.1.0-rc.2')
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('does not publish late check completion after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<CheckResult>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    f.coordinator.dispose()
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-rc.2' } })
    await pending
    expect(f.states).toEqual([])
    expect(f.events.listenerCount('download-progress')).toBe(0)
  })
})


it('reports one download result when callers share an operation and none for cached readiness', async () => {
  const f = fixture()
  await f.coordinator.check()
  await Promise.all([f.coordinator.download('1.1.0-rc.2'), f.coordinator.download('1.1.0-rc.2')])
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(true)
})


it.each([new DesktopUpdatePreparationError('stop-failed', 'private diagnostic'), new Error('private URL')])('reports safe download failure classification: %s', async (error) => {
  const f = fixture()
  await f.coordinator.check()
  f.downloadUpdate.mockRejectedValueOnce(error)
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(false, error instanceof DesktopUpdatePreparationError ? 'stop-failed' : 'download_failed')
  expect(JSON.stringify(f.downloadResult.mock.calls)).not.toContain('private')
})
