import { describe, expect, it } from 'vitest'
import {
  desktopGitHubReleaseRequirements,
  isDesktopGitHubPackagedChannel,
  validateDesktopGitHubRelease,
} from '../scripts/github-update-feed-readback.mjs'

const VERSION = '1.0.0-beta.1'
const INSTALLER = `muse-med-${VERSION}-win-x64.exe`
const metadata = {
  version: VERSION,
  files: [{ url: INSTALLER, sha512: 'installer-sha512', size: 123 }],
  path: INSTALLER,
  sha512: 'installer-sha512',
  releaseDate: '2026-09-30T00:00:00.000Z',
}

function release() {
  return {
    version: VERSION,
    legacyRcDiscovery: true,
    assetNames: [INSTALLER, `${INSTALLER}.blockmap`, 'beta.yml', 'rc.yml', 'latest.yml'],
    metadata: {
      'beta.yml': structuredClone(metadata),
      'rc.yml': structuredClone(metadata),
      'latest.yml': structuredClone(metadata),
    },
    updaterInfo: structuredClone(metadata),
  }
}

describe('GitHub update feed readback', () => {
  it('requires the genuine stable release and an rc discovery alias with identical channel metadata', () => {
    expect(desktopGitHubReleaseRequirements('1.0.0', true)).toEqual({
      tags: ['v1.0.0', 'v1.0.0-rc.muse-stable'], metadataFilenames: ['latest.yml', 'rc.yml'],
    })
  })
  it('requires product and legacy discovery releases with genuine beta metadata', () => {
    expect(desktopGitHubReleaseRequirements(VERSION, true)).toEqual({
      tags: ['v1.0.0-beta.1', 'v1.0.0-rc.muse-beta.1'],
      metadataFilenames: ['beta.yml', 'rc.yml', 'latest.yml'],
    })
    expect(validateDesktopGitHubRelease(release())).toBe(INSTALLER)
  })

  it('keeps ordinary releases on their own channel', () => {
    expect(desktopGitHubReleaseRequirements(VERSION, false)).toEqual({
      tags: ['v1.0.0-beta.1'], metadataFilenames: ['beta.yml'],
    })
    expect(desktopGitHubReleaseRequirements('0.1.7-rc.8', true)).toEqual({
      tags: ['v0.1.7-rc.8'], metadataFilenames: ['rc.yml'],
    })
  })

  it.each(['rc.yml', 'latest.yml'])('rejects a missing compatibility alias %s', (filename) => {
    const publication = release()
    publication.assetNames = publication.assetNames.filter(name => name !== filename)
    expect(() => validateDesktopGitHubRelease(publication)).toThrow(new RegExp(filename.replace('.', '\\.')))
  })

  it('rejects an undeclared channel file', () => {
    const publication = release()
    publication.assetNames.push('nightly.yml')
    expect(() => validateDesktopGitHubRelease(publication)).toThrow(/unexpected channel.*nightly.yml/u)
  })

  it('accepts Mac channel assets published alongside the Windows metadata', () => {
    const publication = release()
    publication.assetNames.push('beta-mac.yml', 'rc-mac.yml', 'latest-mac.yml')
    expect(validateDesktopGitHubRelease(publication)).toBe(INSTALLER)
  })

  it('rejects an undeclared Mac channel file', () => {
    const publication = release()
    publication.assetNames.push('nightly-mac.yml')
    expect(() => validateDesktopGitHubRelease(publication)).toThrow(/unexpected channel.*nightly-mac.yml/u)
  })

  it.each(['rc.yml', 'latest.yml'] as const)('rejects a false version in %s', (filename) => {
    const publication = release()
    publication.metadata[filename].version = '1.0.0'
    expect(() => validateDesktopGitHubRelease(publication)).toThrow(/version.*1.0.0-beta.1/u)
  })

  it.each(['url', 'sha512', 'size'] as const)('rejects an alias with different file %s', (field) => {
    const publication = release()
    Object.assign(publication.metadata['latest.yml'].files[0]!, { [field]: field === 'size' ? 124 : 'different' })
    expect(() => validateDesktopGitHubRelease(publication)).toThrow(/latest.yml.*metadata/u)
  })

  it.each(['path', 'sha512'] as const)('rejects an alias with different top level %s', (field) => {
    const publication = release()
    publication.metadata['rc.yml'][field] = 'different'
    expect(() => validateDesktopGitHubRelease(publication)).toThrow(/rc.yml.*metadata/u)
  })

  it('accepts metadata without deprecated top level path and hash', () => {
    const publication = release()
    for (const entry of [publication.updaterInfo, ...Object.values(publication.metadata)]) {
      Reflect.deleteProperty(entry, 'path')
      Reflect.deleteProperty(entry, 'sha512')
    }
    expect(validateDesktopGitHubRelease(publication)).toBe(INSTALLER)
  })

  it('rejects channel files that differ from the metadata the provider resolved', () => {
    const publication = release()
    publication.updaterInfo.files[0]!.sha512 = 'different'
    expect(() => validateDesktopGitHubRelease(publication)).toThrow(/provider.*metadata/u)
  })

  it.each([INSTALLER, `${INSTALLER}.blockmap`])('rejects a missing release binary %s', (filename) => {
    const publication = release()
    publication.assetNames = publication.assetNames.filter(name => name !== filename)
    expect(() => validateDesktopGitHubRelease(publication)).toThrow(/missing release asset/u)
  })

  it.each(['0.1.7-rc.7', '0.1.7-rc.8'])('accepts both packaged historical channels for %s', (version) => {
    expect(isDesktopGitHubPackagedChannel(version, 'rc')).toBe(true)
    expect(isDesktopGitHubPackagedChannel(version, 'latest')).toBe(true)
    expect(isDesktopGitHubPackagedChannel(version, 'nightly')).toBe(false)
  })

  it('requires the product beta channel for new packages', () => {
    expect(isDesktopGitHubPackagedChannel(VERSION, 'beta')).toBe(true)
    expect(isDesktopGitHubPackagedChannel(VERSION, 'latest')).toBe(false)
    expect(isDesktopGitHubPackagedChannel('0.1.7-rc.6', 'latest')).toBe(false)
  })
})
