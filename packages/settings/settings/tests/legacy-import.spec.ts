/**
 * The one-shot import of the removed `settings.yaml` document.
 *
 * The product line stored every section in that document before the settings
 * service became Config-derived forms over the active profile, so an upgrade
 * has to carry those values into the profile patch — including the sections
 * whose composition entry id differs from the section name — and has to leave
 * the original file behind as the backup that still holds anything it could not
 * place. The rows here are the fixture's probes, so this file asserts the move
 * itself; the product's own field names are asserted where their real Configs
 * live (`packages/host/feishu-settings/tests/service.spec.ts`).
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { configurationFixture } from './configuration-fixture.ts'

/** The sections an upgraded product profile leaves behind, and where each belongs. */
const LEGACY_DOCUMENT = [
  'feishu:',
  '  count: 7',
  "'agent-presets':",
  '  count: 9',
  'dsh-lark-bridge:',
  '  count: 5',
  '  token: hunter2-legacy-secret',
  'unknown-section:',
  '  count: 3',
  '',
].join('\n')

/** Rows that stand in for the product's own switch, the bridge, and the preset roster. */
const ROWS: readonly EntryOptions[] = [
  { id: 'config-editor', name: 'cordis:editor' },
  { id: 'settings', name: 'cordis:settings' },
  { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'fixed' } },
  { id: 'feishu-channel', name: 'cordis:probe', config: { ordinary: 'fixed', appId: '' } },
  { id: 'agent-preset-registry', name: 'cordis:probe', config: { ordinary: 'fixed', count: 2 } },
]

/** Read the profile patch's rows by id, the way the composition reads them. */
async function patchRows(path: string): Promise<Map<string, Record<string, unknown>>> {
  const rows = yaml.load(await readFile(path, 'utf8')) as Array<{ id?: string; config?: Record<string, unknown> }> | null
  return new Map((rows ?? []).flatMap(row => typeof row.id === 'string' ? [[row.id, row.config ?? {}] as const] : []))
}

describe('importLegacyDocument', () => {
  it('carries every mapped section into the profile patch and keeps the original as the backup', async () => {
    const fixture = await configurationFixture({ rows: ROWS })
    const documentPath = join(fixture.home, 'settings.yaml')
    await writeFile(documentPath, LEGACY_DOCUMENT)

    // A second boot is what an upgrade is: the imported document is read once,
    // when the settings service settles the Loader of that boot.
    const ctx = await fixture.start()
    await vi.waitFor(async () => {
      expect(existsSync(join(fixture.home, 'settings.yaml.imported'))).toBe(true)
    })
    await vi.waitFor(async () => {
      expect((await patchRows(fixture.profile.patchPath)).get('feishu-channel')).toMatchObject({ token: 'hunter2-legacy-secret' })
    })

    const rows = await patchRows(fixture.profile.patchPath)
    // The move is a rename: the legacy document is the backup, byte for byte,
    // and the section the running composition rejects stays readable in it.
    expect(existsSync(documentPath)).toBe(false)
    expect(await readFile(join(fixture.home, 'settings.yaml.imported'), 'utf8')).toBe(LEGACY_DOCUMENT)
    expect(rows.get('feishu')).toMatchObject({ count: 7 })
    expect(rows.get('agent-preset-registry')).toMatchObject({ count: 9 })
    expect(rows.get('feishu-channel')).toMatchObject({ count: 5, token: 'hunter2-legacy-secret' })
    expect(rows.has('unknown-section')).toBe(false)
    // The mapped sections are readable through the service that wrote them, and
    // the secret one still reports only that its secret is set.
    const sections = ctx.get('settings')!.describe({ redactSecrets: true })
    expect(sections.find(section => section.ns === 'feishu')?.user).toMatchObject({ count: 7 })
    expect(sections.find(section => section.ns === 'agent-preset-registry')?.user).toMatchObject({ count: 9 })
    expect(sections.find(section => section.ns === 'feishu-channel')?.secrets)
      .toContainEqual({ path: ['token'], set: true })
  })

  it('is a no-op on a home that never had the document', async () => {
    const fixture = await configurationFixture({ rows: ROWS })
    const ctx = await fixture.start()
    await Promise.resolve(ctx.loader.await())

    expect(existsSync(join(fixture.home, 'settings.yaml'))).toBe(false)
    expect(existsSync(join(fixture.home, 'settings.yaml.imported'))).toBe(false)
    expect((await patchRows(fixture.profile.patchPath)).size).toBe(0)
  })
})
