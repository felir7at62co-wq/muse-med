/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV: 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/** Supported Desktop update deployment. */
export type DesktopAutoUpdateEnvironment = 'test' | 'production'

/** Directory name of one supported Desktop release target. */
export type DesktopAutoUpdateTarget = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** Public updater URL for one release target. */
export interface DesktopAutoUpdateConfig {
  readonly environment: DesktopAutoUpdateEnvironment
  readonly target: DesktopAutoUpdateTarget
  readonly origin: string
  readonly publicUrl: string
  readonly keyPrefix: string
}

/** Public updater URL and private COS destination for one upload target. */
export interface DesktopUploadConfig extends DesktopAutoUpdateConfig {
  readonly bucket: string
  readonly secretIdEnvName: string
  readonly secretKeyEnvName: string
}

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param env - Packaging or upload environment.
 * @returns Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(
  env: NodeJS.ProcessEnv,
): DesktopAutoUpdateEnvironment

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(
  platform: NodeJS.Platform,
  arch: string,
): DesktopAutoUpdateTarget

/**
 * Return the local completion record filename for one packaged target.
 * @param target - Supported release target.
 * @returns Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target: DesktopAutoUpdateTarget): string

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param version - Desktop semantic version.
 * @param platform - Target platform.
 * @returns Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(
  version: string,
  platform: NodeJS.Platform,
): string

/** electron-builder publish entry that records the GitHub Releases update source. */
export interface DesktopGitHubUpdateConfig {
  readonly provider: 'github'
  readonly owner: string
  readonly repo: string
}

/**
 * Resolve the GitHub Releases publish target that packaging records for the updater.
 *
 * electron-builder writes the resolved entry into the packaged `resources/app-update.yml`,
 * which is the Desktop updater's activation switch (`src/update-coordinator.ts`), so every
 * target records it, including `--unsigned`. An unsigned build records no `publisherName`,
 * and electron-updater skips the update package's Authenticode check without one.
 * @returns electron-builder publish entry for GitHub Releases.
 */
export function resolveDesktopGitHubUpdateConfig(): DesktopGitHubUpdateConfig

/**
 * Resolve the public updater URL for one release target.
 *
 * Packaging records the GitHub Releases source instead; this resolver serves the retained
 * Tencent COS upload chain and the signed target's completion record.
 * @param env - Packaging or upload environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Resolved updater configuration.
 * @throws When the test deployment lacks a valid HTTPS origin.
 */
export function resolveDesktopAutoUpdateConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopAutoUpdateConfig

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param env - Upload environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Resolved upload configuration.
 * @throws When the selected deployment lacks a required origin or bucket, or the test origin is not HTTPS.
 */
export function resolveDesktopUploadConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopUploadConfig
