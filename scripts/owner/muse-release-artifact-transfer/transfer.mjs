/** Validate existing installer bytes and supplement two draft releases without rebuilding or publishing. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

const REPOSITORY = 'felir7at62co-wq/muse-med'
const TARGETS = ['mac-arm64', 'win-x64']
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u

function keys(value, expected, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`)
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `Invalid ${label} fields`)
}

function positiveInteger(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `Invalid ${label}`)
}

function expectedFilenames(version) {
  return [
    `muse-med-${version}-mac-arm64.dmg`, `muse-med-${version}-mac-arm64.zip`,
    `muse-med-${version}-mac-arm64.zip.blockmap`, `muse-med-${version}-win-x64.exe`,
    `muse-med-${version}-win-x64.exe.blockmap`, 'latest-mac.yml', 'rc-mac.yml',
    'latest.yml', 'rc.yml', 'muse-desktop-builds.json', 'muse-desktop-SHA256SUMS.txt',
  ].sort()
}

function largeFiles(seal) {
  return seal.files.filter(file => /\.(?:exe|dmg|zip)$/u.test(file.filename))
}

/**
 * Refuse private paths, incomplete inventories and ambiguous release identities in the operator seal.
 * @param seal - Parsed public JSON containing the approved source, run, releases and eleven file hashes.
 * @returns The validated seal, without modifying it.
 */
export function validateTransferSeal(seal) {
  keys(seal, ['schemaVersion', 'repository', 'version', 'sourceCommit', 'sourceRun', 'releases', 'files'], 'seal')
  assert.equal(seal.schemaVersion, 1, 'Invalid seal version')
  assert.equal(seal.repository, REPOSITORY, 'Invalid source repository')
  assert.match(seal.version, /^\d+\.\d+\.\d+$/u, 'Invalid product version')
  assert.match(seal.sourceCommit, COMMIT, 'Invalid source commit')
  positiveInteger(seal.sourceRun, 'source run')
  assert.ok(Array.isArray(seal.releases) && seal.releases.length === 2, 'Exactly two draft releases are required')
  const tags = [`v${seal.version}`, `v${seal.version}-rc.muse-stable`]
  for (const [index, tag] of tags.entries()) {
    const release = seal.releases[index]
    keys(release, ['id', 'tag', 'prerelease'], 'release')
    positiveInteger(release.id, 'release ID')
    assert.equal(release.tag, tag, 'Unexpected release tag')
    assert.equal(release.prerelease, index === 1, 'Unexpected prerelease flag')
  }
  assert.notEqual(seal.releases[0].id, seal.releases[1].id, 'Release IDs must differ')
  assert.ok(Array.isArray(seal.files), 'Invalid file inventory')
  assert.deepEqual(seal.files.map(file => file.filename).sort(), expectedFilenames(seal.version), 'Exactly eleven public files are required')
  for (const file of seal.files) {
    keys(file, ['filename', 'size', 'sha256'], 'file')
    assert.equal(basename(file.filename), file.filename, 'Invalid public filename')
    positiveInteger(file.size, 'file size')
    assert.ok(file.size < 2 * 1024 ** 3, 'Release file exceeds the GitHub asset bound')
    assert.match(file.sha256, SHA256, 'Invalid file SHA256')
  }
  assert.equal(largeFiles(seal).length, 3, 'Exactly three installer payloads are required')
  return seal
}

async function tagCommit(seal, adapter, tag) {
  let object = (await adapter.json(`git/ref/tags/${encodeURIComponent(tag)}`)).object
  for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
    assert.match(object.sha, COMMIT, 'Invalid annotated tag object')
    object = (await adapter.json(`git/tags/${object.sha}`)).object
  }
  assert.equal(object?.type, 'commit', 'Tag did not resolve to a commit')
  assert.equal(object.sha, seal.sourceCommit, 'Release tag points to another source commit')
}

