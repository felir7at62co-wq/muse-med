/** Verify a published GitHub release against the channel its own packaged build requests. */

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopUpdateChannel, resolveDesktopGitHubUpdateConfig } from './desktop-auto-update-environment.mjs'
import { readDesktopProductConfig } from './desktop-build-version.mjs'
import {
  desktopGitHubReleaseRequirements,
  isDesktopGitHubPackagedChannel,
  validateDesktopGitHubRelease,
} from './github-update-feed-readback.mjs'

const APP_ROOT = join(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'))
const { GitHubProvider } = updaterRequire('electron-updater/out/providers/GitHubProvider.js')
const { HttpExecutor } = updaterRequire('builder-util-runtime')
const semver = require('semver')
const { load } = updaterRequire('js-yaml')

/** Node transport for the shared executor; electron-updater ships only the Electron one. */
class NodeHttpExecutor extends HttpExecutor {
  createRequest(options, callback) {
    return (options.protocol === 'http:' ? httpRequest : httpsRequest)(options, callback)
  }
}

const { values } = parseArgs({ options: {
  version: { type: 'string' },
  'expected-version': { type: 'string' },
  config: { type: 'string' },
  'negative-control': { type: 'boolean', default: true },
}, allowPositionals: false })

const product = readDesktopProductConfig(APP_ROOT)
const version = values.version ?? product.version
const configPath = values.config ?? join(import.meta.dirname, '../.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/resources/app-update.yml')

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Resolve the newest release through the real provider, mirroring the coordinator's updater settings. */
async function resolveLatest({ owner, repo, channel, channelOverride }) {
  const provider = new GitHubProvider({ provider: 'github', owner, repo, channel },
    { channel: channelOverride ?? null, allowPrerelease: semver.prerelease(version) !== null,
      currentVersion: semver.parse(version), fullChangelog: false },
    { executor: new NodeHttpExecutor(), platform: 'win32', isUseMultipleRangeRequest: false })
  return provider.getLatestVersion()
}

let update
let resolved
let config
try {
  if (!existsSync(configPath)) throw new Error(`packaged update configuration is missing: ${configPath}`)
  config = load(readFileSync(configPath, 'utf8'))
  console.log(`version ${version}  channel ${desktopUpdateChannel(version)}  provider ${config.provider} ${config.owner}/${config.repo}  config ${configPath}`)
  check(config.provider === 'github', 'packaged update source is the GitHub provider')
  check(isDesktopGitHubPackagedChannel(version, config.channel),
    'packaged channel matches this version', `recorded ${config.channel}, derived ${desktopUpdateChannel(version)}`)
  const expected = resolveDesktopGitHubUpdateConfig(version)
  check(config.owner === expected.owner && config.repo === expected.repo,
    'packaged release repository matches the product', `${config.owner}/${config.repo}`)

  resolved = await resolveLatest({ owner: config.owner, repo: config.repo, channel: config.channel })
  console.log(`provider resolved tag ${resolved.tag} version ${resolved.version}`)
  check(semver.valid(resolved.version) !== null, 'published channel file carries a semantic version', resolved.version)
  check(semver.gte(resolved.version, version), 'published version is not below the packaged version', `${resolved.version} >= ${version}`)
  if (values['expected-version'] !== undefined) {
    check(resolved.version === values['expected-version'], 'installed client discovers the intended release',
      `${resolved.version} === ${values['expected-version']}`)
  }

  if (values['negative-control']) {
    let rejected = false
    let reason = 'a forced nightly channel still resolved an update, so this check cannot detect the regression'
    try {
      await resolveLatest({ owner: config.owner, repo: config.repo, channel: config.channel, channelOverride: 'nightly' })
    } catch (error) {
      rejected = true
      reason = error.message.split('\n')[0]
    }
    check(rejected, 'negative control: a hardcoded channel fails against this release', reason)
  }

  const requirements = desktopGitHubReleaseRequirements(resolved.version, product.legacyRcDiscovery)
  check(requirements.tags.includes(resolved.tag), 'provider selects a required discovery release', resolved.tag)
  let installer
  for (const tag of requirements.tags) {
    const release = await (await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/releases/tags/${tag}`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'muse-med-update-feed-check' } })).json()
    if (!Array.isArray(release.assets)) throw new Error(`release ${tag} is not published: ${JSON.stringify(release.message ?? release)}`)
    const names = release.assets.map(asset => asset.name)
    console.log(`release ${tag} assets: ${names.join(', ')}`)
    const metadata = {}
    for (const filename of requirements.metadataFilenames) {
      const asset = release.assets.find(entry => entry.name === filename)
      if (asset === undefined) continue
      const response = await fetch(asset.browser_download_url)
      if (!response.ok) throw new Error(`cannot read ${tag}/${filename}: HTTP ${response.status}`)
      metadata[filename] = load(await response.text())
    }
    installer = validateDesktopGitHubRelease({
      version: resolved.version, legacyRcDiscovery: product.legacyRcDiscovery,
      assetNames: names, metadata, updaterInfo: resolved,
    })
    check(true, `release ${tag} publishes identical genuine version metadata and required update assets`,
      requirements.metadataFilenames.join(', '))
  }

  const local = join(import.meta.dirname, `../.desktop-build/targets/win-x64/unsigned-artifacts/${installer}`)
  if (existsSync(local)) {
    const digest = createHash('sha512').update(readFileSync(local)).digest('base64')
    check(digest === resolved.files?.[0]?.sha512, 'channel file SHA512 matches the built installer')
  }
} catch (error) {
  check(false, 'update feed verification', error.message)
}

if (failures.length > 0) {
  console.error(`verify-github-update-feed: ${failures.length} check(s) failed`)
  process.exitCode = 1
} else console.log('verify-github-update-feed: every check passed')
