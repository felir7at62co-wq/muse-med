import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_PROFILE_BUNDLES, migrateDesktopProductProfile } from '../src/desktop-profile-upgrade.ts'
import { apply as rejectArchivedBot } from '../../desktop-host/src/retired-bot.ts'
import { DESKTOP_CODEX_PACKAGE } from '../src/core-package-set.ts'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'

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

it.each(['legacy-bundle', 'legacy-before-host', 'dependency-only', 'both-bundles'] as const)(
  'replaces the %s subscription installation without changing account files, sessions or unrelated plugins', (layout) => {
    const root = mkdtempSync(join(tmpdir(), 'muse-subscription-upgrade-')); roots.push(root)
    const legacy = 'dsh-codex-subscription'
    const bundles: string[] = [...DESKTOP_PROFILE_BUNDLES, 'custom']
    if (layout === 'legacy-bundle' || layout === 'legacy-before-host') {
      bundles.splice(bundles.indexOf(DESKTOP_CODEX_PACKAGE), 1)
      bundles.splice(layout === 'legacy-before-host' ? 0 : bundles.length - 1, 0, legacy)
    } else if (layout === 'both-bundles') bundles.push(legacy)
    const manifest = { name: 'dsh-profile-desktop', private: true, version: '0.0.0',
      dependencies: { [legacy]: 'file:../retained-old-provider.tgz', custom: 'file:../custom' }, dsh: { profile: { bundles } } }
    const original = JSON.stringify(manifest)
    writeFileSync(join(root, 'package.json'), original)
    mkdirSync(join(root, 'plugins', legacy), { recursive: true })
    const credentials = Buffer.from('opaque original subscription credentials')
    const session = Buffer.from('opaque original subscription conversation')
    const patch = '- id: custom\n  config:\n    unchanged: true\n'
    const lock = 'unchanged previous package lock\n'
    writeFileSync(join(root, 'plugins', legacy, 'auth.json'), credentials)
    writeFileSync(join(root, 'session.v4.jsonl'), session)
    writeFileSync(join(root, 'cordis.patch.yml'), patch)
    writeFileSync(join(root, 'pnpm-lock.yaml'), lock)

    migrateDesktopProductProfile(root)

    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as typeof manifest
    expect(parsed.dependencies).toEqual({ custom: 'file:../custom' })
    expect(parsed.dsh.profile.bundles).toEqual([...DESKTOP_PROFILE_BUNDLES, 'custom'])
    expect(parsed.dsh.profile.bundles).toContain('dsh-plugin-subscriptions')
    expect(parsed.dsh.profile.bundles).not.toContain(legacy)
    expect(readFileSync(join(root, 'plugins', legacy, 'auth.json'))).toEqual(credentials)
    expect(readFileSync(join(root, 'session.v4.jsonl'))).toEqual(session)
    expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
    const backups = readdirSync(root).filter(file => file.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, backups[0]!), 'utf8')).toBe(original)
    if (process.platform !== 'win32') expect(statSync(join(root, backups[0]!)).mode & 0o777).toBe(0o600)
    migrateDesktopProductProfile(root)
    expect(readdirSync(root).filter(file => file.endsWith('.bak'))).toEqual(backups)
  },
)

it('retires stored subscription UI overrides during the profile upgrade without restoring the old client', () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-subscription-preferences-upgrade-')); roots.push(root)
  const manifest = { name: 'dsh-profile-desktop', private: true, version: '0.0.0',
    dependencies: { 'dsh-codex-subscription': '2.1.5' },
    dsh: { profile: { bundles: DESKTOP_PROFILE_BUNDLES.map(bundle => bundle === DESKTOP_CODEX_PACKAGE ? 'dsh-codex-subscription' : bundle) } } }
  const original = JSON.stringify(manifest)
  const patch = '# Retained viewer preference\n- id: codex-subscription\n  config:\n    imageViewer: true\n'
  writeFileSync(join(root, 'package.json'), original)
  writeFileSync(join(root, 'cordis.patch.yml'), patch)
  migrateDesktopProductProfile(root)
  const warnings: string[] = []
  const entries = applyEntryPatches([{ id: 'llm-subscriptions', name: DESKTOP_CODEX_PACKAGE }],
    loadOptionalPatches('dsh', join(root, 'cordis.patch.yml')), (message: string) => warnings.push(message))
  expect(warnings).toEqual([])
  expect(entries.filter(entry => entry.disabled !== true).map(entry => entry.name)).toEqual([DESKTOP_CODEX_PACKAGE])
  expect(entries.find(entry => entry.id === 'codex-subscription')).toMatchObject({ disabled: true, config: { imageViewer: true } })
  const backups = readdirSync(root).filter(file => file.endsWith('.bak'))
  expect(backups).toHaveLength(2)
  expect(backups.map(file => readFileSync(join(root, file), 'utf8')).sort()).toEqual([original, patch].sort())
  migrateDesktopProductProfile(root)
  expect(readdirSync(root).filter(file => file.endsWith('.bak'))).toEqual(backups)
})
