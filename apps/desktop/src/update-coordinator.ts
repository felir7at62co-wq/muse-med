/** User-authorized downloads and separate installation of one version-bound Desktop release. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo, type UpdateCheckResult } from 'electron-updater'
import { gt, valid } from 'semver'
import type { DesktopUpdateState } from './ipc.ts'
import { DesktopUpdateHttpExecutor } from './updates/electron-updater/http-executor.ts'
import { DesktopUpdatePreparationError, downloadFailureDetails } from './update-error.ts'
import type { DesktopUpdateChannel } from './update-channel.ts'
import { selectUpdateChannel } from './updates/electron-updater/channel.ts'
import { discardDesktopUpdate } from './updates/electron-updater/discard.ts'
import { createMacOSManualUpdater, readMacOSManualUpdateAppId } from './macos-manual-updater.ts'
import { desktopUpdateIdentity, isDesktopUpdateSourceUnavailable, loadDesktopUpdateSources,
  type DesktopUpdateSource } from './update-sources.ts'

/** Electron updater operations used by the coordinator. */
export type DesktopUpdater = Pick<AppUpdater, 'downloadUpdate' | 'setFeedURL'
  | 'channel' | 'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'allowDowngrade'> & {
    readonly installationMode?: 'manual-dmg'
    /** Recheck a prepared manual installer before stopping tasks. */
    verifyPreparedUpdate?(): Promise<void>
    /** Open an authorized manual installer, propagating asynchronous failures. */
    openPreparedInstaller?(): Promise<void>
    /** Hand off a native updater’s authorized installation. */
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
    /** Subscribe to updater notifications. */
    on(...args: Parameters<AppUpdater['on']>): unknown
    /** Retire an updater notification listener. */
    off(...args: Parameters<AppUpdater['off']>): unknown
    /** Check the selected feed's availability and release version. */
    checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: Pick<UpdateInfo, 'version'> & Partial<Pick<UpdateInfo, 'files'>>; cancellationToken?: UpdateCheckResult['cancellationToken'] } | null>
  }

const manualAppId = process.platform === 'darwin' && app.isPackaged
  ? readMacOSManualUpdateAppId(join(process.resourcesPath, 'muse-macos-update.json'), app.getVersion()) : undefined
const autoUpdater = manualAppId === undefined ? electronUpdater.autoUpdater : createMacOSManualUpdater(manualAppId)

/** Explicit packaged evidence for a legacy single-source feed. */
export interface DesktopUpdateFeedPolicy {
  /** The installed manifest explicitly selected latest before the Stable UI name. */
  readonly legacyStableFeed?: 'latest'
}

/** Owns one updater target until its download and installation settle. */
export class DesktopUpdateCoordinator {
  private current: DesktopUpdateState = { phase: 'idle' }
  private release: { kind: 'none' } | { kind: 'checked' | 'downloaded' | 'handed-off'; version: string } = { kind: 'none' }
  private downloadedInfo: UpdateInfo | undefined
  private disposed = false
  private generation = 0
  private switching = 0
  private downloadGeneration = 0
  private switchTail: Promise<void> = Promise.resolve()
  private cancellation: UpdateCheckResult['cancellationToken']
  private configurationError: 'startup' | 'cleanup' | undefined
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private downloadOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined
  private sourceChannelOverride: string | undefined
  private sourceIndex = 0
  private identity: string | undefined
  private sourceValidated = false

  private readonly onProgress = (progress: ProgressInfo): void => {
    if (this.downloadGeneration !== this.generation || this.downloadOperation === undefined || this.downloaded) return
    const percent = Math.min(100, Math.max(0, progress.percent))
    this.setState({ phase: percent >= 100 ? 'verifying' : 'downloading', ...this.target(), percent })
  }

  private readonly onDownloaded = (info: UpdateInfo): void => {
    if (this.downloadGeneration !== this.generation || this.downloadOperation === undefined || info.version !== this.candidate) return
    if (!this.sourceValidated) return
    this.downloadedInfo = info
    this.release = { kind: 'downloaded', version: info.version }
  }

  private readonly onError = (error: Error): void => {
    // Check/download promises own their failures. Installation can fail after quitAndInstall returns.
    if (this.current.phase === 'installing') {
      this.setState(this.failure(error, 'install'))
    }
  }

  /**
   * @param publish - Receives observable states for every Desktop window.
   * @param beforeRestart - Completes task authorization, admission locking, and owned-process shutdown.
   * @param updater - Process-owned Electron updater, replaceable at the network/platform test boundary.
   * @param enabled - Whether this process has a packaged update source.
   * @param currentVersion - Actual installed application version.
   * @param channel - Installed package channel; omitted test/local callers retain nightly.
   * @param discard - Clears settled library targets and platform resources before another channel is used.
   * @param downloadResult - Once per completed download attempt, including platform preparation failures.
   * @param sources - Sealed primary and fallback feeds; injected only by updater qualification fixtures.
   * @param platform - Native updater platform; Windows uses the visible installer progress window.
   * @param feedPolicy - Original packaged feed evidence when no sealed source list is present.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly beforeRestart: () => Promise<boolean>,
    private readonly updater: DesktopUpdater = autoUpdater,
    private readonly enabled: () => boolean = () => app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
    private readonly currentVersion: () => string = () => app.getVersion(),
    private readonly downloadResult?: (success: boolean, reason?: string) => void,
    private readonly sources: readonly DesktopUpdateSource[] = updater === autoUpdater && app.isPackaged
      ? loadDesktopUpdateSources(join(process.resourcesPath, 'muse-update-sources.json'), currentVersion()) : [],
    private readonly platform: NodeJS.Platform = process.platform,
    private channel: DesktopUpdateChannel | 'latest' = 'nightly',
    private readonly discard: (updater: AppUpdater) => Promise<void> = discardDesktopUpdate,
    private readonly feedPolicy: DesktopUpdateFeedPolicy = {},
  ) {
    if (updater === autoUpdater) {
      // electron-updater omits this internal transport property from its public declarations.
      // Real-Electron qualification exercises the pinned dependency integration.
      const transportOwner = updater as AppUpdater & { httpExecutor: DesktopUpdateHttpExecutor }
      transportOwner.httpExecutor = new DesktopUpdateHttpExecutor(
        Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 60_000),
        (authInfo, callback) => { autoUpdater.emit('login', authInfo, callback) },
      )
    }
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.sourceChannelOverride = this.feedChannel(this.selectedChannel, true)
    this.applyChannel()
    this.updater.on('download-progress', this.onProgress)
    this.updater.on('update-downloaded', this.onDownloaded)
    this.updater.on('error', this.onError)
  }

  /** Latest observable state; complete download identity remains main-process-owned. */
  get state(): DesktopUpdateState { return this.current }

  /** Ad-hoc macOS installations open a verified DMG instead of invoking Squirrel. */
  get installationMode(): 'native' | 'manual-dmg' { return this.updater.installationMode ?? 'native' }
  /** Reason ordinary updates are suspended, independently of the last operation result. */
  get configurationFailure(): 'startup' | 'cleanup' | undefined { return this.configurationError }

  /** Selected runtime channel, including while a new feed is being checked. */
  get selectedChannel(): DesktopUpdateChannel { return this.channel === 'latest' ? 'stable' : this.channel }

  /** Revision captured by confirmations so channel changes invalidate old user actions. */
  get revision(): number { return this.generation }

  /**
   * Suspend ordinary updates when settings or previous-target cleanup are invalid.
   * @param detail - File path and safe diagnostic, without document contents.
   * @param reason - Startup validation or retirement of a previous target.
   */
  suspendConfiguration(detail: string, reason: 'startup' | 'cleanup' = 'startup'): void {
    this.configurationError = reason
    this.setState({ phase: 'error', failedOperation: 'configuration', message: detail })
  }

