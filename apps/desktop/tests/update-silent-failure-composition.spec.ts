/** The displayed update offer follows the actual coordinator and scheduler. */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopUpdater } from '../src/update-coordinator.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdateSchedule } from '../src/update-schedule.ts'
import { presentDesktopUpdate } from '../src/update-presentation.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))
const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('withdraws a stale offer after a silent check failure and allows a user check and download', async () => {
  const version = '1.1.0-nightly.1'
  const checkForUpdates = vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version } }))
    .mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version } })
    .mockRejectedValueOnce(new Error('feed unavailable'))
    .mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version } })
  const events = new EventEmitter()
  const downloadUpdate = vi.fn(async () => { events.emit('update-downloaded', { version }); return ['verified'] })
  const updater = Object.assign(events, { checkForUpdates, downloadUpdate, quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(), autoDownload: false, autoInstallOnAppQuit: false,
    allowPrerelease: false, allowDowngrade: false }) as DesktopUpdater
  const published: DesktopUpdateState[] = []
  const coordinator = new DesktopUpdateCoordinator((state) => { published.push(state); return state },
    async () => false, updater, () => true, () => '1.0.0')
  const schedule = new DesktopUpdateSchedule(coordinator, { intervalMs: 10_000, maxBackoffMs: 40_000, jitter: 0 }, () => 0.5)
  try {
    await schedule.check()
    expect(presentDesktopUpdate(coordinator.state)).toEqual({ phase: 'available', version })
    expect(await schedule.check(false, true)).toMatchObject({ phase: 'error', failedOperation: 'check' })
    expect(presentDesktopUpdate(coordinator.state)).toEqual({ phase: 'idle' })
    expect(published.at(-1)).toEqual({ phase: 'idle' })
    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(await schedule.check(true)).toEqual({ phase: 'available', version })
    expect(await coordinator.download(version)).toEqual({ phase: 'ready', version })
    expect(downloadUpdate).toHaveBeenCalledOnce()
  } finally { schedule.dispose(); coordinator.dispose() }
})