function checkedRelease(seal, expected, release, { draft = true, complete = false } = {}) {
  assert.equal(release.id, expected.id, 'GitHub returned another release ID')
  assert.equal(release.tag_name, expected.tag, 'GitHub returned another release tag')
  assert.equal(release.draft, draft, 'Release visibility differs from the operation')
  assert.equal(release.prerelease, expected.prerelease, 'Unexpected release prerelease flag')
  assert.ok(Array.isArray(release.assets), 'Missing release assets')
  assert.equal(new Set(release.assets.map(asset => asset.name)).size, release.assets.length, 'Duplicate release assets')
  for (const asset of release.assets) {
    const file = seal.files.find(item => item.filename === asset.name)
    assert.ok(file, 'Unexpected asset in the draft release')
    assert.equal(asset.state, 'uploaded', `Asset is not uploaded: ${asset.name}`)
    assert.equal(asset.size, file.size, `Asset size differs: ${asset.name}`)
    assert.equal(asset.digest, `sha256:${file.sha256}`, `Asset digest differs: ${asset.name}`)
  }
  for (const file of seal.files.filter(file => !largeFiles(seal).includes(file))) {
    assert.ok(release.assets.some(asset => asset.name === file.filename), `Missing preloaded small asset: ${file.filename}`)
  }
  if (complete) assert.equal(release.assets.length, 11, 'Release must contain precisely eleven sealed assets')
  return release
}

async function liveReleases(seal, adapter, options) {
  const result = []
  for (const expected of seal.releases) {
    await tagCommit(seal, adapter, expected.tag)
    result.push(checkedRelease(seal, expected, await adapter.json(`releases/${expected.id}`), options))
  }
  return result
}

/**
 * Require both sealed tag commits, release IDs, visibility and complete asset metadata for readback.
 * @param seal - Approved public inventory and exact source identities.
 * @param adapter - Repository-scoped JSON metadata reader.
 * @param options - Expected draft visibility and whether all eleven assets must exist.
 * @returns Both checked releases, preserving their wire metadata for an unchanged-state comparison.
 */
export async function verifySealedReleaseState(seal, adapter, { draft, complete = true }) {
  validateTransferSeal(seal)
  assert.equal(typeof draft, 'boolean', 'Readback must declare expected release visibility')
  return liveReleases(seal, adapter, { draft, complete })
}

/**
 * Require the successful exact-source native build and unchanged draft identities before downloading.
 * @param seal - Validated public transfer seal.
 * @param adapter - Repository-scoped JSON reader and single-file upload adapter.
 * @returns Resolves after source, native acceptance jobs, artifact ownership, tags and drafts pass.
 */
export async function verifyTransferPreflight(seal, adapter) {
  validateTransferSeal(seal)
  const run = await adapter.json(`actions/runs/${seal.sourceRun}`)
  assert.equal(run.id, seal.sourceRun, 'GitHub returned another source run')
  assert.equal(run.repository?.full_name, seal.repository, 'Source run belongs to another repository')
  assert.equal(run.head_sha, seal.sourceCommit, 'Source run uses another source commit')
  assert.equal(run.head_branch, 'main', 'Source run must use main')
  assert.equal(run.event, 'workflow_dispatch', 'Source run must be a manual native build')
  assert.equal(run.path, '.github/workflows/muse-desktop.yml', 'Unexpected source workflow')
  assert.equal(run.status, 'completed', 'Source run has not completed')
  assert.equal(run.conclusion, 'success', 'Source run did not succeed')
  const jobs = await adapter.json(`actions/runs/${seal.sourceRun}/jobs?per_page=100`)
  assert.equal(jobs.total_count, 2, 'Exactly two source jobs are required')
  assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.length === 2, 'Incomplete source job response')
  for (const target of TARGETS) {
    const job = jobs.jobs.find(item => item.name === `${target} unsigned installer`)
    assert.ok(job, 'Missing native installer job')
    assert.equal(job.status, 'completed', 'Native installer job has not completed')
    assert.equal(job.conclusion, 'success', 'Native installer job did not succeed')
    const acceptance = job.steps?.find(step => step.name === 'Accept the genuine installer in an isolated directory')
    assert.ok(acceptance, 'Missing actual installer acceptance')
    assert.equal(acceptance.conclusion, 'success', 'Actual installer acceptance did not succeed')
  }
  const artifacts = await adapter.json(`actions/runs/${seal.sourceRun}/artifacts?per_page=100`)
  assert.ok(Array.isArray(artifacts.artifacts) && artifacts.total_count === artifacts.artifacts.length, 'Incomplete source artifact response')
  for (const target of TARGETS) {
    for (const suffix of ['', '-installed-acceptance']) {
      const name = `muse-${target}${suffix}-${seal.sourceCommit}`
      const matches = artifacts.artifacts.filter(item => item.name === name)
      assert.equal(matches.length, 1, 'Missing or ambiguous original artifact')
      const artifact = matches[0]
      positiveInteger(artifact.id, 'artifact ID')
      positiveInteger(artifact.size_in_bytes, 'artifact size')
      assert.equal(artifact.expired, false, 'Original artifact has expired')
      assert.equal(artifact.workflow_run?.id, seal.sourceRun, 'Artifact belongs to another source run')
      assert.equal(artifact.workflow_run?.head_sha, seal.sourceCommit, 'Artifact uses another source commit')
      assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/u, 'Missing original artifact digest')
    }
  }
  await liveReleases(seal, adapter)
}

