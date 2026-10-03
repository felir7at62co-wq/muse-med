/** Muse product versions and numbered test builds used by packaging and updates. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'semver'

/**
 * Read the product release independently from the harness package manifests.
 * @param {string} appRoot - Desktop application directory containing muse-product.json.
 * @returns {string} Exact semver product version without build metadata.
 */
export function readDesktopProductVersion(appRoot = fileURLToPath(new URL('..', import.meta.url))) {
  return readDesktopProductConfig(appRoot).version
}

/**
 * Read the Muse release and its explicit legacy updater discovery requirement.
 * @param {string} appRoot - Desktop directory containing muse-product.json.
 * @returns {{ version: string, legacyRcDiscovery: boolean }} Product release settings.
 */
export function readDesktopProductConfig(appRoot = fileURLToPath(new URL('..', import.meta.url))) {
  const path = join(appRoot, 'muse-product.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof config !== 'object' || config === null || Array.isArray(config) || typeof config.version !== 'string') {
    throw new Error(`desktop product version: ${path} must declare a version string`)
  }
  const product = parseVersion(config.version, 'product version')
  if (product.version !== config.version) throw new Error(`desktop product version: ${path} must declare an exact version`)
  if (config.legacyRcDiscovery !== undefined && typeof config.legacyRcDiscovery !== 'boolean') {
    throw new Error(`desktop product version: ${path} legacyRcDiscovery must be a boolean`)
  }
  if (config.legacyRcDiscovery === true && product.prerelease.length > 0 && product.prerelease[0] !== 'beta') {
    throw new Error(`desktop product version: ${path} legacyRcDiscovery requires a stable or beta release`)
  }
  return { version: product.version, legacyRcDiscovery: config.legacyRcDiscovery === true }
}

/** Environment variable that carries the build version through one packaging and upload run. */
export const DESKTOP_BUILD_VERSION_ENV = 'DSH_DESKTOP_BUILD_VERSION'

/** Prerelease field that opens a test build's suffix on a stable product version. */
const STABLE_TEST_FIELD = 'test'

/**
 * Parse a version the updater would accept.
 * @param {string} version - Version to read.
 * @param {string} label - Description used in failures.
 * @returns {import('semver').SemVer} The parsed version.
 */
function parseVersion(version, label) {
  const parsed = parse(version, { loose: false })
  if (parsed === null) throw new Error(`desktop build version: ${label} ${version} is not a version`)
  if (parsed.build.length > 0) {
    // Build metadata does not participate in precedence, so two builds would compare equal to the updater.
    throw new Error(`desktop build version: ${label} ${version} cannot carry build metadata`)
  }
  return parsed
}

/**
 * The prerelease fields every build version for one product version starts with.
 * @param {import('semver').SemVer} product - Parsed product version.
 * @returns {readonly (string | number)[]} Fields a build version must repeat before its date.
 */
function requiredFields(product) {
  return product.prerelease.length === 0 ? [STABLE_TEST_FIELD] : product.prerelease
}

/**
 * Validate a build version against the product version it extends.
 * @param {string} buildVersion - Version this build publishes.
 * @param {string} productVersion - Version muse-product.json declares.
 * @returns {string} The version as semver normalizes it, which is what the artifacts will carry.
 */
export function validateDesktopBuildVersion(buildVersion, productVersion) {
  const build = parseVersion(buildVersion, 'build version')
  const product = parseVersion(productVersion, 'product version')
  if (build.version === product.version) return build.version
  if (build.compareMain(product) !== 0) {
    throw new Error(`desktop build version: ${buildVersion} must extend product version ${productVersion}`)
  }
  const required = requiredFields(product)
  const extendsProduct = build.prerelease.length > required.length
    && required.every((field, index) => build.prerelease[index] === field)
  if (!extendsProduct) {
    throw new Error(`desktop build version: ${buildVersion} must extend ${productVersion} as ${
      desktopBuildVersionPrefix(productVersion)}<date>.<sequence>`)
  }
  return build.version
}

/**
 * Resolve the version a build publishes.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string} productVersion - Version muse-product.json declares.
 * @returns {string} The build version when one is present, otherwise the product version.
 */
export function resolveDesktopBuildVersion(env, productVersion) {
  const buildVersion = env[DESKTOP_BUILD_VERSION_ENV]?.trim()
  if (buildVersion === undefined || buildVersion === '') return productVersion
  return validateDesktopBuildVersion(buildVersion, productVersion)
}

/**
 * Everything a build version carries before its date, including the trailing separator.
 * @param {string} productVersion - Version muse-product.json declares.
 * @returns {string} The prefix shared by every build version of that product version.
 */
export function desktopBuildVersionPrefix(productVersion) {
  const product = parseVersion(productVersion, 'product version')
  const [release] = product.version.split('-')
  return `${release}-${requiredFields(product).join('.')}.`
}
