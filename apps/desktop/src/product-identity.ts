/** Electron identity this product owns: application name and the userData directory behind its process lock. */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readDesktopProductVersion } from '../scripts/desktop-build-version.mjs'

/** Application name and userData directory the product owns. */
export const DESKTOP_PRODUCT_NAME = 'muse-med'
/** This desktop product uses its MUSE account for the first-run account entry. */
export const DESKTOP_PRIMARY_ACCOUNT: string = 'muse'

/**
 * Resolve the displayed Muse release or the installed numbered build.
 * @param application - Electron version and application-directory access.
 * @returns Installed product version; development reads muse-product.json.
 */
export function desktopProductVersion(application: {
  readonly isPackaged: boolean
  getVersion(): string
  getAppPath(): string
}): string {
  return application.isPackaged ? application.getVersion() : readDesktopProductVersion(application.getAppPath())
}

/** Minimal Electron application operations needed to claim product identity. */
export interface DesktopProductIdentityApplication {
  setName(name: string): void
  getPath(name: 'appData'): string
  setPath(name: 'userData', path: string): void
  readonly commandLine: { hasSwitch(name: string): boolean }
}

/**
 * Point this process at the product's own Electron name and userData directory.
 *
 * The packaged manifest carries the product's own package name (`extraMetadata` in
 * `electron-builder.config.mjs`), so a built install also derives `muse-med-updater` for its
 * updater cache instead of upstream's `@deepseek-aidsh-desktop-updater`. This function states the
 * same identity at runtime, because a source launch and any build whose manifest name lags still
 * carry upstream's `@deepseek-ai/dsh-desktop`: Electron would derive `%APPDATA%\@deepseek-ai\dsh-desktop`
 * for both products, and they would share one single-instance lock, so while DeepSeek Harness runs
 * a later launch of this product fails the lock and quits with code 0 and no output. Both calls
 * must precede the lock claim and every `getPath('userData')` read.
 *
 * A launch that already received `--user-data-dir` keeps that directory: Chromium's switch
 * already isolates it, and the development launcher passes one.
 * @param application - Electron application singleton.
 */
export function applyDesktopProductIdentity(application: DesktopProductIdentityApplication): void {
  application.setName(DESKTOP_PRODUCT_NAME)
  if (application.commandLine.hasSwitch('user-data-dir')) return
  const userData = join(application.getPath('appData'), DESKTOP_PRODUCT_NAME)
  // app.setPath documents an Error for a directory that does not exist, and the
  // single-instance files are created inside it.
  mkdirSync(userData, { recursive: true })
  application.setPath('userData', userData)
}