async function fileDigest(path) {
  const info = await lstat(path)
  assert.ok(info.isFile(), 'Original input must be a regular file')
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let size = 0
  for await (const bytes of createReadStream(path)) {
    size += bytes.length
    sha256.update(bytes)
    sha512.update(bytes)
  }
  assert.equal(size, info.size, 'Original file changed during verification')
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

async function smallJSON(path) {
  const info = await lstat(path)
  assert.ok(info.isFile() && info.size > 0 && info.size <= 131072, 'Invalid original JSON record')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function receiptsBelow(root) {
  assert.ok((await lstat(root)).isDirectory(), 'Invalid original acceptance directory')
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const info = await lstat(path)
    assert.ok(!info.isSymbolicLink(), 'Acceptance artifact contains a link')
    if (info.isDirectory()) result.push(...await receiptsBelow(path))
    else if (entry.name === 'acceptance.json') result.push(path)
  }
  return result
}

function checkedReceipt(seal, target, receipt, installerSha256) {
  assert.equal(receipt.success, true, 'Original installer acceptance did not succeed')
  assert.equal(receipt.version, seal.version, 'Acceptance uses another version')
  assert.equal(receipt.sourceCommit, seal.sourceCommit, 'Acceptance uses another source commit')
  assert.equal(receipt.target, target, 'Acceptance uses another target')
  assert.equal(receipt.installerSha256, installerSha256, 'Acceptance refers to another installer binary')
  assert.equal(receipt.completeInstalledPayload?.passed, true, 'Full installed payload comparison did not pass')
  positiveInteger(receipt.completeInstalledPayload.comparedFiles, 'compared file count')
  assert.equal(receipt.installedRuntimeSmoke?.passed, true, 'Installed runtime smoke did not pass')
  assert.equal(target === 'mac-arm64' ? receipt.dmgMountedReadOnly : receipt.silentInstallerExecuted, true, 'Missing actual native installer operation')
}

/**
 * Bind all original artifact bytes and actual native installer receipts to the approved publication.
 * @param seal - Validated public transfer seal.
 * @param artifactsRoot - Owned directory containing each target and acceptance/target downloads.
 * @returns Paths of the five original binary files, after both target records and receipts pass.
 */
export async function verifyDownloadedInputs(seal, artifactsRoot) {
  validateTransferSeal(seal)
  const result = new Map()
  for (const target of TARGETS) {
    const directory = join(artifactsRoot, target)
    assert.ok((await lstat(directory)).isDirectory(), 'Invalid original artifact directory')
    const record = await smallJSON(join(directory, 'unsigned-build.json'))
    keys(record, ['schemaVersion', 'target', 'version', 'sourceCommit', 'unsigned', 'artifacts'], 'original build')
    assert.equal(record.schemaVersion, 1, 'Invalid original build version')
    assert.equal(record.target, target, 'Original build uses another target')
    assert.equal(record.version, seal.version, 'Original build uses another product version')
    assert.equal(record.sourceCommit, seal.sourceCommit, 'Original build uses another source commit')
    assert.equal(record.unsigned, true, 'Original build must be unsigned')
    const files = seal.files.filter(file => file.filename.startsWith(`muse-med-${seal.version}-${target}.`))
    const metadataName = target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml'
    const names = [...files.map(file => file.filename), metadataName].sort()
    keys(record.artifacts, names, 'original artifact inventory')
    assert.deepEqual((await readdir(directory)).sort(), [...names, 'unsigned-build.json'].sort(), 'Original artifact directory differs')
    for (const filename of names) {
      const expected = record.artifacts[filename]
      keys(expected, ['size', 'sha256', 'sha512'], 'original artifact hash')
      positiveInteger(expected.size, 'original artifact size')
      assert.match(expected.sha256, SHA256, 'Invalid original artifact SHA256')
      assert.match(expected.sha512, /^[A-Za-z0-9+/]{86}==$/u, 'Invalid original artifact SHA512')
      const actual = await fileDigest(join(directory, filename))
      assert.deepEqual(actual, expected, `Original artifact bytes differ: ${filename}`)
      const publicFile = files.find(file => file.filename === filename)
      if (publicFile) {
        assert.equal(actual.size, publicFile.size, `Sealed file size differs: ${filename}`)
        assert.equal(actual.sha256, publicFile.sha256, `Sealed file digest differs: ${filename}`)
        result.set(filename, join(directory, filename))
      }
    }
    const paths = await receiptsBelow(join(artifactsRoot, 'acceptance', target))
    assert.equal(paths.length, 1, 'Exactly one original native acceptance receipt is required')
    const installerName = `muse-med-${seal.version}-${target}.${target === 'mac-arm64' ? 'dmg' : 'exe'}`
    checkedReceipt(seal, target, await smallJSON(paths[0]), seal.files.find(file => file.filename === installerName).sha256)
  }
  return result
}

/**
 * Upload only absent EXE, DMG and ZIP assets while both approved releases remain drafts.
 * @param seal - Validated public transfer seal.
 * @param artifactsRoot - Owned downloads already bound to the successful original build.
 * @param adapter - Repository-scoped JSON reader and single-file uploader without clobber/delete support.
 * @param onEvent - Receives public file identity and upload/skip status; no credentials or private records.
 * @returns Counts of uploaded and already matching assets after both releases contain eleven assets.
 */
export async function transferSealedArtifacts(seal, artifactsRoot, adapter, onEvent = () => {}) {
  await verifyTransferPreflight(seal, adapter)
  const paths = await verifyDownloadedInputs(seal, artifactsRoot)
  let uploaded = 0
  let skipped = 0
  for (const expected of seal.releases) {
    for (const file of largeFiles(seal)) {
      const releases = await liveReleases(seal, adapter)
      const release = releases.find(item => item.id === expected.id)
      if (release.assets.some(asset => asset.name === file.filename)) {
        skipped++
        onEvent({ status: 'already-matching', releaseId: expected.id, tag: expected.tag, ...file })
        continue
      }
      const path = paths.get(file.filename)
      const current = await fileDigest(path)
      assert.equal(current.size, file.size, 'Installer size changed before upload')
      assert.equal(current.sha256, file.sha256, 'Installer bytes changed before upload')
      await adapter.upload(expected.tag, path)
      const after = (await liveReleases(seal, adapter)).find(item => item.id === expected.id)
      assert.ok(after.assets.some(asset => asset.name === file.filename), 'Uploaded asset is missing from the draft')
      uploaded++
      onEvent({ status: 'uploaded', releaseId: expected.id, tag: expected.tag, ...file })
    }
  }
  for (const release of await liveReleases(seal, adapter)) {
    assert.equal(release.assets.length, 11, 'Draft does not contain precisely eleven verified assets')
  }
  return { uploaded, skipped }
}
