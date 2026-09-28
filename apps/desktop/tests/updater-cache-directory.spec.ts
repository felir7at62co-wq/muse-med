/** The packaged updater must keep downloaded installers in a directory this product alone owns. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const RELEASE_ENVIRONMENT = {
  DSH_DESKTOP_APP_ID: 'com.example.desktop',
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
}

describe('desktop updater cache directory', () => {
  // Importing the configuration also evaluates its default export for one release
  // environment, so the environment has to be in place first.
  beforeAll(() => {
    for (const [name, value] of Object.entries(RELEASE_ENVIRONMENT)) vi.stubEnv(name, value)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('derives the updater cache directory from this product alone', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(RELEASE_ENVIRONMENT, 'win32', 'x64')
    // electron-builder 26 exposes no field for `updaterCacheDirName`: the packaged
    // `resources/app-update.yml` records `AppInfo.updaterCacheDirName`, which is
    // `sanitizeFileName(packageJson.name).toLowerCase() + '-updater'`, and the NSIS
    // targets define their package store from the same getter. The packaged manifest
    // name is the only input, and `muse-med` is unchanged by that sanitizing, so the
    // shared directory the workspace manifest's upstream name derives is unreachable.
    expect(config.extraMetadata.name).toBe('muse-med')
    const updaterCacheDirName = `${config.extraMetadata.name}-updater`
    expect(updaterCacheDirName).toBe('muse-med-updater')
    expect(updaterCacheDirName).not.toBe('@deepseek-aidsh-desktop-updater')
  })
})
