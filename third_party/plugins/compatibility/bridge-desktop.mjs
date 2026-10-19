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
  upstreamReuse: ['CustomTunnelClient', 'stripSessionProjections'],
  disabledEntries: ['legacy Feishu Host, Client and gateway', 'upstream root and client', 'LAN proxy', 'Cloudflare', 'standalone server', 'self-update', 'password and QR auth'],
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
    let text = original
    if (path === 'tunnel-client.mjs') text = text.replace("this._sendMessage({ type: 'ws-frame', wsId, data: Buffer.from(rest, 'binary').toString('base64') });", "wsFrameBuf = this._processWsFrames(wsId, Buffer.from(rest, 'binary'), sock);")
    writeFileSync(join(source, 'upstream', path), text)
  }
  cpSync(join(import.meta.dirname, 'muse-desktop-tunnel.mjs'), join(source, 'muse-desktop-tunnel.mjs'))
  writeFileSync(join(source, 'remote.mjs'), `import { MuseDesktopBridge } from '@deepseek-ai/dsh-muse-account/desktop-bridge'\nimport { createMuseDesktopTunnel } from './muse-desktop-tunnel.mjs'\nexport const name = 'muse-desktop-bridge'\nclass Provider extends MuseDesktopBridge {\n  createTunnel(options) { return createMuseDesktopTunnel(options) }\n}\nexport function apply(ctx) { ctx.plugin(Provider) }\nexport { createMuseDesktopTunnel }\n`)
  writeFileSync(join(source, 'index.js'), `export const name = 'muse-retired-feishu-channel'\nexport function apply() {\n  throw new Error('Muse: the legacy Feishu root provider has been removed; use @xmanrui/dsh-im for IM and @wenbin_wb/dsh-bridge/remote for account remote access.')\n}\n`)
  cpSync(join(import.meta.dirname, 'bridge.cordis.patch.yml'), join(directory, 'cordis.patch.yml'))
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.description = 'Authenticated Muse account desktop access.'
  delete manifest.releaseNotes
  manifest.exports = { '.': { default: './lib/index.js' }, './remote': './lib/remote.mjs', './package.json': './package.json' }
  manifest.files = ['lib', 'cordis.patch.yml', 'LICENSE', 'SOURCE.json']
  manifest.scripts = {}
  delete manifest.bin
  delete manifest.dsh.client
  manifest.dependencies = { ws: '8.21.3', '@deepseek-ai/dsh-muse-account': '0.2.1-alpha.1', '@xmanrui/dsh-im': '5.1.0' }
  delete manifest.devDependencies
  for (const path of ['client', 'scripts', 'locale']) rmSync(join(directory, path), { recursive: true, force: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
