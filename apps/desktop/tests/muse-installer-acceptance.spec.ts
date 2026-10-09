/** Identity and full-payload rejection checks for native installer qualification. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMuseInstalledIdentity, assertMuseInstalledPayload, assertMuseInstalledUnchanged, museAcceptanceArtifact,
  museAcceptanceWindowsLicenses } from '../scripts/muse-installer-acceptance.ts'

const identity = { target: 'win-x64' as const, version: '1.0.5', sourceCommit: 'a'.repeat(40) }
const manifest = { name: 'muse-med', version: identity.version, dshDesktopAppId: 'cn.muse.med',
  dshBuildCommit: identity.sourceCommit, dshBuildDirty: false }
const filename = `muse-med-${identity.version}-win-x64.exe`
const digest = { size: 8, sha256: 'b'.repeat(64), sha512: `${'c'.repeat(86)}==` }
const record = { schemaVersion: 1, ...identity, unsigned: true, artifacts: { [filename]: digest } }

describe('genuine Muse installer identity', () => {
  it('accepts the clean application and original installer record', () => {
    expect(() => { assertMuseInstalledIdentity(manifest, identity) }).not.toThrow()
    expect(museAcceptanceArtifact(record, identity, filename)).toEqual(digest)
  })

  it.each([
    { version: '1.0.4' }, { dshBuildCommit: 'd'.repeat(40) }, { dshBuildDirty: true },
    { dshDesktopAppId: 'another.application' }, { name: 'another-app' },
  ])('refuses incompatible installed identity %j', (changed) => {
    expect(() => { assertMuseInstalledIdentity({ ...manifest, ...changed }, identity) }).toThrow()
  })

  it.each([
    { target: 'mac-arm64' }, { version: '1.0.4' }, { sourceCommit: 'd'.repeat(40) }, { unsigned: false },
    { artifacts: {} }, { artifacts: { [filename]: { ...digest, size: 0 } } },
    { artifacts: { [filename]: { ...digest, sha256: 'changed' } } },
  ])('refuses another build or incomplete original hashes %j', (changed) => {
    expect(() => museAcceptanceArtifact({ ...record, ...changed }, identity, filename)).toThrow()
  })

  it('compares all application files while allowing only generated Windows uninstaller files', () => {
    const payload = { 'muse-med.exe': '8:abc', 'resources/app.asar': '20:def' }
    expect(() => { assertMuseInstalledPayload(payload, { ...payload, 'Uninstall muse-med.exe': '4:generated' }, 'win-x64') }).not.toThrow()
    expect(() => { assertMuseInstalledPayload(payload, { ...payload, 'Uninstall muse-med.exe': '4:generated' }, 'mac-arm64') }).toThrow()
    expect(() => { assertMuseInstalledPayload(payload, { ...payload, 'resources/app.asar': '20:changed' }, 'win-x64') }).toThrow()
    expect(() => { assertMuseInstalledPayload(payload, { 'muse-med.exe': '8:abc' }, 'win-x64') }).toThrow()
    expect(() => { assertMuseInstalledPayload(payload, { ...payload, 'unexpected.txt': '1:x' }, 'win-x64') }).toThrow()
    expect(() => { assertMuseInstalledPayload({}, {}, 'win-x64') }).toThrow()
  })

  it('requires installer licenses with the exact bytes from the builder-selected 7-Zip directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-installer-licenses-'))
    try {
      const tool = join(directory, 'sevenzip', 'bin', '7za.exe')
      await mkdir(join(directory, 'sevenzip', 'bin'), { recursive: true })
      const input = { 'LICENSE.txt': '7-Zip license\r\n', COPYING: 'LGPL license\n' }
      for (const [name, bytes] of Object.entries(input)) await writeFile(join(directory, 'sevenzip', name), bytes)
      const licenses = await museAcceptanceWindowsLicenses(tool)
      expect(licenses).toEqual(Object.fromEntries(Object.entries(input).map(([name, bytes]) => [
        `7zip-installer-${name === 'COPYING' ? 'COPYING.txt' : name}`,
        `${Buffer.byteLength(bytes)}:${createHash('sha256').update(bytes).digest('hex')}`,
      ])))
      const payload = { 'muse-med.exe': '8:application', ...licenses }
      expect(() => { assertMuseInstalledPayload(payload, payload, 'win-x64') }).not.toThrow()
      expect(() => { assertMuseInstalledPayload(payload, { ...payload, '7zip-installer-LICENSE.txt': '1:changed' }, 'win-x64') }).toThrow()
      expect(() => { assertMuseInstalledPayload(payload, { 'muse-med.exe': '8:application' }, 'win-x64') }).toThrow()
      await writeFile(join(directory, 'sevenzip', 'COPYING'), '')
      await expect(museAcceptanceWindowsLicenses(tool)).rejects.toThrow('empty 7-Zip license')
      await rm(join(directory, 'sevenzip', 'COPYING'))
      await expect(museAcceptanceWindowsLicenses(tool)).rejects.toThrow('ENOENT')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects runtime additions, removals and modifications anywhere in the installed application', () => {
    const installed = { 'Contents/Resources/app.asar': '20:application', 'Contents/Frameworks/Current': 'link:A' }
    expect(() => { assertMuseInstalledUnchanged(installed, { ...installed }) }).not.toThrow()
    const modifications: Readonly<Record<string, string>>[] = [
      { ...installed, 'Contents/dsh-panel': '228:generated' },
      { ...installed, 'Contents/Resources/app.asar': '20:changed' },
      { ...installed, 'Contents/Frameworks/Current': 'link:B' },
      { 'Contents/Resources/app.asar': '20:application' },
    ]
    for (const modified of modifications) {
      expect(() => { assertMuseInstalledUnchanged(installed, modified) }).toThrow('changed during smoke')
    }
  })
})
