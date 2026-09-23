import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { desktopFetchTimeout } from '../scripts/desktop-fetch-timeout.ts'

it('allows large tarball bodies to finish beyond pnpm default sixty-second deadlines', () => {
  expect(desktopFetchTimeout({})).toBe(1_800_000)
  // pnpm applies this deadline to the whole response body, not only its headers.
  expect(desktopFetchTimeout({}) > 87_000).toBe(true)
  expect(desktopFetchTimeout({ DSH_DESKTOP_FETCH_TIMEOUT_MS: '300000' })).toBe(300_000)
})

it('passes the explicit native pnpm setting while retaining environment isolation', () => {
  const source = readFileSync(new URL('../scripts/prepare-dsh.ts', import.meta.url), 'utf8')
  expect(source).toContain("await runPnpm(['install', '--lockfile-only'])")
  expect(source).not.toContain('--config.fetch-timeout')
  expect(source.slice(source.indexOf('function runPnpm'), source.indexOf('async function main'))).not.toContain('--fetch-timeout')
  expect(source).toContain("'install', '--prod', '--frozen-lockfile', '--trust-lockfile',\n      `--fetch-timeout=${desktopFetchTimeout(process.env)}`,")
  expect(source).toContain('!/^DSH_DESKTOP_/u.test(name)')
  expect(source).toContain('!/^(?:npm|pnpm|corepack)_/iu.test(name)')
})

it('rejects malformed or unsafe build deadline overrides', () => {
  for (const value of ['', '0', '-1', '1.5', '300ms', 'Infinity', '2147483648', '9007199254740992']) {
    expect(() => desktopFetchTimeout({ DSH_DESKTOP_FETCH_TIMEOUT_MS: value })).toThrow(/positive safe integer/u)
  }
})
