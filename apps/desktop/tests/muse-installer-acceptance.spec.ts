/** Identity and full-payload rejection checks for native installer qualification. */
import { describe, expect, it } from 'vitest'
import { assertMuseInstalledIdentity, assertMuseInstalledPayload, museAcceptanceArtifact } from '../scripts/muse-installer-acceptance.ts'

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
})