  /**
   * Persist a UI choice, retire the old target, and check the selected feed.
   * Accepted choices serialize; installation cannot start while any choice is pending.
   * Persistence failure leaves the previous channel and target intact. Cleanup failure
   * suspends updates until another explicit switch successfully retires the target.
   * @param channel - Validated UI choice.
   * @param persist - Atomic settings save; rejects before a choice is applied on failure.
   * @returns Whether the selection changed; healthy repeated choices preserve the current operation.
   */
  switchChannel(channel: DesktopUpdateChannel, persist: () => Promise<void>): Promise<'applied' | 'unchanged'> {
    this.assertLive()
    if (this.installOperation !== undefined || this.current.phase === 'installing' || this.release.kind === 'handed-off') {
      return Promise.reject(new Error('desktop update: installation is in progress'))
    }
    this.switching++
    const operation = this.switchTail.then(async () => {
      this.assertLive()
      if (channel === this.channel && this.configurationError === undefined) return 'unchanged' as const
      await persist()
      this.generation++
      this.cancellation?.cancel()
      await Promise.allSettled([this.checkOperation, this.downloadOperation])
      this.assertLive()
      this.release = { kind: 'none' }
      this.downloadedInfo = undefined
      this.identity = undefined
      this.sourceValidated = false
      this.sourceIndex = 0
      this.cancellation = undefined
      try { await this.discard(this.updater as AppUpdater) } catch (error) {
        this.suspendConfiguration('desktop update: could not retire the previous update', 'cleanup')
        throw error
      }
      this.channel = channel
      this.sourceChannelOverride = this.feedChannel(channel)
      this.applyChannel()
      this.configurationError = undefined
      this.setState({ phase: 'checking' })
      const result = await this.doCheck()
      if (result.phase === 'error') this.setState(result)
      return 'applied' as const
    }).finally(() => { this.switching-- })
    this.switchTail = operation.then(() => {}).catch(() => { /* The caller reports this selection's failure; later choices may retry. */ })
    return operation
  }

