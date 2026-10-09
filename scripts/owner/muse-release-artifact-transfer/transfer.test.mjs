import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import {
  validateTransferSeal, verifyTransferPreflight, verifyDownloadedInputs, transferSealedArtifacts,
} from './transfer.mjs'

const sourceCommit = 'a'.repeat(40)
const repository = 'felir7at62co-wq/muse-med'
const targets = ['mac-arm64', 'win-x64']
const filenames = [
  'muse-med-1.0.5-mac-arm64.dmg', 'muse-med-1.0.5-mac-arm64.zip',
  'muse-med-1.0.5-mac-arm64.zip.blockmap', 'muse-med-1.0.5-win-x64.exe',
  'muse-med-1.0.5-win-x64.exe.blockmap', 'latest-mac.yml', 'rc-mac.yml',
  'latest.yml', 'rc.yml', 'muse-desktop-builds.json', 'muse-desktop-SHA256SUMS.txt',
]
const largeNames = filenames.filter(name => /\.(?:dmg|zip|exe)$/u.test(name))
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const digest = bytes => ({ size: bytes.length, sha256: hash(bytes), sha512: hash(bytes, 'sha512', 'base64') })
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-sealed-transfer-'))
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const contents = new Map(filenames.map(name => [name, Buffer.from(`sealed fixture: ${name}\n`)]))
  const seal = {
    schemaVersion: 1, repository, version: '1.0.5', sourceCommit, sourceRun: 123456,
    releases: [{ id: 101, tag: 'v1.0.5', prerelease: false },
      { id: 102, tag: 'v1.0.5-rc.muse-stable', prerelease: true }],
    files: filenames.map(filename => ({ filename, size: contents.get(filename).length, sha256: hash(contents.get(filename)) })),
  }
  const records = {}, receiptPaths = {}, localPaths = {}
  for (const target of targets) {
    const directory = join(root, target)
    await mkdir(directory)
    const nativeNames = filenames.filter(name => name.startsWith(`muse-med-1.0.5-${target}.`))
    nativeNames.push(target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml')
    const artifacts = {}
    for (const name of nativeNames) {
      localPaths[name] = join(directory, name)
      const bytes = contents.get(name)
      await writeFile(localPaths[name], bytes)
      artifacts[name] = digest(bytes)
    }
    records[target] = { schemaVersion: 1, target, version: seal.version, sourceCommit,
      unsigned: true, artifacts }
    await writeFile(join(directory, 'unsigned-build.json'), jsonBytes(records[target]))
    const acceptanceRoot = join(root, 'acceptance', target, 'isolated-installation')
    await mkdir(acceptanceRoot, { recursive: true })
    receiptPaths[target] = join(acceptanceRoot, 'acceptance.json')
    const installer = `muse-med-1.0.5-${target}.${target === 'mac-arm64' ? 'dmg' : 'exe'}`
    await writeFile(receiptPaths[target], jsonBytes({ version: seal.version, sourceCommit, target,
      success: true, installerSha256: hash(contents.get(installer)),
      completeInstalledPayload: { passed: true, comparedFiles: 12 }, installedRuntimeSmoke: { passed: true },
      ...(target === 'mac-arm64' ? { dmgMountedReadOnly: true } : { silentInstallerExecuted: true }),
    }))
  }
  const run = { id: seal.sourceRun, head_sha: sourceCommit, head_branch: 'main', event: 'workflow_dispatch',
    path: '.github/workflows/muse-desktop.yml', repository: { full_name: repository }, status: 'completed', conclusion: 'success' }
  const jobs = { total_count: 2, jobs: targets.map((target, index) => ({ id: index + 1,
    name: `${target} unsigned installer`, status: 'completed', conclusion: 'success',
    steps: [{ name: 'Accept the genuine installer in an isolated directory', status: 'completed', conclusion: 'success' }] })) }
  const artifacts = { total_count: 4, artifacts: targets.flatMap((target, index) => [
    `muse-${target}-${sourceCommit}`, `muse-${target}-installed-acceptance-${sourceCommit}`,
  ].map((name, offset) => ({ id: index * 2 + offset + 1, name, expired: false,
    size_in_bytes: 50, digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: seal.sourceRun, head_sha: sourceCommit } }))) }
  const refs = new Map(seal.releases.map(release => [release.tag,
    { ref: `refs/tags/${release.tag}`, object: { type: 'commit', sha: sourceCommit } }]))
  const remoteReleases = seal.releases.map(release => ({ id: release.id, tag_name: release.tag,
    draft: true, prerelease: release.prerelease, target_commitish: sourceCommit,
    assets: seal.files.filter(file => !largeNames.includes(file.filename)).map((file, index) =>
      ({ id: 200 + index, name: file.filename, size: file.size, digest: `sha256:${file.sha256}`, state: 'uploaded' })) }))
  const requests = [], uploads = [], annotatedTags = new Map()
  const adapter = {
    async json(route) {
      requests.push(route)
      const local = route
      if (local === `actions/runs/${seal.sourceRun}`) return structuredClone(run)
      if (local === `actions/runs/${seal.sourceRun}/jobs?per_page=100`) return structuredClone(jobs)
      if (local === `actions/runs/${seal.sourceRun}/artifacts?per_page=100`) return structuredClone(artifacts)
      if (local.startsWith('git/ref/tags/')) return structuredClone(refs.get(decodeURIComponent(local.slice('git/ref/tags/'.length))))
      if (local.startsWith('git/tags/')) return structuredClone(annotatedTags.get(local.slice('git/tags/'.length)))
      if (local.startsWith('releases/')) {
        const id = Number(local.slice('releases/'.length))
        return structuredClone(remoteReleases.find(release => release.id === id))
      }
      assert.fail(`Unexpected remote mutation or read: ${route}`)
    },
    async upload(tag, path) {
      const filename = basename(path)
      assert.ok(largeNames.includes(filename), `Unexpected small-asset upload: ${filename}`)
      const bytes = await readFile(path)
      const expected = seal.files.find(file => file.filename === filename)
      assert.equal(hash(bytes), expected.sha256)
      assert.equal(bytes.length, expected.size)
      const release = remoteReleases.find(value => value.tag_name === tag)
      assert.ok(release)
      assert.ok(!release.assets.some(asset => asset.name === filename), 'An existing asset must never be clobbered')
      uploads.push({ tag, filename })
      release.assets.push({ id: 1000 + uploads.length, name: filename, size: bytes.length,
        digest: `sha256:${hash(bytes)}`, state: 'uploaded' })
    },
  }
  return { root, seal, contents, records, receiptPaths, localPaths,
    run, jobs, artifacts, refs, annotatedTags, remoteReleases, requests, uploads, adapter }
}

