/** Download verified DMGs for ad-hoc builds while retaining native Squirrel for publisher-signed builds. */
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { shell } from 'electron'
import electronUpdater, { type AppUpdater, type ResolvedUpdateFileInfo } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import type { AppAdapter } from 'electron-updater/out/AppAdapter.js'
import type { DesktopUpdateHttpExecutor } from './update-http-executor.ts'
import { verifyMacOSUpdateBytes, verifyMacOSUpdatePackage, type MacOSUpdatePackage } from './macos-update-package.ts'

/** Main-owned manual installation operations selected only for sealed ad-hoc builds. */
export interface MacOSManualUpdater extends AppUpdater {
  readonly installationMode: 'manual-dmg'
  /** @returns Resolves after the prepared bytes are rechecked; failure clears readiness and its private cache. */
  verifyPreparedUpdate(): Promise<void>
  /** @returns Resolves after the verified installer opens and normal quit begins; rejects without quitting on open failure. */
  openPreparedInstaller(): Promise<void>
}

/**
 * Read the version-bound packaged update mode; absent markers retain native signing validation.
 * @param path - Sealed application resources marker.
 * @param version - Actual installed version.
 * @returns Configured application identifier, or undefined for a native-update build.
 */
export function readMacOSManualUpdateAppId(path: string, version: string): string | undefined {
  if (!existsSync(path)) return undefined
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('version' in value) || value.version !== version || !('installationMode' in value) || value.installationMode !== 'manual-dmg'
    || !('appId' in value) || typeof value.appId !== 'string' || !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/u.test(value.appId)) {
    throw new Error('desktop macOS update: packaged manual installation mode is invalid')
  }
  return value.appId
}

/**
 * Select the exact product DMG for the architecture running this application.
 * @param files - Files resolved by the configured provider.
 * @param version - Version confirmed by the coordinator.
 * @param arch - Current application architecture.
 * @returns One matching DMG; missing, duplicate, or incomplete metadata rejects.
 */
export function selectMacOSUpdateDiskImage(files: readonly ResolvedUpdateFileInfo[], version: string,
  arch: string): ResolvedUpdateFileInfo & { info: ResolvedUpdateFileInfo['info'] & { size: number } } {
  const name = `muse-med-${version}-mac-${arch}.dmg`
  const candidates = files.filter(file => basename(file.url.pathname) === name)
  const file = candidates[0]
  if (candidates.length !== 1 || file === undefined) {
    throw new Error('desktop macOS update: release must provide exactly one architecture-matched Muse disk image')
  }
  if (file.url.protocol !== 'https:' || file.url.username !== '' || file.url.password !== '') {
    throw new Error('desktop macOS update: disk image URL must use public HTTPS')
  }
  const size = file.info.size
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(file.info.sha512) || size === undefined || !Number.isSafeInteger(size) || size < 1) {
    throw new Error('desktop macOS update: disk image metadata requires SHA-512 and size')
  }
  return { ...file, info: { ...file.info, size } }
}

/**
 * Reuse the configured feeds, Electron HTTP transport and checksum cache for manual DMG installation.
 * @param appId - Identifier from the sealed installed-application marker.
 * @param adapter - Application adapter owned by isolated updater qualification, omitted in production.
 * @returns Updater that opens a verified DMG only after coordinator authorization, then quits normally.
 */
export function createMacOSManualUpdater(appId: string, adapter?: AppAdapter): MacOSManualUpdater {
  class ManualUpdater extends electronUpdater.AppUpdater implements MacOSManualUpdater {
    readonly installationMode = 'manual-dmg'
    // The pinned dependency initializes this transport but omits it from its declarations.
    declare readonly httpExecutor: DesktopUpdateHttpExecutor | null
    private prepared: MacOSUpdatePackage | undefined

    constructor() { super(undefined, adapter) }

    protected override async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
      const provider = options.updateInfoAndProvider.provider
      const version = options.updateInfoAndProvider.info.version
      if (process.arch !== 'arm64' && process.arch !== 'x64') throw new Error('desktop macOS update: application architecture is unsupported')
      const arch = process.arch
      const file = selectMacOSUpdateDiskImage(provider.resolveFiles(options.updateInfoAndProvider.info), version, arch)
      this.prepared = undefined
      return this.executeDownload({
        fileExtension: 'dmg', fileInfo: file, downloadUpdateOptions: options,
        task: async (destination, downloadOptions) => {
          if (this.httpExecutor === null) throw new Error('desktop macOS update: HTTP transport is not configured')
          await this.httpExecutor.download(file.url, destination, downloadOptions)
        },
        done: async (event) => {
          const candidate: MacOSUpdatePackage = { path: event.downloadedFile, version, appId, arch,
            sha512: file.info.sha512, size: file.info.size }
          try { await verifyMacOSUpdatePackage(candidate) }
          catch (error) {
            await this.downloadedUpdateHelper?.clear()
            throw error
          }
          this.prepared = candidate
          this.dispatchUpdateDownloaded(event)
        },
      })
    }

    /** Reject a cache mutation before the coordinator stops running tasks. */
    async verifyPreparedUpdate(): Promise<void> {
      await this.verifiedPrepared()
    }

    private async verifiedPrepared(): Promise<MacOSUpdatePackage> {
      if (this.prepared === undefined) throw new Error('desktop macOS update: no verified disk image is ready')
      const prepared = this.prepared
      try { await verifyMacOSUpdateBytes(prepared) }
      catch (error) {
        this.prepared = undefined
        await this.downloadedUpdateHelper?.clear()
        throw error
      }
      return prepared
    }

    /** Open the confirmed verified installer; this method never copies or replaces an application. */
    async openPreparedInstaller(): Promise<void> {
      const prepared = await this.verifiedPrepared()
      const error = await shell.openPath(prepared.path)
      if (error !== '') throw new Error(`desktop macOS update: could not open the verified disk image: ${error}`)
      this.app.quit()
    }

    override quitAndInstall(): void {
      throw new Error('desktop macOS update: manual installation requires the coordinator’s separate installer-open authorization')
    }
  }
  return new ManualUpdater()
}
