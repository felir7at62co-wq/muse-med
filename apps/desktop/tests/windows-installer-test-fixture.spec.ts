import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { assertInstallerNegativeControl, assertVisualCppPrerequisiteReceipt, createInstallerTestSource } from '../scripts/windows-installer-test-fixture.mjs'

it('copies production prerequisite checks and confines the reboot switch to private fixtures', async () => {
  const source = await readFile(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const fixture = createInstallerTestSource(source, root)
  expect(source).not.toContain('TEST_REBOOT_REQUIRED')
  expect(fixture).toContain(`!define INSTALLER_SOURCE_DIR "${join(root, 'installer')}"`)
  expect(fixture).toContain(`!include "${join(root, 'scripts', 'installer-directories.nsh')}"`)
  expect(fixture).toContain('ReadRegDWORD $4 HKLM "SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64" "Installed"')
  expect(fixture).toContain('${VersionCompare} "$0.$1.$2.$3" "14.51.36247.0" $5')
  expect(fixture).toMatch(/Call MuseEnsureVCRuntime[\s\S]*?GetOptions[\s\S]*?SetRebootFlag true[\s\S]*?ClearErrors/u)
  expect(() => createInstallerTestSource(source.replace('  Call MuseEnsureVCRuntime', ''), root)).toThrow('requires one production marker')
  expect(() => createInstallerTestSource(source + '\n  Call MuseEnsureVCRuntime', root)).toThrow('requires one production marker')
})

const receipt = { primaryFailure: 'Injected automatic update failure after relaunch', cleanupFailures: [],
  negativeControlRequested: true, negativeControlReached: true, negativeControlProcessId: 2345,
  discoveredAppProcessIds: [2345], remainingAppProcessIds: [], applicationRemoved: true, uninstallerRemoved: true,
  installDirectoryExists: false, uninstallRegistryExists: false, uninstallExitCode: 0 }
const failure = Object.assign(new Error(receipt.primaryFailure), { code: 1, signal: null, killed: false })

it('requires the recorded installed x64 runtime and rejects stale, wrong-view and reboot results', () => {
  const vc = { version: 1, requiredVersion: '14.51.36247.0', registryView: 'Registry64',
    registryPath: 'SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', after: { installed: 1, version: '14.51.36247.0' },
    installExitCode: null, rebootRequired: false, passed: true }
  expect(() => { assertVisualCppPrerequisiteReceipt(vc) }).not.toThrow()
  expect(() => { assertVisualCppPrerequisiteReceipt({ ...vc, after: { installed: 1, version: '14.52.0.0' }, installExitCode: 0 }) }).not.toThrow()
  for (const patch of [{ registryView: 'Registry32' }, { passed: false }, { rebootRequired: true }, { installExitCode: 3010 },
    { installExitCode: 1638 }, { after: { installed: 0, version: '14.51.36247.0' } },
    { after: { installed: '1', version: '14.51.36247.0' } }, { after: { installed: 1, version: '14.51.36246.99' } },
    { after: { installed: 1, version: '14.50.99999.0' } }, { after: { installed: 1, version: 'unknown' } }]) {
    expect(() => { assertVisualCppPrerequisiteReceipt({ ...vc, ...patch }) }).toThrow()
  }
  expect(() => { assertVisualCppPrerequisiteReceipt(null) }).toThrow('requires its Visual C++ registry receipt')
})

it('accepts only the observed relaunch failure followed by complete private cleanup', () => {
  expect(() => { assertInstallerNegativeControl(failure, receipt) }).not.toThrow()
  for (const error of [undefined, new Error('other failure'), Object.assign(new Error('timeout'), { code: 1, killed: true }),
    Object.assign(new Error('signal'), { code: 1, signal: 'SIGTERM' }), Object.assign(new Error('other exit'), { code: 2 })]) {
    expect(() => { assertInstallerNegativeControl(error, receipt) }).toThrow('must exit 1 without interruption')
  }
  for (const patch of [{ primaryFailure: 'unexpected failure' }, { negativeControlRequested: false },
    { negativeControlReached: false }, { negativeControlProcessId: 0 }, { discoveredAppProcessIds: [] },
    { discoveredAppProcessIds: [2345, 'wrong PID'] }, { remainingAppProcessIds: [2345] },
    { cleanupFailures: ['uninstall failed'] }, { applicationRemoved: false }, { uninstallerRemoved: false },
    { installDirectoryExists: true }, { uninstallRegistryExists: true }, { uninstallExitCode: null }, { uninstallExitCode: 1 }]) {
    expect(() => { assertInstallerNegativeControl(failure, { ...receipt, ...patch }) }).toThrow('did not prove relaunch and complete cleanup')
  }
  expect(() => { assertInstallerNegativeControl(failure, null) }).toThrow('requires its cleanup receipt')
})

it('records Registry64 prerequisite verification and stops before native checks when reboot is required', async () => {
  const source = await readFile(new URL('../scripts/prepare-windows-installer-prerequisite.ps1', import.meta.url), 'utf8')
  expect(source).toContain('[Microsoft.Win32.RegistryView]::Registry64')
  expect(source).toContain("$requiredVersion = [version]'14.51.36247.0'")
  expect(source).toContain('$Snapshot.installed -eq 1')
  expect(source).toContain("@('Major', 'Minor', 'Bld', 'Rbld')")
  expect(source).toContain("'/install /quiet /norestart'")
  expect(source).toContain('$receipt.installExitCode -eq 3010')
  expect(source).toContain('requires a Windows restart; native UI qualification has not run')
  expect(source.indexOf('if ($receipt.rebootRequired)')).toBeLessThan(source.indexOf('$receipt.passed = $true'))
  expect(source).toContain('ConvertTo-Json -Depth 5')
  const launcher = await readFile(new URL('../scripts/test-windows-installer.mjs', import.meta.url), 'utf8')
  expect(launcher).toContain('config.win.executableName = productName')
  expect(launcher).toContain("'--vc-redist-only'")
  expect(launcher).toContain("'vc-runtime-receipt.json'")
  expect(launcher).toContain("'-FailAfterAutomaticRelaunch'")
  expect(launcher).toContain("join(languageOutput, 'negative-cleanup')")
  expect(launcher).toContain('assertInstallerNegativeControl(injectedFailure, receipt)')
})