test('accepts the exact sealed eleven-file release inventory', async t => {
  const f = await fixture(t)
  assert.deepEqual(validateTransferSeal(f.seal), f.seal)
  await verifyTransferPreflight(f.seal, f.adapter)
  assert.equal(f.uploads.length, 0)
})

const malformedSeals = [
  ['unknown seal field', seal => { seal.extra = true }],
  ['unsupported schema', seal => { seal.schemaVersion = 2 }],
  ['another repository', seal => { seal.repository = 'someone/else' }],
  ['another version', seal => { seal.version = '1.0.4' }],
  ['a noncommit source', seal => { seal.sourceCommit = 'main' }],
  ['a noninteger source run', seal => { seal.sourceRun = 0.5 }],
  ['a nonpositive source run', seal => { seal.sourceRun = 0 }],
  ['an unsafe integer source run', seal => { seal.sourceRun = Number.MAX_SAFE_INTEGER + 1 }],
  ['missing release', seal => { seal.releases.pop() }],
  ['duplicate release identity', seal => { seal.releases[1].id = seal.releases[0].id }],
  ['invalid release ID', seal => { seal.releases[0].id = -1 }],
  ['wrong stable tag', seal => { seal.releases[0].tag = 'v1.0.4' }],
  ['stable marked prerelease', seal => { seal.releases[0].prerelease = true }],
  ['unknown release field', seal => { seal.releases[0].extra = true }],
  ['missing file', seal => { seal.files.pop() }],
  ['duplicate filename', seal => { seal.files[1] = { ...seal.files[0] } }],
  ['unknown filename', seal => { seal.files[0].filename = '../unexpected.exe' }],
  ['empty file', seal => { seal.files[0].size = 0 }],
  ['noninteger file size', seal => { seal.files[0].size = 1.5 }],
  ['file at the GitHub size bound', seal => { seal.files[0].size = 2 * 1024 ** 3 }],
  ['malformed file digest', seal => { seal.files[0].sha256 = 'not-a-hash' }],
  ['unknown file field', seal => { seal.files[0].extra = true }],
]
for (const [label, change] of malformedSeals) test(`rejects ${label} before a remote operation`, async t => {
  const f = await fixture(t)
  change(f.seal)
  assert.throws(() => validateTransferSeal(f.seal))
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.requests.length, 0)
  assert.equal(f.uploads.length, 0)
})

