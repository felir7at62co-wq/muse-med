#!/usr/bin/env node
/** Prepare public release bytes locally; never upload, tag, publish, or rewrite input build records. */
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { createMuseMirrorPlan, recordMuseUnsignedBuild } from '../../apps/desktop/scripts/muse-release-mirror.mjs'
import { readDesktopProductConfig } from '../../apps/desktop/scripts/desktop-build-version.mjs'

const VERSION = '1.0.3'
const TARGETS = ['mac-arm64', 'win-x64']
const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, commit: { type: 'string' }, output: { type: 'string' },
  'mac-arm64': { type: 'string' }, 'win-x64': { type: 'string' },
} })

function required(name) {
  if (typeof values[name] !== 'string' || values[name] === '') throw new Error(`Missing --${name}`)
  return values[name]
}

function checkedRecord(record, target, commit, filenames) {
  const keys = ['schemaVersion', 'target', 'version', 'sourceCommit', 'unsigned', 'artifacts']
  if (typeof record !== 'object' || record === null || Array.isArray(record)
    || !isDeepStrictEqual(Object.keys(record).sort(), keys.sort())
    || record.schemaVersion !== 1 || record.target !== target || record.version !== VERSION
    || record.sourceCommit !== commit || record.unsigned !== true
    || typeof record.artifacts !== 'object' || record.artifacts === null || Array.isArray(record.artifacts)
    || !isDeepStrictEqual(Object.keys(record.artifacts).sort(), [...filenames].sort())) {
    throw new Error(`Invalid original ${target} unsigned build identity`)
  }
  for (const filename of filenames) {
    const entry = record.artifacts[filename]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
      || !isDeepStrictEqual(Object.keys(entry).sort(), ['sha256', 'sha512', 'size'])
      || !Number.isSafeInteger(entry.size) || entry.size < 1
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || typeof entry.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512)) {
      throw new Error(`Invalid original ${target} artifact digest`)
    }
  }
  return record
}

async function main() {
  if (values.help) {
    console.log('Usage: stage-muse-1.0.3.mjs --commit <final40hex> --mac-arm64 <original artifacts> --win-x64 <original artifacts> --output <new private .artifacts directory>')
    return
  }
  const commit = required('commit')
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('An exact final 40-character commit is required')
  const product = readDesktopProductConfig()
  if (product.version !== VERSION || product.legacyRcDiscovery !== true) throw new Error('Current product version or legacy RC discovery differs')
  const artifactDirectories = Object.fromEntries(TARGETS.map(target => [target, resolve(required(target))]))
  const output = required('output')
  if (!isAbsolute(output)) throw new Error('--output must be absolute')
  const privateRoot = await realpath(import.meta.dirname)
  const outputParent = await realpath(dirname(output))
  const parentRelative = relative(privateRoot, outputParent)
  if (parentRelative.startsWith('..') || isAbsolute(parentRelative)) throw new Error('Staging writes must remain inside this private release artifact directory')
  const inventoryPath = join(outputParent, `${basename(output)}.inventory.json`)
  try { await lstat(inventoryPath); throw new Error('Inventory destination already exists') }
  catch (error) { if (error.code !== 'ENOENT') throw error }

  const plan = await createMuseMirrorPlan({ version: VERSION, sourceCommit: commit, artifactDirectories, legacyRcDiscovery: true })
  const filenames = [...plan.artifacts.map(file => file.filename), ...plan.githubMetadata.map(file => file.filename),
    'muse-desktop-builds.json', 'muse-desktop-SHA256SUMS.txt']
  if (plan.artifacts.length !== 5 || plan.githubMetadata.length !== 4 || plan.metadata.length !== 4
    || filenames.length !== 11 || new Set(filenames).size !== 11
    || filenames.some(name => basename(name) !== name)) throw new Error('Unexpected publication inventory')
  const builds = await Promise.all(TARGETS.map(async target => {
    const originalPath = join(artifactDirectories[target], 'unsigned-build.json')
    const details = await lstat(originalPath)
    if (!details.isFile() || details.size > 131072) throw new Error(`Invalid original ${target} record file`)
    const names = plan.artifacts.filter(file => file.key.startsWith(`releases/${VERSION}/${target}/`)).map(file => file.filename)
    names.push(target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml')
    const record = checkedRecord(JSON.parse(await readFile(originalPath, 'utf8')), target, commit, names)
    return { target, record }
  }))

  // Exclusive directory creation preserves every prior attempt, including an incomplete one.
  await mkdir(output, { mode: 0o700 })
  const scratch = await mkdtemp(join(outputParent, '.muse-staging-record-'))
  const inventoryFiles = []
  try {
    for (const file of plan.artifacts) {
      await copyFile(file.path, join(output, file.filename), constants.COPYFILE_EXCL)
      inventoryFiles.push({ filename: file.filename, size: file.size, sha256: file.sha256, tosKey: file.key })
    }
    // Re-record only isolated verification copies. Original packaging identities remain untouched.
    for (const build of builds) {
      const directory = join(scratch, build.target)
      await mkdir(directory, { mode: 0o700 })
      for (const file of plan.artifacts.filter(file => file.key.startsWith(`releases/${VERSION}/${build.target}/`))) {
        await link(join(output, file.filename), join(directory, file.filename))
      }
      const metadata = build.target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml'
      await copyFile(join(artifactDirectories[build.target], metadata), join(directory, metadata), constants.COPYFILE_EXCL)
      const recorded = await recordMuseUnsignedBuild({ target: build.target, version: VERSION, sourceCommit: commit, artifactsRoot: directory })
      if (!isDeepStrictEqual(recorded, build.record)) throw new Error(`Copied ${build.target} bytes differ from the original verified identity`)
    }
    for (const file of plan.githubMetadata) {
      await writeFile(join(output, file.filename), file.contents, { flag: 'wx', mode: 0o600 })
      inventoryFiles.push({ filename: file.filename, size: Buffer.byteLength(file.contents),
        sha256: createHash('sha256').update(file.contents).digest('hex') })
    }
    const identity = `${JSON.stringify({ schemaVersion: 1, version: VERSION, sourceCommit: commit, unsigned: true, builds }, null, 2)}\n`
    await writeFile(join(output, 'muse-desktop-builds.json'), identity, { flag: 'wx', mode: 0o600 })
    inventoryFiles.push({ filename: 'muse-desktop-builds.json', size: Buffer.byteLength(identity),
      sha256: createHash('sha256').update(identity).digest('hex') })
    const sums = `${inventoryFiles.map(file => `${file.sha256}  ${file.filename}`).sort().join('\n')}\n`
    await writeFile(join(output, 'muse-desktop-SHA256SUMS.txt'), sums, { flag: 'wx', mode: 0o600 })
    inventoryFiles.push({ filename: 'muse-desktop-SHA256SUMS.txt', size: Buffer.byteLength(sums),
      sha256: createHash('sha256').update(sums).digest('hex') })
    if (!isDeepStrictEqual((await readdir(output)).sort(), [...filenames].sort())) throw new Error('Staging output differs from the eleven-file inventory')
    const inventory = { schemaVersion: 1, version: VERSION, sourceCommit: commit, output, files: inventoryFiles,
      tosFeeds: plan.metadata.map(file => ({ key: file.key, size: Buffer.byteLength(file.contents), sha256: file.sha256 })) }
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ stage: 'staged-locally', version: VERSION, sourceCommit: commit, files: 11, output, inventory: inventoryPath }))
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

main().catch(error => { console.error(`Muse staging: ${error.message}`); process.exitCode = 1 })
