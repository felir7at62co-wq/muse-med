import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import * as fsAsync from 'node:fs/promises'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { configureDesktopHostResolver, readDesktopSettings, setDesktopSystemDns, setDesktopSystemDnsStatus } from '../src/settings.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => ({ ...await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>() }))

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'dsh-desktop-settings-'))
  onTestFinished(() => { rmSync(userData, { recursive: true, force: true }) })
  const directory = join(userData, 'desktop')
  mkdirSync(directory)
  return { userData, path: join(directory, 'settings.json') }
}

it('creates a discoverable default file on first launch without touching other preferences', () => {
  const { userData, path } = fixture()
  rmSync(join(userData, 'desktop'), { recursive: true })
  writeFileSync(join(userData, 'keybindings.json'), 'existing shortcuts\n')
  expect(readDesktopSettings(userData)).toEqual({ updates: { allowTestAuthPopupWindow: false }, network: { useSystemResolver: false } })
  expect(readFileSync(path, 'utf8')).toBe('{\n  "updates": {\n    "allowTestAuthPopupWindow": false\n  },\n  "network": {\n    "useSystemResolver": false\n  }\n}\n')
  expect(readFileSync(join(userData, 'keybindings.json'), 'utf8')).toBe('existing shortcuts\n')
})

it.each(['{}', '{"updates": {}}', '{"other": 1, "updates": {"other": true}}'])('defaults an older document without rewriting it: %s', (raw) => {
  const { userData, path } = fixture()
  writeFileSync(path, raw)
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('loads explicit opt-in and opt-out on the next read without changing an earlier process snapshot', () => {
  const { userData, path } = fixture()
  for (const allow of [true, false]) {
    const raw = JSON.stringify({ updates: { allowTestAuthPopupWindow: allow }, custom: 'preserve' })
    writeFileSync(path, raw)
    expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(allow)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  }
  const previous = readDesktopSettings(userData)
  writeFileSync(path, '{"updates":{"allowTestAuthPopupWindow":true}}')
  expect(previous.updates.allowTestAuthPopupWindow).toBe(false)
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(true)
})

it.each(['', '{', 'null', '[]', '{"updates":null}', '{"updates":[]}',
  '{"updates":{"allowTestAuthPopupWindow":"false"}}', '{"updates":{"allowTestAuthPopupWindow":1}}',
  '{"updates":{"allowTestAuthPopupWindow":null}}'])('reports invalid settings with their path and preserves the original: %s', (raw) => {
  const { userData, path } = fixture()
  writeFileSync(path, raw)
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('reports filesystem errors instead of replacing unreadable settings', () => {
  const { userData, path } = fixture()
  mkdirSync(path)
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(fs.statSync(path).isDirectory()).toBe(true)
})

it.each(['mkdirSync', 'writeFileSync'] as const)('continues with disabled popups when %s fails', (operation) => {
  const { userData, path } = fixture()
  const failure = Object.assign(new Error('settings creation denied'), { code: 'EACCES' })
  vi.spyOn(fs, operation).mockImplementation(() => { throw failure })
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), failure)
})

it('continues with defaults even when warning output fails', () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{')
  vi.mocked(console.warn).mockImplementation(() => { throw new Error('output unavailable') })
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('{')
})

it('keeps the system resolver opt-in disabled for old and new settings', () => {
  const { userData, path } = fixture()
  for (const raw of ['{}', '{"updates":{"allowTestAuthPopupWindow":true}}', '{"network":{}}']) {
    writeFileSync(path, raw)
    expect(readDesktopSettings(userData).network.useSystemResolver).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  }
})

it('writes only the DNS choice and preserves other user settings', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, JSON.stringify({ updates: { allowTestAuthPopupWindow: true, extra: 1 }, network: { extra: 2 }, custom: 'keep' }))
  await setDesktopSystemDns(userData, true)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    updates: { allowTestAuthPopupWindow: true, extra: 1 }, network: { extra: 2, useSystemResolver: true }, custom: 'keep',
  })
  expect(readDesktopSettings(userData).network.useSystemResolver).toBe(true)
  await setDesktopSystemDns(userData, false)
  expect(readDesktopSettings(userData).network.useSystemResolver).toBe(false)
})

it.each(['{', '[]', '{"network":null}', '{"network":{"useSystemResolver":"yes"}}'])
('refuses to overwrite invalid settings when changing DNS: %s', async (raw) => {
  const { userData, path } = fixture()
  writeFileSync(path, raw)
  await expect(setDesktopSystemDns(userData, true)).rejects.toThrow()
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('retains the existing settings when the atomic write fails', async () => {
  const { userData, path } = fixture()
  const raw = '{"updates":{"allowTestAuthPopupWindow":true},"custom":"keep"}'
  writeFileSync(path, raw)
  vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(setDesktopSystemDns(userData, true)).rejects.toThrow('disk unavailable')
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('reports the committed preference without a second read that can fail', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{}')
  const read = vi.spyOn(fsAsync, 'readFile')
  await expect(setDesktopSystemDnsStatus(userData, false, true)).resolves.toEqual({ saved: true, active: false })
  expect(read).toHaveBeenCalledTimes(1)
  expect(readDesktopSettings(userData).network.useSystemResolver).toBe(true)
})

it('confirms a committed setting after lock cleanup fails', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{}')
  vi.spyOn(atomic, 'withFileLock').mockImplementationOnce(async (_path, operation) => {
    await operation()
    throw new Error('lock cleanup failed')
  })
  await expect(setDesktopSystemDnsStatus(userData, false, true)).resolves.toEqual({ saved: true, active: false })
})

it('reports an unknown outcome when a post-commit failure cannot be read back', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{}')
  vi.spyOn(atomic, 'withFileLock').mockImplementationOnce(async (_path, operation) => {
    await operation()
    vi.spyOn(fsAsync, 'readFile').mockRejectedValueOnce(new Error('read failed'))
    throw new Error('lock cleanup failed')
  })
  await expect(setDesktopSystemDnsStatus(userData, false, true)).resolves.toEqual({ unknown: true })
  expect(readDesktopSettings(userData).network.useSystemResolver).toBe(true)
})

it('returns the actual saved value when a failed write did not commit', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{}')
  vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(setDesktopSystemDnsStatus(userData, false, true)).resolves.toEqual({ saved: false, active: false, saveFailed: true })
})

it('serializes overlapping settings writes and preserves other fields', async () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{"custom":"keep"}')
  await Promise.all([setDesktopSystemDns(userData, true), setDesktopSystemDns(userData, false)])
  const saved: unknown = JSON.parse(readFileSync(path, 'utf8'))
  expect(saved).toMatchObject({ custom: 'keep' })
  expect([true, false]).toContain(readDesktopSettings(userData).network.useSystemResolver)
})

it('configures the system resolver only for an explicit startup opt-in', () => {
  const configureHostResolver = vi.fn()
  configureDesktopHostResolver({ network: { useSystemResolver: false }, updates: { allowTestAuthPopupWindow: false } },
    configureHostResolver)
  expect(configureHostResolver).not.toHaveBeenCalled()
  configureDesktopHostResolver({ network: { useSystemResolver: true }, updates: { allowTestAuthPopupWindow: false } },
    configureHostResolver)
  expect(configureHostResolver).toHaveBeenCalledExactlyOnceWith({ enableBuiltInResolver: false })
})
