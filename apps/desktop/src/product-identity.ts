/** Electron identity this product owns: application name and the userData directory behind its process lock. */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Application name and userData directory the product owns. */
export const DESKTOP_PRODUCT_NAME = 'muse-med'

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
 * The packaged manifest keeps upstream's `@deepseek-ai/dsh-desktop` package name, so Electron
 * otherwise derives `%APPDATA%\@deepseek-ai\dsh-desktop` for both products. They then share one
 * single-instance lock: while DeepSeek Harness runs, this product's later launch fails the lock
 * and quits with code 0 and no output. Both calls must precede the lock claim and every
 * `getPath('userData')` read.
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
