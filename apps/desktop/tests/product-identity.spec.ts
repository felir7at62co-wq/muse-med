import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  applyDesktopProductIdentity,
  DESKTOP_PRODUCT_NAME,
  desktopProductVersion,
  type DesktopProductIdentityApplication,
} from '../src/product-identity.ts'
import { claimDesktopSingleInstance, type DesktopSingleInstanceApplication } from '../src/single-instance.ts'

type RecordedApplication = DesktopProductIdentityApplication & DesktopSingleInstanceApplication & {
  readonly calls: string[]
}

function recordedApplication(appData: string, userDataSwitch = false): RecordedApplication {
  const calls: string[] = []
  return {
    calls,
    setName: (name: string) => { calls.push(`setName:${name}`) },
    getPath: (_name: 'appData') => { calls.push('getPath:appData'); return appData },
    setPath: (name: 'userData', path: string) => { calls.push(`setPath:${name}:${path}`) },
    commandLine: { hasSwitch: (_name: string) => { calls.push('commandLine:hasSwitch'); return userDataSwitch } },
    requestSingleInstanceLock: () => { calls.push('requestSingleInstanceLock'); return true },
    quit: () => { calls.push('quit') },
    on: (_event: 'second-instance', _listener: () => void) => { calls.push('on:second-instance') },
  }
}

function scratchAppData(): string {
  return mkdtempSync(join(tmpdir(), 'muse-med-identity-'))
}

describe('desktop product identity', () => {
  it('displays the independent product version in development and the installed build version in packaged applications', () => {
    const application = {
      isPackaged: false,
      getVersion: () => '0.1.7-rc.8',
      getAppPath: () => fileURLToPath(new URL('..', import.meta.url)),
    }
    expect(desktopProductVersion(application)).toBe('1.0.5')
    expect(desktopProductVersion({ ...application, isPackaged: true, getVersion: () => '1.0.0-beta.1.20260930.2' }))
      .toBe('1.0.0-beta.1.20260930.2')
  })
  it('gives the process its own userData directory instead of the upstream package directory', () => {
    const appData = scratchAppData()
    const application = recordedApplication(appData)

    applyDesktopProductIdentity(application)

    const userData = join(appData, DESKTOP_PRODUCT_NAME)
    expect(application.calls).toContain(`setPath:userData:${userData}`)
    expect(application.calls).toContain(`setName:${DESKTOP_PRODUCT_NAME}`)
    expect(userData).not.toBe(join(appData, '@deepseek-ai', 'dsh-desktop'))
    expect(existsSync(userData)).toBe(true)
  })

  it('keeps a launcher-provided user-data-dir instead of moving that storage', () => {
    const application = recordedApplication(scratchAppData(), true)

    applyDesktopProductIdentity(application)

    expect(application.calls).toEqual([`setName:${DESKTOP_PRODUCT_NAME}`, 'commandLine:hasSwitch'])
  })

  it('claims identity before the single-instance lock', () => {
    const appData = scratchAppData()
    const application = recordedApplication(appData)

    applyDesktopProductIdentity(application)
    expect(claimDesktopSingleInstance(application, vi.fn())).toBe(true)

    expect(application.calls).toEqual([
      `setName:${DESKTOP_PRODUCT_NAME}`,
      'commandLine:hasSwitch',
      'getPath:appData',
      `setPath:userData:${join(appData, DESKTOP_PRODUCT_NAME)}`,
      'requestSingleInstanceLock',
      'on:second-instance',
    ])
  })
})