const remoteFailures = [
  ['wrong run identity', f => { f.run.id += 1 }],
  ['wrong source commit', f => { f.run.head_sha = 'c'.repeat(40) }],
  ['a non-main build', f => { f.run.head_branch = 'codex/another-build' }],
  ['a non-dispatch build', f => { f.run.event = 'push' }],
  ['another packaging workflow', f => { f.run.path = '.github/workflows/another.yml' }],
  ['another run repository', f => { f.run.repository.full_name = 'someone/else' }],
  ['unfinished source run', f => { f.run.status = 'in_progress' }],
  ['failed source run', f => { f.run.conclusion = 'failure' }],
  ['incomplete job inventory', f => { f.jobs.total_count = 3 }],
  ['a missing target job', f => { f.jobs.jobs.pop(); f.jobs.total_count = 1 }],
  ['duplicate target jobs', f => { f.jobs.jobs[1] = structuredClone(f.jobs.jobs[0]) }],
  ['failed installer job', f => { f.jobs.jobs[0].conclusion = 'failure' }],
  ['unfinished installer job', f => { f.jobs.jobs[0].status = 'in_progress' }],
  ['missing genuine-installer step', f => { f.jobs.jobs[0].steps = [] }],
  ['failed genuine-installer step', f => { f.jobs.jobs[0].steps[0].conclusion = 'failure' }],
  ['skipped genuine-installer step', f => { f.jobs.jobs[0].steps[0].conclusion = 'skipped' }],
  ['expired artifact', f => { f.artifacts.artifacts[0].expired = true }],
  ['missing acceptance artifact', f => { f.artifacts.artifacts.pop(); f.artifacts.total_count -= 1 }],
  ['artifact from another source', f => { f.artifacts.artifacts[0].workflow_run.head_sha = 'c'.repeat(40) }],
  ['artifact from another run', f => { f.artifacts.artifacts[0].workflow_run.id += 1 }],
  ['artifact without a transport digest', f => { delete f.artifacts.artifacts[0].digest }],
  ['artifact with an invalid transport digest', f => { f.artifacts.artifacts[0].digest = 'sha256:invalid' }],
  ['zero-size original artifact', f => { f.artifacts.artifacts[0].size_in_bytes = 0 }],
  ['invalid original artifact ID', f => { f.artifacts.artifacts[0].id = 0 }],
  ['incomplete artifact response', f => { f.artifacts.total_count += 1 }],
  ['duplicate original artifact', f => { f.artifacts.artifacts.push(structuredClone(f.artifacts.artifacts[0])); f.artifacts.total_count += 1 }],
  ['tag pointing to another source', f => { f.refs.get(f.seal.releases[0].tag).object.sha = 'c'.repeat(40) }],
  ['release with wrong identity', f => { f.remoteReleases[0].id += 1 }],
  ['release with wrong tag', f => { f.remoteReleases[0].tag_name = 'v1.0.4' }],
  ['public release', f => { f.remoteReleases[0].draft = false }],
  ['incorrect prerelease lane', f => { f.remoteReleases[0].prerelease = true }],
  ['unknown remote asset', f => { f.remoteReleases[0].assets.push({ name: 'unsealed.txt', size: 1, state: 'uploaded', digest: `sha256:${'c'.repeat(64)}` }) }],
  ['duplicate remote asset', f => { f.remoteReleases[0].assets.push(structuredClone(f.remoteReleases[0].assets[0])) }],
  ['missing preuploaded small asset', f => { f.remoteReleases[0].assets.pop() }],
  ['small asset size mismatch', f => { f.remoteReleases[0].assets[0].size += 1 }],
  ['small asset digest mismatch', f => { f.remoteReleases[0].assets[0].digest = `sha256:${'c'.repeat(64)}` }],
  ['unfinished small asset upload', f => { f.remoteReleases[0].assets[0].state = 'new' }],
]
for (const [label, change] of remoteFailures) test(`refuses ${label} in preflight without uploading`, async t => {
  const f = await fixture(t)
  change(f)
  await assert.rejects(verifyTransferPreflight(f.seal, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('resolves an annotated tag to the exact sealed source commit', async t => {
  const f = await fixture(t)
  const annotation = 'd'.repeat(40)
  f.refs.get(f.seal.releases[0].tag).object = { type: 'tag', sha: annotation }
  f.annotatedTags.set(annotation, { object: { type: 'commit', sha: sourceCommit } })
  await verifyTransferPreflight(f.seal, f.adapter)
  assert.equal(f.uploads.length, 0)
})

test('rejects an existing large asset with a different digest', async t => {
  const f = await fixture(t)
  const file = f.seal.files.find(value => largeNames.includes(value.filename))
  f.remoteReleases[0].assets.push({ id: 999, name: file.filename, size: file.size,
    digest: `sha256:${'c'.repeat(64)}`, state: 'uploaded' })
  await assert.rejects(verifyTransferPreflight(f.seal, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('binds all five binary paths to the original native build records and installer receipts', async t => {
  const f = await fixture(t)
  const paths = await verifyDownloadedInputs(f.seal, f.root)
  assert.equal(paths.size, 5)
  for (const [filename, path] of paths) {
    assert.equal(path, f.localPaths[filename])
    assert.equal(hash(await readFile(path)), f.seal.files.find(file => file.filename === filename).sha256)
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.uploads.length, 0)
})

for (const [label, diagnosticTargets] of [
  ['Mac only', ['mac-arm64']], ['Windows only', ['win-x64']], ['both targets', targets],
]) test(`accepts a regular builder diagnostic from ${label} without publishing it`, async t => {
  const f = await fixture(t)
  const originalSeal = structuredClone(f.seal)
  const originalRecords = new Map(await Promise.all(targets.map(async target =>
    [target, await readFile(join(f.root, target, 'unsigned-build.json'))])))
  for (const target of diagnosticTargets) await writeFile(join(f.root, target, 'builder-debug.yml'), 'synthetic builder diagnostic\n')
  const paths = await verifyDownloadedInputs(f.seal, f.root)
  assert.deepEqual([...paths.keys()].sort(), filenames.filter(name => name.startsWith('muse-med-')).sort())
  assert.equal(paths.has('builder-debug.yml'), false)
  assert.deepEqual(await transferSealedArtifacts(f.seal, f.root, f.adapter), { uploaded: 6, skipped: 0 })
  assert.ok(f.uploads.every(upload => largeNames.includes(upload.filename)))
  assert.deepEqual(f.seal, originalSeal)
  for (const target of targets) {
    assert.deepEqual(await readFile(join(f.root, target, 'unsigned-build.json')), originalRecords.get(target))
    assert.equal(Object.hasOwn(f.records[target].artifacts, 'builder-debug.yml'), false)
  }
  for (const release of f.remoteReleases) assert.deepEqual(release.assets.map(asset => asset.name).sort(), [...filenames].sort())
  for (const target of diagnosticTargets) assert.equal(await readFile(join(f.root, target, 'builder-debug.yml'), 'utf8'), 'synthetic builder diagnostic\n')
})

for (const target of targets) {
  test(`rejects a builder diagnostic directory in ${target} before uploading`, async t => {
    const f = await fixture(t)
    await mkdir(join(f.root, target, 'builder-debug.yml'))
    await assert.rejects(verifyDownloadedInputs(f.seal, f.root))
    await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
    assert.equal(f.uploads.length, 0)
  })

  test(`rejects a linked builder diagnostic in ${target} before uploading`,
    { skip: process.platform === 'win32' ? 'Creating file symlinks requires Windows privileges unavailable to this fixture.' : false }, async t => {
      const f = await fixture(t)
      const saved = join(f.root, 'saved-diagnostic')
      await writeFile(saved, 'synthetic diagnostic outside the original artifact directory')
      await symlink(saved, join(f.root, target, 'builder-debug.yml'))
      await assert.rejects(verifyDownloadedInputs(f.seal, f.root))
      await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
      assert.equal(f.uploads.length, 0)
    })

  test(`rejects an unknown extra beside a regular builder diagnostic in ${target}`, async t => {
    const f = await fixture(t)
    await writeFile(join(f.root, target, 'builder-debug.yml'), 'known diagnostic')
    await writeFile(join(f.root, target, 'builder-debug.yaml'), 'unknown downloaded input')
    await assert.rejects(verifyDownloadedInputs(f.seal, f.root))
    await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
    assert.equal(f.uploads.length, 0)
  })

  test(`rejects a builder diagnostic declared as a build artifact in ${target}`, async t => {
    const f = await fixture(t)
    const bytes = Buffer.from('synthetic builder diagnostic\n')
    await writeFile(join(f.root, target, 'builder-debug.yml'), bytes)
    f.records[target].artifacts['builder-debug.yml'] = digest(bytes)
    await writeFile(join(f.root, target, 'unsigned-build.json'), jsonBytes(f.records[target]))
    await assert.rejects(verifyDownloadedInputs(f.seal, f.root))
    await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
    assert.equal(f.uploads.length, 0)
  })
}

test('rejects a builder diagnostic declared as a public sealed asset', async t => {
  const f = await fixture(t)
  f.seal.files[0] = { ...f.seal.files[0], filename: 'builder-debug.yml' }
  assert.throws(() => validateTransferSeal(f.seal))
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.requests.length, 0)
  assert.equal(f.uploads.length, 0)
})

const recordFailures = [
  ['unknown build-record field', record => { record.extra = true }],
  ['wrong schema', record => { record.schemaVersion = 2 }],
  ['wrong target', record => { record.target = 'win-x64' }],
  ['wrong version', record => { record.version = '1.0.4' }],
  ['wrong source', record => { record.sourceCommit = 'c'.repeat(40) }],
  ['signed record', record => { record.unsigned = false }],
  ['missing original file hash', record => { delete record.artifacts['latest-mac.yml'] }],
  ['unexpected original artifact', record => { record.artifacts['extra.txt'] = digest(Buffer.from('extra')) }],
  ['incorrect original SHA256', record => { record.artifacts['latest-mac.yml'].sha256 = 'c'.repeat(64) }],
  ['incorrect original SHA512', record => { record.artifacts['latest-mac.yml'].sha512 = hash(Buffer.from('different'), 'sha512', 'base64') }],
  ['malformed original SHA512', record => { record.artifacts['latest-mac.yml'].sha512 = 'invalid' }],
  ['malformed original SHA256', record => { record.artifacts['latest-mac.yml'].sha256 = 'invalid' }],
  ['incorrect original size', record => { record.artifacts['latest-mac.yml'].size += 1 }],
  ['unknown original digest field', record => { record.artifacts['latest-mac.yml'].extra = true }],
]
for (const [label, change] of recordFailures) test(`rejects ${label} before any asset upload`, async t => {
  const f = await fixture(t)
  await verifyDownloadedInputs(f.seal, f.root)
  change(f.records['mac-arm64'])
  await writeFile(join(f.root, 'mac-arm64', 'unsigned-build.json'), jsonBytes(f.records['mac-arm64']))
  await assert.rejects(verifyDownloadedInputs(f.seal, f.root))
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

const receiptFailures = [
  ['unsuccessful installation', receipt => { receipt.success = false }],
  ['another product version', receipt => { receipt.version = '1.0.4' }],
  ['another source commit', receipt => { receipt.sourceCommit = 'c'.repeat(40) }],
  ['another installer target', receipt => { receipt.target = 'win-x64' }],
  ['another installer digest', receipt => { receipt.installerSha256 = 'c'.repeat(64) }],
  ['failed complete payload comparison', receipt => { receipt.completeInstalledPayload.passed = false }],
  ['no compared files', receipt => { receipt.completeInstalledPayload.comparedFiles = 0 }],
  ['noninteger compared-file count', receipt => { receipt.completeInstalledPayload.comparedFiles = 0.5 }],
  ['failed installed runtime smoke', receipt => { receipt.installedRuntimeSmoke.passed = false }],
  ['no readonly DMG mount', receipt => { receipt.dmgMountedReadOnly = false }],
]
for (const [label, change] of receiptFailures) test(`rejects a receipt with ${label} before uploading`, async t => {
  const f = await fixture(t)
  await verifyDownloadedInputs(f.seal, f.root)
  const receipt = JSON.parse(await readFile(f.receiptPaths['mac-arm64'], 'utf8'))
  change(receipt)
  await writeFile(f.receiptPaths['mac-arm64'], jsonBytes(receipt))
  await assert.rejects(verifyDownloadedInputs(f.seal, f.root))
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('requires Windows silent installation in the original receipt', async t => {
  const f = await fixture(t)
  const receipt = JSON.parse(await readFile(f.receiptPaths['win-x64'], 'utf8'))
  receipt.silentInstallerExecuted = false
  await writeFile(f.receiptPaths['win-x64'], jsonBytes(receipt))
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('requires exactly one native acceptance receipt per target', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'acceptance', 'mac-arm64', 'acceptance.json'), await readFile(f.receiptPaths['mac-arm64']))
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('rejects missing native acceptance evidence', async t => {
  const f = await fixture(t)
  await rm(f.receiptPaths['mac-arm64'])
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('rejects binary byte changes even when the byte count remains identical', async t => {
  const f = await fixture(t)
  const filename = largeNames[0]
  const changed = Buffer.from(f.contents.get(filename))
  changed[0] ^= 1
  await writeFile(f.localPaths[filename], changed)
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('rejects a binary that agrees with its build record but differs from the publication seal', async t => {
  const f = await fixture(t)
  const filename = largeNames[0]
  const changed = Buffer.from('another verified build binary')
  await writeFile(f.localPaths[filename], changed)
  f.records['mac-arm64'].artifacts[filename] = digest(changed)
  await writeFile(join(f.root, 'mac-arm64', 'unsigned-build.json'), jsonBytes(f.records['mac-arm64']))
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('rejects a missing original binary before uploading any target', async t => {
  const f = await fixture(t)
  await unlink(f.localPaths[largeNames[0]])
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('rejects original metadata changes independently of the normalized public metadata seal', async t => {
  const f = await fixture(t)
  await writeFile(f.localPaths['latest-mac.yml'], 'modified original updater metadata')
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('rejects an unexpected downloaded file before uploading', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'mac-arm64', 'extra.txt'), 'unexpected downloaded input')
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('rejects an oversized original JSON record before reading it', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'mac-arm64', 'unsigned-build.json'), Buffer.alloc(131073, 0x20))
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('rejects a linked original binary while the directory inventory remains identical',
  { skip: process.platform === 'win32' ? 'Creating file symlinks requires Windows privileges unavailable to this fixture.' : false }, async t => {
    const f = await fixture(t)
    const filename = largeNames[0]
    const saved = join(f.root, 'saved-binary')
    await writeFile(saved, f.contents.get(filename))
    await unlink(f.localPaths[filename])
    await symlink(saved, f.localPaths[filename])
    try {
      await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
      assert.equal(f.uploads.length, 0)
    } finally {
      await unlink(f.localPaths[filename])
    }
  })

test('uploads only the three absent binaries to each draft and verifies all eleven assets', async t => {
  const f = await fixture(t)
  const events = []
  const result = await transferSealedArtifacts(f.seal, f.root, f.adapter, event => { events.push(event) })
  assert.deepEqual(result, { uploaded: 6, skipped: 0 })
  assert.equal(f.uploads.length, 6)
  assert.equal(events.length, 6)
  assert.ok(events.every(event => event.status === 'uploaded'))
  for (const release of f.remoteReleases) {
    assert.equal(release.draft, true)
    assert.deepEqual(release.assets.map(asset => asset.name).sort(), [...filenames].sort())
    assert.equal(f.uploads.filter(upload => upload.tag === release.tag_name).length, 3)
  }
})

test('skips matching large assets without clobber and uploads only missing counterparts', async t => {
  const f = await fixture(t)
  for (const filename of largeNames) {
    const file = f.seal.files.find(value => value.filename === filename)
    f.remoteReleases[0].assets.push({ id: 1000 + f.remoteReleases[0].assets.length, name: filename,
      size: file.size, digest: `sha256:${file.sha256}`, state: 'uploaded' })
  }
  const result = await transferSealedArtifacts(f.seal, f.root, f.adapter)
  assert.deepEqual(result, { uploaded: 3, skipped: 3 })
  assert.equal(f.uploads.length, 3)
  assert.ok(f.uploads.every(upload => upload.tag === f.seal.releases[1].tag))
  assert.ok(f.remoteReleases.every(release => release.draft && release.assets.length === 11))
})

test('performs no upload when both drafts already contain all sealed assets', async t => {
  const f = await fixture(t)
  for (const release of f.remoteReleases) for (const filename of largeNames) {
    const file = f.seal.files.find(value => value.filename === filename)
    release.assets.push({ id: 1000 + release.assets.length, name: filename,
      size: file.size, digest: `sha256:${file.sha256}`, state: 'uploaded' })
  }
  assert.deepEqual(await transferSealedArtifacts(f.seal, f.root, f.adapter), { uploaded: 0, skipped: 6 })
  assert.equal(f.uploads.length, 0)
  assert.ok(f.remoteReleases.every(release => release.draft && release.assets.length === 11))
})

test('rechecks drafts before each upload and refuses a release made public after input validation', async t => {
  const f = await fixture(t)
  const json = f.adapter.json
  let reads = 0
  f.adapter.json = async route => {
    if (route === `releases/${f.seal.releases[0].id}` && ++reads === 2) f.remoteReleases[0].draft = false
    return await json(route)
  }
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('refuses same-size binary changes after input verification and before the first upload', async t => {
  const f = await fixture(t)
  const json = f.adapter.json
  let reads = 0
  f.adapter.json = async route => {
    if (route === `releases/${f.seal.releases[0].id}` && ++reads === 2) {
      const filename = largeNames[0]
      const changed = Buffer.from(f.contents.get(filename))
      changed[0] ^= 1
      await writeFile(f.localPaths[filename], changed)
    }
    return await json(route)
  }
  f.adapter.upload = async (tag, path) => { f.uploads.push({ tag, filename: basename(path) }) }
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 0)
})

test('requires the completed upload to appear with the sealed digest in the draft', async t => {
  const f = await fixture(t)
  f.adapter.upload = async (tag, path) => { f.uploads.push({ tag, filename: basename(path) }) }
  await assert.rejects(transferSealedArtifacts(f.seal, f.root, f.adapter))
  assert.equal(f.uploads.length, 1)
  assert.ok(f.remoteReleases.every(release => release.draft && release.assets.length === 8))
})
