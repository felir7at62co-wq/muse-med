/** Offline validation of GitHub update assets and legacy discovery metadata. */

import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { desktopUpdateChannel } from './desktop-auto-update-environment.mjs'

/**
 * List the release tags and Windows metadata files required by a published version.
 * @param {string} version - Genuine product version from update metadata.
 * @param {boolean} legacyRcDiscovery - Whether beta releases must support the released rc clients.
 * @returns {{ tags: string[], metadataFilenames: string[] }} Required discovery tags and channel assets.
 */
export function desktopGitHubReleaseRequirements(version, legacyRcDiscovery) {
  const channel = desktopUpdateChannel(version)
  if (!legacyRcDiscovery || channel !== 'beta') {
    return { tags: [`v${version}`], metadataFilenames: [`${channel}.yml`] }
  }
  const [release, ...prerelease] = version.split('-')
  return {
    tags: [`v${version}`, `v${release}-rc.muse-${prerelease.join('-')}`],
    metadataFilenames: [`${channel}.yml`, 'rc.yml', 'latest.yml'],
  }
}

/**
 * Recognize a version's channel, including both configurations shipped in rc.7 and rc.8.
 * @param {string} version - Installed application's version.
 * @param {unknown} channel - Channel read from its packaged app-update.yml.
 * @returns {boolean} Whether the channel belongs to that installed version.
 */
export function isDesktopGitHubPackagedChannel(version, channel) {
  return channel === desktopUpdateChannel(version)
    || (channel === 'latest' && ['0.1.7-rc.7', '0.1.7-rc.8'].includes(version))
}

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`GitHub update feed: ${label} metadata must be an object`)
  }
  return value
}

function updateIdentity(info) {
  return Object.fromEntries(['version', 'files', 'path', 'sha512', 'size']
    .filter(field => info[field] !== undefined).map(field => [field, info[field]]))
}

/**
 * Validate all required release assets and identical channel metadata against the real provider's result.
 * @param {{ version: string, legacyRcDiscovery: boolean, assetNames: readonly string[], metadata: Record<string, unknown>, updaterInfo: unknown }} publication - Downloaded release assets, parsed YAML, and resolved updater metadata.
 * @returns {string} Installer filename whose installer and blockmap assets exist in the release.
 * @throws {Error} When required assets are absent, undeclared channels exist, or metadata differs.
 */
export function validateDesktopGitHubRelease(publication) {
  const { version, legacyRcDiscovery, assetNames, metadata, updaterInfo } = publication
  const { metadataFilenames } = desktopGitHubReleaseRequirements(version, legacyRcDiscovery)
  for (const filename of metadataFilenames) {
    if (!assetNames.includes(filename)) throw new Error(`GitHub update feed: missing release asset ${filename}`)
  }
  const allowedMetadataFilenames = [...metadataFilenames,
    ...metadataFilenames.map(filename => filename.replace(/\.yml$/u, '-mac.yml'))]
  const unexpected = assetNames.filter(name => name.endsWith('.yml') && !allowedMetadataFilenames.includes(name))
  if (unexpected.length > 0) throw new Error(`GitHub update feed: unexpected channel files ${unexpected.join(', ')}`)
  const canonical = object(metadata[metadataFilenames[0]], metadataFilenames[0])
  for (const filename of metadataFilenames) {
    const info = object(metadata[filename], filename)
    if (info.version !== version) {
      throw new Error(`GitHub update feed: ${filename} version must be ${version}, received ${String(info.version)}`)
    }
    if (!isDeepStrictEqual(info, canonical)) {
      throw new Error(`GitHub update feed: ${filename} metadata differs from ${metadataFilenames[0]}`)
    }
  }
  if (!isDeepStrictEqual(updateIdentity(object(updaterInfo, 'provider')), updateIdentity(canonical))) {
    throw new Error('GitHub update feed: provider resolved different update metadata')
  }
  if (!Array.isArray(canonical.files) || canonical.files.length !== 1) {
    throw new Error(`GitHub update feed: ${metadataFilenames[0]} metadata must name exactly one installer`)
  }
  const file = object(canonical.files[0], `${metadataFilenames[0]}.files[0]`)
  if (typeof file.url !== 'string' || file.url === '' || basename(file.url) !== file.url
    || typeof file.sha512 !== 'string' || file.sha512 === ''
    || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error(`GitHub update feed: ${metadataFilenames[0]} installer metadata must include a filename, SHA512, and positive size`)
  }
  for (const filename of [file.url, `${file.url}.blockmap`]) {
    if (!assetNames.includes(filename)) throw new Error(`GitHub update feed: missing release asset ${filename}`)
  }
  return file.url
}
