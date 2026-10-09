/** Test-only qualification of genuine unsigned installers in disposable native CI runners. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js'
import { isEntry } from '../../../scripts/release/process.ts'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { desktopTargetBuildPaths, desktopTargetPlatform } from './desktop-build-paths.mjs'
import { readDesktopProductVersion } from './desktop-build-version.mjs'
import { createPackagingRun } from './packaging-run.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { verifyMacOSAdHocSignature } from './verify-macos-signature.mjs'

interface AcceptanceIdentity {
  readonly target: 'win-x64' | 'mac-arm64'
  readonly version: string
  readonly sourceCommit: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Require the installed ASAR manifest to identify the exact clean Muse build.
 * @param value Manifest decoded from the application inside the genuine installer.
 * @param expected Source and version selected by the current CI checkout.
 * @returns Nothing; incompatible or incomplete identity throws.
 */
export function assertMuseInstalledIdentity(value: unknown, expected: AcceptanceIdentity): void {
  assert.ok(record(value), 'Installer acceptance: invalid application manifest')
  assert.equal(value.name, 'muse-med', 'Installer acceptance: another application')
  assert.equal(value.version, expected.version, 'Installer acceptance: another version')
  assert.equal(value.dshDesktopAppId, 'cn.muse.med', 'Installer acceptance: another application identifier')
  assert.equal(value.dshBuildCommit, expected.sourceCommit, 'Installer acceptance: another source commit')
  assert.equal(value.dshBuildDirty, false, 'Installer acceptance: modified source build')
}

/**
 * Validate the original unsigned completion record before executing its installer.
 * @param value Original build identity JSON beside the completed installer.
 * @param expected Native target and exact source/version identity.
 * @param filename Exact installer filename selected for this target.
 * @returns The recorded installer size and hashes for complete byte verification.
 */
export function museAcceptanceArtifact(value: unknown, expected: AcceptanceIdentity, filename: string): {
  size: number
  sha256: string
  sha512: string
} {
  assert.ok(record(value) && record(value.artifacts), 'Installer acceptance: missing build record')
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.target, expected.target)
  assert.equal(value.version, expected.version)
  assert.equal(value.sourceCommit, expected.sourceCommit)
  assert.equal(value.unsigned, true)
  const artifact = value.artifacts[filename]
  assert.ok(record(artifact) && typeof artifact.size === 'number' && Number.isSafeInteger(artifact.size) && artifact.size > 0
    && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(artifact.sha256)
    && typeof artifact.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/u.test(artifact.sha512),
  'Installer acceptance: invalid installer digest')
  return { size: artifact.size, sha256: artifact.sha256, sha512: artifact.sha512 }
}

async function fileDigests(path: string): Promise<{ size: number; sha256: string; sha512: string }> {
  const sha256 = createHash('sha256'), sha512 = createHash('sha512')
  let size = 0
  for await (const bytes of createReadStream(path)) { size += bytes.length; sha256.update(bytes); sha512.update(bytes) }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

/**
 * Require the two license files embedded by the Windows directory installer.
 * @param tool Original builder-selected 7-Zip executable, with licenses two directories above it.
 * @returns Installed filenames and complete size/SHA-256 values from the actual installer inputs.
 */
export async function museAcceptanceWindowsLicenses(tool: string): Promise<Record<string, string>> {
  const directory = dirname(dirname(tool))
  const files: Record<string, string> = {}
  for (const [installed, source] of [
    ['7zip-installer-LICENSE.txt', 'LICENSE.txt'], ['7zip-installer-COPYING.txt', 'COPYING'],
  ] as const) {
    const digest = await fileDigests(join(directory, source))
    assert.ok(digest.size > 0, `Installer acceptance: empty 7-Zip license ${source}`)
    files[installed] = `${digest.size}:${digest.sha256}`
  }
  return files
}

async function payloadInventory(root: string, directory = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = directory === '' ? entry.name : `${directory}/${entry.name}`
    const path = join(root, ...name.split('/'))
    if (entry.isDirectory()) Object.assign(files, await payloadInventory(root, name))
    else if (entry.isSymbolicLink()) files[name] = `link:${await readlink(path)}`
    else {
      assert.ok(entry.isFile(), 'Installer acceptance: special payload entry')
      const digest = await fileDigests(path)
      files[name] = `${digest.size}:${digest.sha256}`
    }
  }
  return files
}

/**
 * Compare every installed file and link with the assembled application payload.
 * @param expected Original assembled application inventory.
 * @param actual Files found after genuine installation or copying from the mounted DMG.
 * @param target Installer target, allowing only the Windows-generated uninstaller files.
 * @returns Nothing; a missing, changed or unexpected payload throws.
 */
export function assertMuseInstalledPayload(expected: Readonly<Record<string, string>>, actual: Readonly<Record<string, string>>,
  target: AcceptanceIdentity['target']): void {
  assert.ok(Object.keys(expected).length > 0, 'Installer acceptance: empty original payload')
  for (const [name, digest] of Object.entries(expected)) assert.equal(actual[name], digest, `Installed payload differs: ${name}`)
  const generated = target === 'win-x64' ? new Set(['Uninstall muse-med.exe', 'uninstallerIcon.ico']) : new Set<string>()
  assert.deepEqual(Object.keys(actual).filter(name => !Object.hasOwn(expected, name) && !generated.has(name)), [],
    'Installer acceptance: unexpected installed payload')
}

/**
 * Reject any installed file or link mutation during the real runtime smoke.
 * @param before Complete installed inventory captured after installer verification.
 * @param after Complete installed inventory after Host and native runtime teardown.
 * @returns Nothing; additions, removals or byte/link changes throw.
 */
