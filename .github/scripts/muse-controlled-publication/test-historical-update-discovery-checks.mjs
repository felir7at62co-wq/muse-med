/** Offline acceptance and rejection cases for historical app discovery. */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { validateHistoricalDiscovery } from './historical-update-discovery-checks.mjs'

const expectedVersion = '1.0.3'
const expected = { version: expectedVersion, files: [{ url: 'muse-med-1.0.3-win-x64.exe', sha512: 'verified-final-installer', size: 765555705 }],
  path: 'muse-med-1.0.3-win-x64.exe', sha512: 'verified-final-installer' }
function check({ firstTag = 'v1.0.3', tag = firstTag, installedVersion = '1.0.1', changes = {} } = {}) {
  return validateHistoricalDiscovery({ installedVersion, expectedVersion, firstTag, expected, result: { ...structuredClone(expected), tag, ...changes } })
}
check()
check({ firstTag: 'v1.0.3-rc.muse-stable' })
check({ installedVersion: '0.1.7-rc.8.20260930.1', tag: 'v1.0.3-rc.muse-stable' })
assert.throws(() => check({ firstTag: 'hongguo-source-runtime-9869b8571b45', tag: 'v1.0.3' }), /First Atom entry/u)
assert.throws(() => check({ firstTag: 'v2.0.0' }), /First Atom entry/u)
assert.throws(() => check({ tag: 'v2.0.0' }), /foreign app release/u)
assert.throws(() => check({ firstTag: 'v1.0.3-rc.muse-stable', tag: 'v1.0.3' }), /select the first/u)
assert.throws(() => check({ changes: { version: '1.0.4' } }), /intended genuine app version/u)
assert.throws(() => check({ changes: { files: [{ ...expected.files[0], sha512: 'different' }] } }), /sha512 differs/u)
assert.throws(() => check({ changes: { files: [{ ...expected.files[0], size: 1 }] } }), /size differs/u)
assert.throws(() => check({ changes: { files: [{ ...expected.files[0], url: 'foreign.exe' }] } }), /url differs/u)
assert.throws(() => check({ installedVersion: '0.1.7-rc.8.20260930.1' }), /matching RC discovery tag/u)
console.log('PASS 3 genuine app-discovery acceptance cases and 9 invalid first-tag, version, installer, or RC-route rejection cases')

const require = createRequire(join(process.cwd(), 'apps/desktop/package.json'))
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'))
const { GitHubProvider } = updaterRequire('electron-updater/out/providers/GitHubProvider.js')
const { HttpExecutor } = updaterRequire('builder-util-runtime')
const semver = updaterRequire('semver')
class FixtureExecutor extends HttpExecutor {
  constructor(tags) { super(); this.tags = tags }
  async request(options) {
    const path = new URL(options.path, 'https://github.com').pathname
    if (path.endsWith('.atom')) return `<feed xmlns="http://www.w3.org/2005/Atom">${this.tags.map(tag =>
      `<entry><title>${tag}</title><link href="https://github.com/felir7at62co-wq/muse-med/releases/tag/${tag}"/><content>Application release</content></entry>`).join('')}</feed>`
    if (path.endsWith('/latest.yml') || path.endsWith('/rc.yml')) return JSON.stringify(expected)
    throw new Error(`No fixture metadata for ${path}`)
  }
}
function fixture(installedVersion, tags, channelOverride = null) {
  return new GitHubProvider({ provider: 'github', owner: 'felir7at62co-wq', repo: 'muse-med',
    channel: installedVersion === '1.0.1' ? 'latest' : 'rc' },
  { channel: channelOverride, allowPrerelease: true, currentVersion: semver.parse(installedVersion), fullChangelog: false },
  { executor: new FixtureExecutor(tags), platform: 'win32', isUseMultipleRangeRequest: false })
}
for (const firstTag of ['v1.0.3', 'v1.0.3-rc.muse-stable']) {
  const tags = [firstTag, ...['v1.0.3', 'v1.0.3-rc.muse-stable'].filter(tag => tag !== firstTag), 'hongguo-source-runtime-9869b8571b45']
  const stable = await fixture('1.0.1', tags).getLatestVersion()
  validateHistoricalDiscovery({ installedVersion: '1.0.1', expectedVersion, firstTag, result: stable, expected })
  assert.equal(stable.tag, firstTag)
  const installedVersion = '0.1.7-rc.8.20260930.1'
  const rc = await fixture(installedVersion, tags).getLatestVersion()
  validateHistoricalDiscovery({ installedVersion, expectedVersion, firstTag, result: rc, expected })
  assert.equal(rc.tag, 'v1.0.3-rc.muse-stable')
  for (const version of ['1.0.1', installedVersion]) {
    await assert.rejects(fixture(version, tags, 'nightly').getLatestVersion(), error => error.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')
  }
}
for (const firstTag of ['hongguo-source-runtime-9869b8571b45', 'v2.0.0']) {
  const result = await fixture('1.0.1', [firstTag, 'v1.0.3', 'v1.0.3-rc.muse-stable']).getLatestVersion()
  assert.throws(() => validateHistoricalDiscovery({ installedVersion: '1.0.1', expectedVersion, firstTag, result, expected }), /First Atom entry/u)
}
console.log(`PASS actual updater 6.8.9 with own semver ${updaterRequire('semver/package.json').version}: both app-first orders, genuine RC selection, four exact nightly rejections, and auxiliary/foreign first-entry rejections`)
