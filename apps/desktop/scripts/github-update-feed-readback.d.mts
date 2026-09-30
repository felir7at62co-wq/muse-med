/** Offline validation of GitHub update assets and legacy discovery metadata. */

/**
 * List the release tags and Windows metadata files required by a published version.
 * @param version - Genuine product version from update metadata.
 * @param legacyRcDiscovery - Whether beta releases must support the released rc clients.
 * @returns Required discovery tags and channel assets.
 */
export function desktopGitHubReleaseRequirements(version: string, legacyRcDiscovery: boolean): {
  readonly tags: readonly string[]
  readonly metadataFilenames: readonly string[]
}

/**
 * Recognize a version's channel, including both configurations shipped in rc.7 and rc.8.
 * @param version - Installed application's version.
 * @param channel - Channel read from its packaged app-update.yml.
 * @returns Whether the channel belongs to that installed version.
 */
export function isDesktopGitHubPackagedChannel(version: string, channel: unknown): boolean

/**
 * Validate all required release assets and identical channel metadata against the real provider's result.
 * @param publication - Downloaded release assets, parsed YAML, and resolved updater metadata.
 * @returns Installer filename whose installer and blockmap assets exist in the release.
 * @throws When required assets are absent, undeclared channels exist, or metadata differs.
 */
export function validateDesktopGitHubRelease(publication: {
  readonly version: string
  readonly legacyRcDiscovery: boolean
  readonly assetNames: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
  readonly updaterInfo: unknown
}): string
