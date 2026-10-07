/** Private acceptance of the original Muse Windows installer; does not create release artifacts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readAsar, type Node } from '../../../apps/desktop/node_modules/app-builder-lib/out/asar/asar.js'
import { load } from 'js-yaml'
import { smokePreparedRuntime } from '../../../apps/desktop/scripts/smoke-prepared-runtime.ts'
import type { DesktopRuntimeDescriptor } from '../../../apps/desktop/src/runtime-tree.ts'

const sourceCommit = process.env.MUSE_CI_TRANSFER_SOURCE_COMMIT
assert.ok(sourceCommit !== undefined && /^[0-9a-f]{40}$/.test(sourceCommit),
  'MUSE_CI_TRANSFER_SOURCE_COMMIT must contain an explicit complete source commit')
const [artifactRoot, payloadRoot, installedRoot, reportPath, stubRoot] = process.argv.slice(2)
assert.ok(artifactRoot && payloadRoot && installedRoot && reportPath && stubRoot,
  'Pass artifact, extracted payload, installed directory, report and original NSIS contents')
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This utility only operates in disposable GitHub Actions runners')

async function hash(path: string): Promise<{ bytes: number; sha256: string }> {
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'A regular payload file is required')
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return { bytes: info.size, sha256: digest.digest('hex') }
}

async function inventory(root: string, directory = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`
    assert.ok(!entry.isSymbolicLink(), 'Linked installed or extracted payload entries are refused')
    if (entry.isDirectory()) result.push(...await inventory(root, path))
    else { assert.ok(entry.isFile(), 'Special installed or extracted payload entries are refused'); result.push(path) }
  }
  return result.sort()
}

function archiveFilenames(node: Node, directory = ''): string[] {
  assert.equal(node.link, undefined, 'Linked archive entries are refused')
  if (node.files === undefined) return [directory]
  return Object.entries(node.files).flatMap(([name, entry]) =>
    archiveFilenames(entry, directory === '' ? name : `${directory}/${name}`))
}

const report: Record<string, unknown> = { sourceCommit, version: '1.0.3', target: 'win-x64', success: false,
  platformNetworkDownloads: 'not-performed', interactiveInstaller: 'not-performed', guiLaunch: 'not-performed',
  cleanMachineQualification: 'not-performed', signatureQualification: 'not-performed' }
const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
try {
  const record = JSON.parse(await readFile(join(artifactRoot, 'unsigned-build.json'), 'utf8'))
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.sourceCommit, sourceCommit)
  assert.equal(record.target, 'win-x64')
  assert.equal(record.version, '1.0.3')
  assert.equal(record.unsigned, true)
  const update = load(await readFile(join(artifactRoot, 'latest.yml'), 'utf8')) as {
    version: string; files: Array<{ url: string; size: number; sha512: string }>
  }
  assert.equal(update.version, '1.0.3')
  assert.equal(update.files.length, 1)
  assert.equal(update.files[0]?.url, 'muse-med-1.0.3-win-x64.exe')
  assert.equal(update.files[0]?.size, record.artifacts['muse-med-1.0.3-win-x64.exe'].size)
  assert.equal(update.files[0]?.sha512, record.artifacts['muse-med-1.0.3-win-x64.exe'].sha512)
  report.installerSha256 = record.artifacts['muse-med-1.0.3-win-x64.exe'].sha256

  const resources = join(installedRoot, 'resources')
  const archivePath = join(resources, 'app.asar')
  const archive = await readAsar(archivePath)
  const manifest = JSON.parse((await archive.readFile('package.json')).toString('utf8'))
  assert.equal(manifest.name, 'muse-med')
  assert.equal(manifest.version, '1.0.3')
  assert.equal(manifest.dshDesktopAppId, 'cn.muse.med')
  assert.equal(manifest.dshBuildCommit, sourceCommit)
  assert.equal(manifest.dshBuildDirty, false)
  const descriptor = JSON.parse((await archive.readFile(join('dsh', 'desktop-runtime.json'))).toString('utf8')) as DesktopRuntimeDescriptor
  assert.equal(descriptor.platform, 'win32')
  assert.equal(descriptor.arch, 'x64')
  const asar = await hash(archivePath)
  report.appAsarSha256 = asar.sha256
  report.appAsarBytes = asar.bytes
  report.manifestIdentity = { version: manifest.version, harnessVersion: manifest.dshHarnessVersion,
    sourceCommit: manifest.dshBuildCommit, dirty: manifest.dshBuildDirty, appId: manifest.dshDesktopAppId }
  await persist()

  const names = await inventory(payloadRoot)
  assert.ok(names.includes('resources/app.asar') && names.includes('muse-med.exe'))
  const installedNames = await inventory(installedRoot)
  const sourceNames = new Set(names)
  const generated = installedNames.filter(name => !sourceNames.has(name))
  report.installerGeneratedFiles = generated
  await persist()
  const licenseNames = ['7zip-installer-LICENSE.txt', '7zip-installer-COPYING.txt']
  const allowedGenerated = ['Uninstall muse-med.exe', 'uninstallerIcon.ico', ...licenseNames]
  assert.ok(generated.every(name => allowedGenerated.includes(name)),
    'The installer produced an unexpected file outside its original application payload')
  const stubNames = await inventory(stubRoot)
  const licenses: Array<{ filename: string; bytes: number; sha256: string }> = []
  for (const filename of licenseNames) {
    assert.ok(generated.includes(filename), 'An original bootstrap license is missing from the installation')
    const references = stubNames.filter(name => basename(name) === filename)
    assert.equal(references.length, 1, 'The original NSIS container must contain exactly one bootstrap license')
    const expected = await hash(join(stubRoot, ...references[0]!.split('/')))
    const actual = await hash(join(installedRoot, filename))
    assert.deepEqual(actual, expected, `Installed bootstrap license differs: ${filename}`)
    licenses.push({ filename, ...actual })
  }
  report.installedBootstrapLicenseComparison = { passed: true, files: licenses }
  await persist()
  const sealed = createHash('sha256')
  let totalBytes = 0
  for (const name of names) {
    const expected = await hash(join(payloadRoot, ...name.split('/')))
    const actual = await hash(join(installedRoot, ...name.split('/')))
    assert.deepEqual(actual, expected, `Installed payload differs: ${name}`)
    sealed.update(`${name}\0${actual.bytes}\0${actual.sha256}\n`)
    totalBytes += actual.bytes
  }
  report.completePayloadByteComparison = { passed: true, files: names.length, bytes: totalBytes,
    inventorySha256: sealed.digest('hex'), installerGeneratedFiles: generated }
  const forbidden = new Set(['.env', '.env.windows', '.env.macos', 'devices.json'])
  const privateFiles = [...names, ...archiveFilenames(archive.header)].filter(name => forbidden.has(basename(name)))
  assert.deepEqual(privateFiles, [], 'A excluded local environment or saved device file reached the installed payload')
  report.privateFilenameCheck = { passed: true, filenames: [...forbidden], universalSecretScan: false }
  await persist()

  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), join(installedRoot, 'muse-med.exe'),
    join(resources, 'runtime'), descriptor)
  assert.deepEqual(await hash(archivePath), asar, 'Installed ASAR changed during acceptance')
  // Hashing every original payload member again establishes that smoke wrote only private disposable data.
  const after = createHash('sha256')
  for (const name of names) {
    const actual = await hash(join(installedRoot, ...name.split('/')))
    after.update(`${name}\0${actual.bytes}\0${actual.sha256}\n`)
  }
  assert.equal(after.digest('hex'), (report.completePayloadByteComparison as { inventorySha256: string }).inventorySha256)
  for (const { filename, ...expected } of licenses) {
    assert.deepEqual(await hash(join(installedRoot, filename)), expected, 'Installed bootstrap license changed during acceptance')
  }
  report.sealedRuntimeSmoke = { passed: true, archiveInventory: true, freshNativeCache: true,
    nativePayload: true, hongguoLoopbackSigner: true, hongguoOfflinePythonAes: true,
    packagedHost: true, productPresetsAndSkills: true, officeConversionsAndCli: true, teardown: true }
  report.installedPayloadUnchangedAfterSmoke = true
  report.success = true
  await persist()
  console.log(JSON.stringify({ stage: 'installed-acceptance-complete', sourceCommit, appAsarSha256: asar.sha256,
    payloadFiles: names.length, payloadBytes: totalBytes, success: true }))
} catch (error) {
  report.failed = true
  report.failureClass = error instanceof Error ? error.name : 'UnknownFailure'
  await persist()
  throw error
}
