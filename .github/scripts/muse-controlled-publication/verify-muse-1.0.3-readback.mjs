#!/usr/bin/env node
/** Fully read public release files and feeds; never write a remote object or change a release. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'

const REPOSITORY = 'felir7at62co-wq/muse-med'
const TOS = 'https://muse.tos-cn-beijing.volces.com'
const desktopRequire = createRequire(new URL('../../apps/desktop/scripts/verify-github-update-feed.mjs', import.meta.url))
const updaterRequire = createRequire(desktopRequire.resolve('electron-updater/package.json'))
const { parseXml } = updaterRequire('builder-util-runtime')
const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, inventory: { type: 'string' },
  'github-tag': { type: 'string' }, tos: { type: 'boolean', default: false },
} })

async function publicJSON(path) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, { signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
  if (!response.ok) throw new Error(`Public GitHub metadata HTTP ${response.status}`)
  return response.json()
}

async function verify(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1800000), cache: 'no-store' })
  if (response.status !== 200 || response.body === null) throw new Error(`Public file HTTP ${response.status}: ${file.filename ?? file.key}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > file.size) throw new Error('Public file exceeds its verified size')
    hash.update(chunk)
  }
  if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Public size or SHA-256 mismatch: ${file.filename ?? file.key}`)
  console.log(JSON.stringify({ stage: 'public-file-verified', file: file.filename ?? file.key, size, sha256: file.sha256 }))
}

async function main() {
  if (values.help) {
    console.log('Usage: verify-muse-1.0.3-readback.mjs --inventory <private inventory.json> [--github-tag v1.0.3|v1.0.3-rc.muse-stable] [--tos]')
    return
  }
  if (!values.inventory || (!values['github-tag'] && !values.tos)) throw new Error('Provide an inventory and at least one public destination')
  const inventory = JSON.parse(await readFile(values.inventory, 'utf8'))
  if (inventory.schemaVersion !== 1 || inventory.version !== '1.0.3' || !/^[a-f0-9]{40}$/.test(inventory.sourceCommit)
    || !Array.isArray(inventory.files) || inventory.files.length !== 11
    || new Set(inventory.files.map(file => file.filename)).size !== 11
    || !Array.isArray(inventory.tosFeeds) || inventory.tosFeeds.length !== 4) throw new Error('Invalid local staging inventory')
  for (const file of [...inventory.files, ...inventory.tosFeeds]) {
    if (!Number.isSafeInteger(file.size) || file.size < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)
      || file.filename !== undefined && (typeof file.filename !== 'string' || basename(file.filename) !== file.filename)
      || file.key !== undefined && !/^releases\/feeds\/(?:mac-arm64|win-x64)\/(?:latest|rc)(?:-mac)?\.yml$/.test(file.key)
      || file.tosKey !== undefined && !/^releases\/1\.0\.3\/(?:mac-arm64|win-x64)\/muse-med-1\.0\.3-(?:mac-arm64|win-x64)\.(?:dmg|zip|exe)(?:\.blockmap)?$/.test(file.tosKey)) {
      throw new Error('Invalid local file hash, name or remote key')
    }
  }
  const tag = values['github-tag']
  if (tag) {
    if (!['v1.0.3', 'v1.0.3-rc.muse-stable'].includes(tag)) throw new Error('Unexpected GitHub release tag')
    const release = await publicJSON(`releases/tags/${encodeURIComponent(tag)}`)
    if (release.tag_name !== tag || release.draft !== false || release.prerelease !== (tag !== 'v1.0.3')) throw new Error('Public release flags differ')
    if (!Array.isArray(release.assets) || release.assets.length !== 11) throw new Error('Public GitHub release must contain the eleven staged files')
    for (const file of inventory.files) {
      const asset = release.assets.find(asset => asset.name === file.filename)
      if (!asset || asset.size !== file.size || asset.state !== 'uploaded'
        || asset.digest !== `sha256:${file.sha256}`) throw new Error(`GitHub uploaded asset metadata differs: ${file.filename}`)
    }
    let object = (await publicJSON(`git/ref/tags/${encodeURIComponent(tag)}`)).object
    for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) object = (await publicJSON(`git/tags/${object.sha}`)).object
    if (object?.type !== 'commit' || object.sha !== inventory.sourceCommit) throw new Error('Public release tag points to another source commit')
    if (tag === 'v1.0.3' && (await publicJSON('releases/latest')).tag_name !== tag) throw new Error('GitHub Latest is not the stable Muse app release')
    if (tag === 'v1.0.3-rc.muse-stable') {
      const response = await fetch(`https://github.com/${REPOSITORY}/releases.atom`, { signal: AbortSignal.timeout(30000), cache: 'no-store' })
      if (response.status !== 200 || response.body === null) throw new Error('Public release Atom feed is unavailable')
      const parts = []
      let bytes = 0
      for await (const part of response.body) {
        bytes += part.length
        if (bytes > 2 * 1024 ** 2) throw new Error('Public release Atom feed exceeds its bound')
        parts.push(part)
      }
      const first = parseXml(Buffer.concat(parts).toString('utf8')).element('entry').element('link').attribute('href')
      if (first !== `https://github.com/${REPOSITORY}/releases/tag/${tag}`) {
        throw new Error('Legacy 1.0.1 discovery requires the RC app alias to be the first Atom entry')
      }
      console.log(JSON.stringify({ stage: 'legacy-atom-verified', firstTag: tag }))
    }
    for (const file of inventory.files) await verify(`https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file.filename)}`, file)
  }
  if (values.tos) {
    const binaries = inventory.files.filter(file => file.tosKey !== undefined)
    if (binaries.length !== 5) throw new Error('TOS binary inventory differs')
    for (const file of binaries) await verify(`${TOS}/${file.tosKey}`, file)
    for (const file of inventory.tosFeeds) await verify(`${TOS}/${file.key}`, file)
  }
  console.log(JSON.stringify({ stage: 'public-readback-complete', version: inventory.version, sourceCommit: inventory.sourceCommit,
    githubTag: tag ?? null, tos: values.tos }))
}

main().catch(error => { console.error(`Muse public readback: ${error.message}`); process.exitCode = 1 })
