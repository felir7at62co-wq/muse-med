import { afterEach, expect, it, vi } from 'vitest'
import { desktopClientCommitHash, desktopClientMetadata, desktopClientVersion } from '../src/client-metadata.ts'

afterEach(() => { vi.unstubAllEnvs() })

it('reports the embedded source commit and refuses missing commit metadata', () => {
  vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
  expect(desktopClientCommitHash()).toBe('0123456')
  vi.stubEnv('DSH_CLIENT_COMMIT_HASH', undefined)
  expect(() => desktopClientCommitHash()).toThrow(/DSH_CLIENT_COMMIT_HASH/u)
})

it('reports the inlined client build version and the requested language', () => {
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  expect(desktopClientVersion()).toBe('1.2.3')
  expect(desktopClientMetadata('zh-CN')).toMatchObject({ version: '1.2.3', locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 })
})

it('refuses a build that carries no client version instead of guessing one', () => {
  vi.stubEnv('DSH_CLIENT_VERSION', undefined)
  expect(() => desktopClientVersion()).toThrow(/DSH_CLIENT_VERSION/)
  vi.stubEnv('DSH_CLIENT_VERSION', '')
  expect(() => desktopClientMetadata('en')).toThrow(/DSH_CLIENT_VERSION/)
})
