/** Write and verify the updater configuration sealed into a macOS application. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

const CONFIG_FILENAME = 'app-update.yml'
const CHANNEL = 'nightly'

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop macOS update config: ${label} must be an object`)
  }
  return value
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop macOS update config: ${label} must be a non-empty string`)
  }
  return value
}

/**
 * Resolve the macOS feed from the final electron-builder configuration.
 * @param {unknown} publish - Final electron-builder publish setting.
 * @returns {{ publicUrl: string } | { provider: 'github', owner: string, repo: string, channel: string }} Resolved feed used by the packaged App.
 */
export function resolveMacOSAppUpdateFeed(publish) {
  if (!Array.isArray(publish) || publish.length !== 1) {
    throw new Error('desktop macOS update config: publish must contain exactly one provider')
  }
  const provider = object(publish[0], 'publish provider')
  if (provider.provider === 'github') return {
    provider: 'github',
    owner: nonEmptyString(provider.owner, 'GitHub owner'),
    repo: nonEmptyString(provider.repo, 'GitHub repository'),
    channel: nonEmptyString(provider.channel, 'GitHub channel'),
  }
  if (provider.provider !== 'generic' || provider.channel !== CHANNEL) {
    throw new Error('desktop macOS update config: publish provider must be generic Nightly')
  }
  return { publicUrl: nonEmptyString(provider.url, 'publish provider URL') }
}

/**
 * Create the electron-updater configuration embedded before code signing.
 * @param {{ publicUrl: string } | { provider: 'github', owner: string, repo: string, channel: string }} update - Resolved update feed.
 * @param {string} updaterCacheDirName - electron-builder application cache directory.
 * @returns {object} Selected provider fields and the application updater cache directory.
 */
export function createMacOSAppUpdateConfig(update, updaterCacheDirName) {
  const feed = 'provider' in update ? {
    provider: 'github',
    owner: nonEmptyString(update.owner, 'GitHub owner'),
    repo: nonEmptyString(update.repo, 'GitHub repository'),
    channel: nonEmptyString(update.channel, 'GitHub channel'),
  } : {
    provider: 'generic',
    url: nonEmptyString(update.publicUrl, 'public URL'),
    channel: CHANNEL,
  }
  return { ...feed, updaterCacheDirName: nonEmptyString(updaterCacheDirName, 'updater cache directory') }
}

/**
 * Write the updater configuration into an assembled App before signing.
 * @param {string} resourcesDir - App Contents/Resources directory.
 * @param {{ publicUrl: string } | { provider: 'github', owner: string, repo: string, channel: string }} update - Resolved update feed.
 * @param {string} updaterCacheDirName - electron-builder application cache directory.
 * @returns {Promise<void>} Resolves after the configuration is durable.
 */
export async function writeMacOSAppUpdateConfig(resourcesDir, update, updaterCacheDirName) {
  const config = createMacOSAppUpdateConfig(update, updaterCacheDirName)
  await writeFile(join(resourcesDir, CONFIG_FILENAME), dump(config, { lineWidth: -1, noRefs: true }))
}

/**
 * Verify the updater configuration inside an assembled macOS App.
 * @param {string} appPath - Application bundle path.
 * @param {{ publicUrl: string } | { provider: 'github', owner: string, repo: string, channel: string }} update - Expected update feed.
 * @param {string | undefined} updaterCacheDirName - Exact cache directory when known.
 * @returns {Promise<void>} Resolves when the packaged configuration matches the release destination.
 */
export async function verifyMacOSAppUpdateConfig(appPath, update, updaterCacheDirName = undefined) {
  const path = join(appPath, 'Contents', 'Resources', CONFIG_FILENAME)
  let parsed
  try {
    parsed = load(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`desktop macOS update config: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = object(parsed, CONFIG_FILENAME)
  const actualCacheDirName = nonEmptyString(config.updaterCacheDirName, `${CONFIG_FILENAME}.updaterCacheDirName`)
  const expected = createMacOSAppUpdateConfig(update, actualCacheDirName)
  if (Object.entries(expected).some(([name, value]) => config[name] !== value)) {
    throw new Error(`desktop macOS update config: ${path} does not match the selected release feed`)
  }
  if (updaterCacheDirName !== undefined && actualCacheDirName !== updaterCacheDirName) {
    throw new Error(`desktop macOS update config: ${path} has updater cache directory ${actualCacheDirName}; expected ${updaterCacheDirName}`)
  }
}
