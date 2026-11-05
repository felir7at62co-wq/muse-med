import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_PROFILE_BUNDLES, migrateDesktopProductProfile } from '../src/desktop-profile-upgrade.ts'
import { apply as rejectArchivedBot } from '../../desktop-host/src/retired-bot.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it.each(['ds-bot', 'muse-bot'])('retires %s while retaining full state, source package specs, unrelated plugins and exact private backups', (bot) => {
  const root = mkdtempSync(join(tmpdir(), 'muse-profile-upgrade-')); roots.push(root)
  const manifest = { name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: '0.0.0', dependencies: { [bot]: '0.2.4', custom: 'file:../custom' },
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES, bot, 'custom'] } } }
  const original = JSON.stringify(manifest), patch = '- id: muse-bot\n  disabled: false\n  config:\n    preserve: original-private-config\n'
  writeFileSync(join(root, 'package.json'), original); writeFileSync(join(root, 'cordis.patch.yml'), patch)
  mkdirSync(join(root, 'ds-bot'))
  const state = Buffer.from('opaque complete Bot state'), session = Buffer.from('opaque original conversation bytes'), lock = 'unchanged pnpm lock\n'
  writeFileSync(join(root, 'ds-bot', 'state.json'), state); writeFileSync(join(root, 'session.v4.jsonl.zstd'), session); writeFileSync(join(root, 'pnpm-lock.yaml'), lock)
  migrateDesktopProductProfile(root)
  const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as typeof manifest
  expect(parsed.dependencies).toEqual(manifest.dependencies)
  expect(parsed.dsh.profile.bundles).toEqual([...DESKTOP_PROFILE_BUNDLES, 'custom'])
  expect(readFileSync(join(root, 'ds-bot', 'state.json'))).toEqual(state)
  expect(readFileSync(join(root, 'session.v4.jsonl.zstd'))).toEqual(session)
  expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
  const backups = readdirSync(root).filter(file => file.endsWith('.bak'))
  expect(backups).toHaveLength(2)
  expect(backups.map(file => readFileSync(join(root, file), 'utf8')).sort()).toEqual([original, patch].sort())
  if (process.platform !== 'win32') for (const file of backups) expect(statSync(join(root, file)).mode & 0o777).toBe(0o600)
  migrateDesktopProductProfile(root)
  expect(readdirSync(root).filter(file => file.endsWith('.bak'))).toEqual(backups)
})

it('rejects reactivation through the new shared Host manager without importing archived code', () => {
  expect(() => rejectArchivedBot()).toThrow('archived Bot packages cannot be activated')
})
