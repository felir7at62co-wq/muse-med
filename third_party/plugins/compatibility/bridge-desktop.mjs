/** Build only reviewed upstream modules and explicit Muse providers. */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceNormalizationSha256 = 'd83b8ceefc9f57b8e4b903ad26787037bf3e49f0a5adeed4cfa5687f60f83f6c'
const sourceNormalizationBytes = readFileSync(new URL('../dsh-bridge/MUSE_SOURCE_NORMALIZATION.json', import.meta.url))
if (createHash('sha256').update(sourceNormalizationBytes).digest('hex') !== sourceNormalizationSha256) throw new Error('community plugins: bridge source normalization requires review')
const sourceNormalization = JSON.parse(sourceNormalizationBytes.toString('utf8'))

/** Metadata included in the packed source record. */
export const bridgeDesktopCompatibility = {
  remoteAuthentication: 'Muse account and bound desktop device',
  upstreamReuse: ['CustomTunnelClient', 'FeishuGateway', 'FeishuConversationNode', 'ConversationBridge'],
  disabledEntries: ['upstream root and client', 'LAN proxy', 'Cloudflare', 'standalone server', 'self-update', 'password and QR auth'],
  streamingProtocolVersion: 1,
  sourceNormalization,
}

/**
 * Replace upstream activation with reviewed Muse entry points in private build staging.
 * @param {string} directory Private copied source root; never the retained snapshot.
 * @returns {void}
 */
export function applyBridgeDesktopCompatibility(directory) {
  const source = join(directory, 'lib')
  if (createHash('sha256').update(readFileSync(join(directory, 'MUSE_SOURCE_NORMALIZATION.json'))).digest('hex') !== sourceNormalizationSha256) throw new Error('community plugins: bridge source normalization requires review')
  for (const [path, hashes] of Object.entries(sourceNormalization.files)) {
    if (createHash('sha256').update(readFileSync(join(directory, path))).digest('hex') !== hashes.normalizedSha256) throw new Error(`community plugins: bridge ${path} requires source review`)
  }
  const expected = {
    'tunnel-client.mjs': '5aba487518876eadae00a2ad2c3de86fbb2180d6f957737594272939d87875e7',
    'session-strip.js': '971fc21ea98232d478642565d4e523a985bf0f5ce618b14a80e2c728dc38ae81',
    'feishu/gateway.js': '5050b16f15536430071b048d8164d49415a33bb0bcde42f18d65bc58791759cc',
    'feishu/node.js': '96002d627fa9afa98f957ed02183db161801bffd163b0c3719737579b1581f1c',
    'platform/conversation-bridge.js': 'dbf9f973b99b473da9a58683d7a8ba15d222e9a5021185931285f72991da4318',
    'platform/stream-slices.js': '4f8d451e584cba1e910b13ff7d8c495ccd43d70cc33dce9096eb306bc9687bf7',
    'platform/message-split.js': 'bf110a906d5fb2a5dc4bd64ed106f44b6a78b979ab9079d6dfa2d526fabd7339',
    'platform/commands.js': '1cd775676d6d258e968a42ae5d75deceb6cbd2138f8c7cd6949b7f92f0f6ff2b',
    'platform/session-catalog.js': '390c3e3842575e0b08c775395abcdb6db954e740e224d465dfaf0df8c4c8bb76',
    'platform/dsh-storage.js': '455bbdcaa0467f82d4a6ad0cf1ca59fd6c4e2de9357331cbf98aaed68ddf7585',
    'security/path-validator.js': '0e0eae13e6adc4f35c2ce3e8eaf55793ce634c237952fff569417fa84a4dc910',
  }
  for (const [path, digest] of Object.entries(expected)) {
    const normalized = sourceNormalization.files[`lib/${path}`]
    if (normalized && normalized.upstreamSha256 !== digest) throw new Error(`community plugins: bridge ${path} upstream hash requires source review`)
    if (createHash('sha256').update(readFileSync(join(source, path))).digest('hex') !== (normalized?.normalizedSha256 ?? digest)) throw new Error(`community plugins: bridge ${path} requires source review`)
  }
  const selected = Object.keys(expected)
  const retained = new Map(selected.map(path => [path, readFileSync(join(source, path), 'utf8')]))
  rmSync(source, { recursive: true, force: true })
  mkdirSync(join(source, 'upstream'), { recursive: true })
  for (const [path, original] of retained) {
    mkdirSync(join(source, 'upstream', path, '..'), { recursive: true })
    let text = path === 'feishu/gateway.js' ? original.replace("import LarkSdk from './lark-bundled.mjs'", "import LarkSdk from '@larksuiteoapi/node-sdk'") : original
    if (path === 'tunnel-client.mjs') text = text.replace("this._sendMessage({ type: 'ws-frame', wsId, data: Buffer.from(rest, 'binary').toString('base64') });", "wsFrameBuf = this._processWsFrames(wsId, Buffer.from(rest, 'binary'), sock);")
    if (path === 'platform/session-catalog.js') text = text.replace('const projCache = getSessionProjCache(node.ctx)', 'const projCache = await getSessionProjCache(node.ctx)')
    writeFileSync(join(source, 'upstream', path), text)
  }
  cpSync(join(import.meta.dirname, 'muse-bridge-storage.mjs'), join(source, 'upstream/platform/dsh-storage.js'))
  cpSync(join(import.meta.dirname, 'muse-desktop-tunnel.mjs'), join(source, 'muse-desktop-tunnel.mjs'))
  writeFileSync(join(source, 'remote.mjs'), `import { MuseDesktopBridge } from '@deepseek-ai/dsh-muse-account/desktop-bridge'\nimport { createMuseDesktopTunnel } from './muse-desktop-tunnel.mjs'\nexport const name = 'muse-desktop-bridge'\nclass Provider extends MuseDesktopBridge {\n  createTunnel(options) { return createMuseDesktopTunnel(options) }\n}\nexport function apply(ctx) { ctx.plugin(Provider) }\nexport { createMuseDesktopTunnel }\n`)
  cpSync(join(import.meta.dirname, 'muse-feishu-channel.mjs'), join(source, 'index.js'))
  cpSync(join(import.meta.dirname, 'muse-feishu-files.mjs'), join(source, 'muse-feishu-files.mjs'))
  cpSync(join(import.meta.dirname, 'bridge.cordis.patch.yml'), join(directory, 'cordis.patch.yml'))
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.description = 'Authenticated Muse desktop access with an optional Feishu channel.'
  delete manifest.releaseNotes
  manifest.exports = { '.': { default: './lib/index.js' }, './remote': './lib/remote.mjs', './package.json': './package.json' }
  manifest.files = ['lib', 'cordis.patch.yml', 'LICENSE', 'SOURCE.json']
  manifest.scripts = {}
  delete manifest.bin
  delete manifest.dsh.client
  manifest.dependencies = { ws: '8.21.3', '@larksuiteoapi/node-sdk': '1.73.0', '@deepseek-ai/schemastery': '3.18.4', '@deepseek-ai/dsh-muse-account': '0.2.0-rc.2' }
  for (const path of ['client', 'scripts', 'locale']) rmSync(join(directory, path), { recursive: true, force: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
