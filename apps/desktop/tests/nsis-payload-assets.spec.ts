/** The Windows installer payload must carry the whole app, media assets included. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const RELEASE_ENVIRONMENT = {
  DSH_DESKTOP_APP_ID: 'com.example.desktop',
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
}

describe('desktop Windows NSIS payload', () => {
  beforeAll(() => {
    for (const [name, value] of Object.entries(RELEASE_ENVIRONMENT)) vi.stubEnv(name, value)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('excludes no media extension from the installer payload', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(RELEASE_ENVIRONMENT, 'win32', 'x64')
    // electron-builder defaults preCompressedFileExtensions to nine media
    // extensions, keeps those files out of app-64.7z, and re-adds them as
    // separate installer entries only where no `node_modules` directory is on
    // the path. A media asset of a packaged runtime package lives inside
    // `resources/.../node_modules/...`, so the default loses it from the
    // installer entirely: `ending_effect.mp4` reached no installed copy of
    // 0.1.6-alpha.2 through this rule.
    expect(config.nsis.preCompressedFileExtensions).toEqual([])
  })
})