export function assertMuseInstalledUnchanged(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): void {
  assert.deepEqual(after, before, 'Installer acceptance: installed application changed during smoke')
}

async function main(): Promise<void> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installer acceptance requires a disposable GitHub Actions runner')
  const target = process.env.MUSE_RELEASE_TARGET
  assert.ok(target === 'win-x64' || target === 'mac-arm64', 'Installer acceptance: unsupported target')
  const platform = desktopTargetPlatform(target)
  assert.equal(process.platform, platform.platform, 'Installer acceptance requires the native target OS')
  assert.equal(process.arch, platform.arch, 'Installer acceptance requires the native target architecture')
  const sourceCommit = process.env.GITHUB_SHA
  assert.ok(sourceCommit !== undefined && /^[a-f0-9]{40}$/u.test(sourceCommit), 'Installer acceptance: missing source commit')
  const version = readDesktopProductVersion()
  const identity: AcceptanceIdentity = { target, version, sourceCommit }
  const paths = desktopTargetBuildPaths(target)
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'muse-installer-acceptance-'))
  const installed = join(root, target === 'win-x64' ? 'installed' : 'muse-med.app')
  const mount = join(root, 'mounted')
  const report: Record<string, unknown> = { ...identity, success: false, guiLaunch: 'not-performed', paidProviderCalls: 'not-performed' }
  const persist = () => writeFile(join(root, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/iu.test(name)))
  environment.NODE_OPTIONS = ''
  const run = createPackagingRun(join(root, 'processes'), identity)
  const execute = promisify(execFile)
  let mounted = false
  console.log(`Muse installer acceptance evidence: ${root}`)
  try {
    const filename = `muse-med-${version}-${target === 'win-x64' ? 'win-x64.exe' : 'mac-arm64.dmg'}`
    const installer = join(paths.unsignedArtifacts, filename)
    const original: unknown = JSON.parse(await readFile(join(paths.unsignedArtifacts, 'unsigned-build.json'), 'utf8'))
    const installerDigest = await fileDigests(installer)
    assert.deepEqual(installerDigest, museAcceptanceArtifact(original, identity, filename),
      'Installer acceptance: installer changed after build verification')
    report.installerSha256 = installerDigest.sha256
    await persist()
    if (target === 'win-x64') {
      await run.run('install-original-exe', 'pwsh', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; $p = Start-Process -FilePath $env:MUSE_ACCEPT_INSTALLER -ArgumentList ("/S /CURRENTUSER /D=" + $env:MUSE_ACCEPT_INSTALL_ROOT) -PassThru; $p.WaitForExit(); exit $p.ExitCode'],
      { cwd: root, env: { ...environment, MUSE_ACCEPT_INSTALLER: installer, MUSE_ACCEPT_INSTALL_ROOT: installed }, timeoutMs: 1_200_000 })
      report.silentInstallerExecuted = true
    } else {
      await mkdir(mount)
      await execute('/usr/bin/hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount],
        { env: environment, timeout: 120_000 })
      mounted = true
      await execute('/usr/bin/ditto', [join(mount, 'muse-med.app'), installed], { env: environment, timeout: 600_000 })
      report.dmgMountedReadOnly = true
      verifyMacOSAdHocSignature(installed, 'cn.muse.med')
      const architecture = await execute('/usr/bin/lipo', ['-archs', join(installed, 'Contents/MacOS/muse-med')],
        { env: environment, timeout: 60_000 })
      assert.equal(architecture.stdout.trim(), 'arm64')
    }
    const assembled = target === 'win-x64' ? join(paths.unsignedArtifacts, 'win-unpacked')
      : join(paths.unsignedArtifacts, 'mac-arm64', 'muse-med.app')
    const expectedFiles = await payloadInventory(assembled)
    if (target === 'win-x64') Object.assign(expectedFiles, await museAcceptanceWindowsLicenses(await getPath7za()))
    const installedFiles = await payloadInventory(installed)
    assertMuseInstalledPayload(expectedFiles, installedFiles, target)
    report.completeInstalledPayload = { comparedFiles: Object.keys(expectedFiles).length, passed: true }
    const application = target === 'win-x64' ? installed : join(installed, 'Contents')
    const resources = join(application, target === 'win-x64' ? 'resources' : 'Resources')
    const executable = target === 'win-x64' ? join(application, 'muse-med.exe') : join(application, 'MacOS/muse-med')
    const archivePath = join(resources, 'app.asar')
    const archive = await readAsar(archivePath)
    const manifest: unknown = JSON.parse((await archive.readFile('package.json')).toString('utf8'))
    assertMuseInstalledIdentity(manifest, identity)
    const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version, platform)
    await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
    assertMuseInstalledUnchanged(installedFiles, await payloadInventory(installed))
    report.installedRuntimeSmoke = { passed: true, archiveInventory: true, nativePayload: true,
      packagedHost: true, productPresetsAndSkills: true, officeConversions: true, teardown: true }
    report.success = true
    run.finish(true)
  } catch (error) {
    report.failureClass = error instanceof Error ? error.name : 'UnknownFailure'
    run.finish(false)
    throw error
  } finally {
    try {
      if (mounted) await execute('/usr/bin/hdiutil', ['detach', mount], { env: environment, timeout: 60_000 })
      await rm(installed, { recursive: true, force: true })
    } catch (error) {
      report.success = false
      report.cleanupFailure = error instanceof Error ? error.name : 'UnknownFailure'
      throw error
    } finally {
      await persist()
    }
  }
  console.log(JSON.stringify({ stage: 'genuine-installer-accepted', ...identity, success: report.success }))
}

if (isEntry(import.meta.url)) await main()
