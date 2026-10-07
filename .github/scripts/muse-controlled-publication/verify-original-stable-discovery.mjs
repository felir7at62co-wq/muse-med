/** Read actual historical GitHub settings using the released coordinator's updater policy. */

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { validateHistoricalDiscovery } from './historical-update-discovery-checks.mjs'

const require = createRequire(join(process.cwd(), 'apps/desktop/package.json'))
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'))
const { GitHubProvider } = updaterRequire('electron-updater/out/providers/GitHubProvider.js')
const { HttpExecutor, parseXml } = updaterRequire('builder-util-runtime')
const { load } = updaterRequire('js-yaml')
const semver = updaterRequire('semver')
const { values } = parseArgs({ options: {
  config: { type: 'string' },
  receipt: { type: 'string' },
  metadata: { type: 'string' },
  installer: { type: 'string' },
  'expected-version': { type: 'string', default: '1.0.3' },
}, allowPositionals: false })
if (values.config === undefined || values.receipt === undefined || values.metadata === undefined || values.installer === undefined) {
  throw new Error('Actual extracted config/receipt and final installer/metadata paths are required')
}

const receipt = JSON.parse(readFileSync(values.receipt, 'utf8'))
const configBytes = readFileSync(values.config)
const config = load(configBytes.toString('utf8'))
const version = receipt.packagedVersion
const expectedVersion = values['expected-version']
const historical = {
  '1.0.1': { tag: 'v1.0.1', channel: 'latest', sha256: '7fc7333d52573041aa65e6d7be9f28f8542f3f544a19d7fb2683ba8e28855086' },
  '0.1.7-rc.8.20260930.1': { tag: 'v0.1.7-rc.8.20260930.1', channel: 'rc', sha256: '9f50869596c7c94aaac2cfb0d60fa7113fc0ced70a6ce668691559baa720e28a' },
}[version]
if (historical === undefined || receipt.release.tag_name !== historical.tag
  || receipt.installerSha256 !== historical.sha256
  || createHash('sha256').update(configBytes).digest('hex') !== receipt.updaterConfigSha256) {
  throw new Error('Historical provider test requires verified immutable installer settings')
}
if (config.provider !== 'github' || config.owner !== 'felir7at62co-wq' || config.repo !== 'muse-med'
  || config.channel !== historical.channel) throw new Error('Unexpected original packaged updater settings')
const updaterVersion = require('electron-updater/package.json').version
if (updaterVersion !== '6.8.9') throw new Error(`Released and local providers must both be pinned to 6.8.9; received ${updaterVersion}`)
const expected = load(readFileSync(values.metadata, 'utf8'))
const installerHash = createHash('sha512')
let installerSize = 0
for await (const bytes of createReadStream(values.installer)) {
  installerHash.update(bytes)
  installerSize += bytes.length
}
if (installerHash.digest('base64') !== expected.files[0].sha512 || installerSize !== expected.files[0].size) {
  throw new Error('Final installer bytes differ from the retained genuine update metadata')
}

/** Supply Node transport while recording only public URL paths. */
class NodeHttpExecutor extends HttpExecutor {
  paths = []
  firstTag
  createRequest(options, callback) {
    this.paths.push(new URL(options.path ?? '/', `${options.protocol ?? 'https:'}//${options.hostname}`).pathname)
    return (options.protocol === 'http:' ? httpRequest : httpsRequest)(options, callback)
  }
  async request(options, cancellationToken, data) {
    const response = await super.request(options, cancellationToken, data)
    if (new URL(options.path ?? '/', 'https://github.com').pathname.endsWith('/releases.atom')) {
      const firstHref = parseXml(response).element('entry').element('link').attribute('href')
      this.firstTag = /\/tag\/(v?[^/]+)$/u.exec(firstHref)?.[1]
    }
    return response
  }
}

async function resolve(channelOverride) {
  const executor = new NodeHttpExecutor()
  const provider = new GitHubProvider(config,
    { channel: channelOverride ?? null, allowPrerelease: true,
      currentVersion: semver.parse(version), fullChangelog: false },
    { executor, platform: 'win32', isUseMultipleRangeRequest: false })
  const result = await provider.getLatestVersion()
  return { result, firstTag: executor.firstTag, paths: executor.paths }
}

const { result, firstTag, paths } = await resolve()
if (result.version !== expectedVersion || !semver.gt(result.version, version)) {
  throw new Error(`Historical provider did not discover a greater intended version: ${result.version}`)
}
validateHistoricalDiscovery({ installedVersion: version, expectedVersion, firstTag, result, expected })
console.log(`PASS original ${version}: actual packaged ${config.channel} channel, released allowPrerelease=true, pinned electron-updater ${updaterVersion}/own semver ${updaterRequire('semver/package.json').version}`)
console.log(`PASS actual first Atom app release ${firstTag}; original provider resolves tag ${result.tag} with greater genuine metadata version ${result.version}`)
console.log('PASS provider installer SHA512 and size match complete actual final Windows installer bytes')
console.log(`public request paths: ${JSON.stringify(paths)}`)
let rejected = false
try {
  await resolve('nightly')
} catch (error) {
  if (error.code !== 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') {
    throw new Error(`Historical nightly control failed for an unexpected reason: ${error.code ?? error.name}`)
  }
  rejected = true
  console.log(`PASS historical negative control rejects forced nightly (${error.code ?? error.name})`)
}
if (!rejected) throw new Error('Historical nightly negative control unexpectedly discovered an update')
console.log('verify-original-stable-discovery: every check passed; this is provider discovery, with no old application execution')
