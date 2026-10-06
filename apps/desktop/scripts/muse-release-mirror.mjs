/** Verify one exact unsigned build across all release targets and prepare its public mirror. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { desktopUpdateChannel, desktopUpdateMetadataFilename, resolveDesktopMuseUpdateSources } from './desktop-auto-update-environment.mjs'

const TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64', os: 'mac' },
  'mac-x64': { platform: 'darwin', arch: 'x64', os: 'mac' },
  'win-x64': { platform: 'win32', arch: 'x64', os: 'win' },
}

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Muse mirror: invalid ${label}`)
  return value
}

function targetSettings(target) {
  if (!Object.hasOwn(TARGETS, target)) throw new Error('Muse mirror: unsupported target')
  return TARGETS[target]
}

function artifactNames(target, version) {
  const { platform, arch, os } = targetSettings(target)
  desktopUpdateChannel(version)
  const base = `muse-med-${version}-${os}-${arch}`
  return [...platform === 'darwin' ? [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`]
    : [`${base}.exe`, `${base}.exe.blockmap`], desktopUpdateMetadataFilename(version, platform)]
}

async function fileDigests(path) {
  const details = await stat(path)
  if (!details.isFile() || details.size < 1) throw new Error('Muse mirror: missing or empty release file')
  const sha256 = createHash('sha256'), sha512 = createHash('sha512')
  for await (const bytes of createReadStream(path)) { sha256.update(bytes); sha512.update(bytes) }
  return { size: details.size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

/**
 * Record hashes after the complete unsigned packaging checks have passed.
 * @param {{target: string, version: string, sourceCommit: string, artifactsRoot: string}} options - Exact completed build and artifact directory.
 * @returns {Promise<object>} Public build identity written beside the artifacts.
 */
export async function recordMuseUnsignedBuild({ target, version, sourceCommit, artifactsRoot }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('Muse mirror: an exact source commit is required')
  const artifacts = {}
  for (const filename of artifactNames(target, version)) artifacts[filename] = await fileDigests(join(artifactsRoot, filename))
  const record = { schemaVersion: 1, target, version, sourceCommit, unsigned: true, artifacts }
  await writeFile(join(artifactsRoot, 'unsigned-build.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

function contentType(filename) {
  if (filename.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (filename.endsWith('.zip')) return 'application/zip'
  if (filename.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  return 'application/octet-stream'
}

/**
 * Validate all three platform builds before producing any upload operations.
 * @param {{version: string, sourceCommit: string, artifactDirectories: Record<string, string>, legacyRcDiscovery?: boolean}} options - Exact release and completed target directories.
 * @returns {Promise<{version: string, sourceCommit: string, artifacts: object[], metadata: object[], githubMetadata: object[]}>} Immutable binaries and channel metadata ordered separately for publication.
 */
export async function createMuseMirrorPlan({ version, sourceCommit, artifactDirectories, legacyRcDiscovery = false }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('Muse mirror: an exact source commit is required')
  const artifacts = [], updates = {}
  for (const [target, { platform }] of Object.entries(TARGETS)) {
    const root = artifactDirectories[target]
    if (typeof root !== 'string' || root === '') throw new Error(`Muse mirror: missing ${target} artifact directory`)
    const record = object(JSON.parse(await readFile(join(root, 'unsigned-build.json'), 'utf8')), 'build record')
    if (record.schemaVersion !== 1 || record.target !== target || record.version !== version
      || record.sourceCommit !== sourceCommit || record.unsigned !== true) throw new Error(`Muse mirror: ${target} belongs to another build`)
    const recordedFiles = object(record.artifacts, 'artifact hashes')
    for (const filename of artifactNames(target, version)) {
      const path = join(root, filename), digest = await fileDigests(path)
      const recorded = object(recordedFiles[filename], 'artifact hash')
      if (recorded.size !== digest.size || recorded.sha256 !== digest.sha256 || recorded.sha512 !== digest.sha512) {
        throw new Error(`Muse mirror: ${target}/${filename} changed after packaging verification`)
      }
      if (!filename.endsWith('.yml')) artifacts.push({ path, filename, key: `releases/${version}/${target}/${filename}`, contentType: contentType(filename), ...digest })
    }
    const update = object(load(await readFile(join(root, desktopUpdateMetadataFilename(version, platform)), 'utf8')), 'update metadata')
    if (update.version !== version || !Array.isArray(update.files) || update.files.length !== 1) {
      throw new Error(`Muse mirror: ${target} has incompatible update metadata`)
    }
    const info = object(update.files[0], 'update file')
    const binary = artifacts.find(file => file.key.startsWith(`releases/${version}/${target}/`) && file.filename === info.url)
    if (!binary || binary.sha512 !== info.sha512 || binary.size !== info.size) throw new Error(`Muse mirror: ${target} update checksum differs from its payload`)
    updates[target] = update
  }
  const mac = { ...updates['mac-arm64'], files: [updates['mac-arm64'].files[0], updates['mac-x64'].files[0]] }
  const win = updates['win-x64']
  const channel = desktopUpdateChannel(version)
  const channels = legacyRcDiscovery && ['latest', 'beta'].includes(channel) ? [...new Set([channel, 'rc', 'latest'])] : [channel]
  const metadata = [], githubMetadata = []
  for (const [target, { platform }] of Object.entries(TARGETS)) {
    const original = platform === 'darwin' ? mac : win
    const files = original.files.map(info => {
      const binary = artifacts.find(file => file.filename === info.url)
      return { ...info, url: `https://muse.tos-cn-beijing.volces.com/${binary.key}` }
    })
    const mirrored = { ...original, files, path: files[0].url }
    const feed = resolveDesktopMuseUpdateSources(version, platform, TARGETS[target].arch).primary.url
    const prefix = new URL(feed).pathname.slice(1)
    for (const alias of channels) {
      const filename = `${alias}${platform === 'darwin' ? '-mac' : ''}.yml`
      const contents = dump(mirrored, { lineWidth: -1, noRefs: true })
      metadata.push({ filename, key: `${prefix}${filename}`, contents, contentType: 'application/yaml', sha256: createHash('sha256').update(contents).digest('hex') })
      if (target !== 'mac-x64') githubMetadata.push({ filename, contents: dump(original, { lineWidth: -1, noRefs: true }) })
    }
  }
  return { version, sourceCommit, artifacts, metadata, githubMetadata }
}