  /**
   * Check metadata without downloading, joining any current check.
   * @param manual - Whether a failed check must remain visible in the status indicator.
   * @returns The check result, including a silent automatic failure when applicable.
   */
  async check(manual = false): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.configurationError !== undefined || this.switching > 0
      || this.downloadOperation !== undefined || this.installOperation !== undefined || this.downloaded) return this.current
    if (!manual && this.current.phase === 'error' && this.current.failedOperation === 'download') return this.current
    this.checkOperation ??= Promise.resolve().then(() => this.doCheck())
      .finally(() => { this.checkOperation = undefined })
    const result = await this.checkOperation
    if (manual && result.phase === 'error') this.setState(result)
    return result
  }

  /**
   * Retries recheck any source that has not matched the confirmed release.
   * @param version - Version shown in the user's download confirmation.
   * @param revision - Revision captured by the download confirmation; omitted uses the current target.
   * @returns Download readiness or failure, without authorizing installation.
   */
  async download(version: string, revision = this.generation): Promise<DesktopUpdateState> {
    this.assertLive()
    if (revision !== this.generation || this.configurationError !== undefined || this.switching > 0) return this.current
    if (this.downloaded || this.installOperation !== undefined) return this.current
    const generation = this.generation
    this.downloadGeneration = generation
    this.downloadOperation ??= Promise.resolve().then(async () => {
      await this.checkOperation
      if (generation !== this.generation) return this.current
      this.assertLive()
      if (this.candidate === undefined) throw new Error('desktop update: no checked update is available')
      if (version !== this.candidate) throw new Error('desktop update: download confirmation is stale')
      this.setState({ phase: 'downloading', version, percent: 0 })
      try {
        await this.downloadFromSource()
        if (generation !== this.generation || this.disposed) return this.current
        if (!this.downloaded || this.downloadedInfo === undefined) throw new Error('desktop update: platform preparation did not report readiness')
        if (this.identity !== undefined && desktopUpdateIdentity(this.downloadedInfo) !== this.identity) {
          throw new Error('desktop update: downloaded payload differs from the confirmed release; check for updates again')
        }
        this.downloadResult?.(true)
        return this.setState({ phase: 'ready', version })
      } catch (error) {
        if (generation !== this.generation || this.disposed) return this.current
        this.downloadedInfo = undefined
        this.release = { kind: 'checked', version }
        this.downloadResult?.(false, error instanceof DesktopUpdatePreparationError ? error.kind : 'download_failed')
        return this.setState(this.failure(error, 'download'))
      }
    }).finally(() => { this.downloadOperation = undefined })
    return this.downloadOperation
  }

  /**
   * Install a prepared target after a separate user confirmation.
   * @param version - Exact version displayed in the confirmation, never a renderer-selected URL.
   * @param revision - Revision captured when the confirmation began; omitted uses the current target.
   * @returns Installation handoff or a recoverable preparation error.
   */
  async install(version: string, revision = this.generation): Promise<DesktopUpdateState> {
    this.assertLive()
    if (revision !== this.generation) return this.current
    if (this.configurationError !== undefined || this.switching > 0) throw new Error('desktop update: channel selection is not ready')
    if (!this.downloaded || this.downloadOperation !== undefined || version !== this.candidate) throw new Error('desktop update: confirmed target is not ready')
    this.installOperation ??= Promise.resolve().then(async () => {
      this.setState({ phase: 'installing', version })
      try {
        try { await this.updater.verifyPreparedUpdate?.() }
        catch (error) {
          this.downloadedInfo = undefined
          this.release = { kind: 'checked', version }
          return this.setState(this.failure(error, 'download'))
        }
        if (!await this.beforeRestart()) return this.setState({ phase: 'ready', version })
        this.assertLive()
        this.release = { kind: 'handed-off', version }
        if (this.updater.installationMode === 'manual-dmg') {
          if (this.updater.openPreparedInstaller === undefined) throw new Error('desktop update: manual installation operation is missing')
          await this.updater.openPreparedInstaller()
        } else this.updater.quitAndInstall(this.platform !== 'win32', true)
        return this.current
      } catch (error) {
        if (this.current.phase === 'error' && this.current.failedOperation === 'install') return this.current
        return this.setState(this.failure(error, 'install'))
      }
    }).finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  /** Remove owned listeners and prevent pending library operations from publishing into closed UI. */
  dispose(): void {
    this.disposed = true
    this.updater.off('download-progress', this.onProgress)
    this.updater.off('update-downloaded', this.onDownloaded)
    // Pending updater promises can still emit EventEmitter errors during shutdown.
    void Promise.allSettled([this.checkOperation, this.downloadOperation, this.installOperation, this.switchTail])
      .then(() => { this.updater.off('error', this.onError) })
  }

  private get candidate(): string | undefined { return this.release.kind === 'none' ? undefined : this.release.version }

  private get downloaded(): boolean { return this.release.kind === 'downloaded' || this.release.kind === 'handed-off' }

  private assertLive(): void {
    if (this.disposed) throw new Error('desktop update: coordinator is disposed')
  }

  private setState(state: DesktopUpdateState): DesktopUpdateState {
    if (!this.disposed) {
      this.current = state
      this.publish(state)
    }
    return state
  }

  private failure(error: unknown, failedOperation: 'check' | 'download' | 'install'): DesktopUpdateState {
    return { phase: 'error', ...this.target(), failedOperation,
      message: error instanceof Error ? error.message : String(error),
      ...(failedOperation === 'download' ? downloadFailureDetails(error) : {}),
      ...(error instanceof DesktopUpdatePreparationError ? {
        preparationFailure: error.kind,
        ...(error.technicalDetails === undefined ? {} : { technicalDetails: error.technicalDetails }),
      } : {}) }
  }

  private target(): { version?: string } {
    return this.candidate === undefined ? {} : { version: this.candidate }
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    const generation = this.generation
    try {
      this.assertLive()
      if (!this.enabled()) throw new Error('desktop update: this application has no packaged update source')
      this.release = { kind: 'none' }
      this.downloadedInfo = undefined
      this.identity = undefined
      this.sourceIndex = 0
      const result = await this.checkFromSource()
      if (generation !== this.generation || this.disposed) return this.current
      if (result === null) throw new Error('desktop update: no check result was returned')
      this.cancellation = result.cancellationToken
      const version = result.updateInfo.version
      if (valid(version) === null) throw new Error('desktop update: feed version is invalid')
      if ((this.channel === 'latest' || this.sources.length > 0 && this.channel === 'stable') && version.includes('-')) throw new Error('desktop update: stable feed contains a prerelease')
      this.identity = this.sources.length > 1 ? desktopUpdateIdentity(result.updateInfo) : undefined
      this.sourceValidated = true
      this.release = result.isUpdateAvailable && gt(version, this.currentVersion())
        ? { kind: 'checked', version } : { kind: 'none' }
      return this.setState(this.candidate === undefined ? { phase: 'idle' } : { phase: 'available', version })
    } catch (error) {
      if (generation !== this.generation || this.disposed) return this.current
      return this.failure(error, 'check')
    }
  }

  private feedChannel(channel: DesktopUpdateChannel, preserveDiscovery = false): string {
    const source = this.sources[0]
    const sealedChannel = typeof source === 'object' && 'channel' in source && typeof source.channel === 'string'
      ? source.channel : undefined
    if (channel === 'nightly') {
      return preserveDiscovery && sealedChannel !== undefined && sealedChannel !== 'latest' && sealedChannel !== 'stable'
        ? sealedChannel : 'nightly'
    }
    const legacy = this.sources.length > 0
      ? this.sources.some(item => typeof item === 'object' && 'channel' in item && item.channel === 'latest')
      : this.feedPolicy.legacyStableFeed === 'latest' || this.channel === 'latest'
    return legacy ? 'latest' : 'stable'
  }

  private applyChannel(): void {
    selectUpdateChannel(this.updater, this.selectedChannel, this.sourceChannelOverride ?? this.feedChannel(this.selectedChannel))
  }

  private async checkFromSource(): ReturnType<DesktopUpdater['checkForUpdates']> {
    this.sourceValidated = false
    for (;;) {
      this.assertLive()
      const source = this.sources[this.sourceIndex]
      if (source !== undefined) {
        this.updater.setFeedURL(typeof source === 'object' && (source.provider === 'generic' || source.provider === 'github')
          && this.sourceChannelOverride !== undefined ? { ...source, channel: this.sourceChannelOverride } : source)
      }
      try { return await this.updater.checkForUpdates() } catch (error) {
        if (!isDesktopUpdateSourceUnavailable(error) || this.sourceIndex + 1 >= this.sources.length) throw error
        this.sourceIndex++
      }
    }
  }

  private async downloadFromSource(): Promise<void> {
    for (;;) {
      this.assertLive()
      if (!this.sourceValidated) {
        const result = await this.checkFromSource()
        if (result === null || !result.isUpdateAvailable || this.identity === undefined
          || desktopUpdateIdentity(result.updateInfo) !== this.identity) {
          throw new Error('desktop update: fallback payload differs from the confirmed release; check for updates again')
        }
        this.assertLive()
        this.sourceValidated = true
        this.setState({ phase: 'downloading', ...this.target(), percent: 0 })
      }
      try { await this.updater.downloadUpdate(this.cancellation); return } catch (error) {
        if (!isDesktopUpdateSourceUnavailable(error) || this.sourceIndex + 1 >= this.sources.length) throw error
        this.downloadedInfo = undefined
        this.sourceValidated = false
        this.sourceIndex++
      }
    }
  }
}
