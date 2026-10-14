import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { assertInstallerNegativeControl, assertVisualCppPrerequisiteReceipt, createInstallerTestPagesSource, createInstallerTestSource } from '../scripts/windows-installer-test-fixture.mjs'

it('copies production prerequisite checks and confines the reboot switch to private fixtures', async () => {
  const source = await readFile(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const fixture = createInstallerTestSource(source, root)
  expect(source).not.toContain('TEST_REBOOT_REQUIRED')
  expect(fixture).toContain(`!define INSTALLER_SOURCE_DIR "${join(root, 'installer')}"`)
  expect(fixture).toContain(`!include "${join(root, 'scripts', 'installer-directories.nsh')}"`)
  expect(source).not.toContain('INSTALLER_TEST_PAGES_FILE')
  expect(fixture).toContain('!include "${INSTALLER_TEST_PAGES_FILE}"')
  expect(fixture).toContain('ReadRegDWORD $4 HKLM "SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64" "Installed"')
  expect(fixture).toContain('${VersionCompare} "$0.$1.$2.$3" "14.51.36247.0" $5')
  expect(fixture).toMatch(/Call MuseEnsureVCRuntime[\s\S]*?GetOptions[\s\S]*?SetRebootFlag true[\s\S]*?ClearErrors/u)
  expect(() => createInstallerTestSource(source.replace('  Call MuseEnsureVCRuntime', ''), root)).toThrow('requires one production marker')
  expect(() => createInstallerTestSource(source + '\n  Call MuseEnsureVCRuntime', root)).toThrow('requires one production marker')
})

it('retains each actual page operation and confines stage receipts to the private fixture', async () => {
  const source = await readFile(new URL('../installer/pages.nsh', import.meta.url), 'utf8')
  const fixture = createInstallerTestPagesSource(source)
  expect(source).not.toContain('InstallerFixtureTrace')
  const callbacks = fixture.slice(fixture.indexOf('!macroend\n\n') + '!macroend\n\n'.length)
  const sourceWithOriginalIncludes = source.replaceAll('${__FILEDIR__}', '${INSTALLER_SOURCE_DIR}')
  expect(callbacks.split('\n').filter(line => !line.includes('!insertmacro InstallerFixtureTrace')).join('\n')).toBe(sourceWithOriginalIncludes)
  expect(callbacks).toContain('"before-launch" "elevated-shell"')
  expect(callbacks).toContain('"after-launch" "elevated-shell" "$1"')
  expect(callbacks).toContain('"before-launch" "direct-exec"')
  expect(callbacks).toContain('"after-launch" "direct-exec"')
  expect(callbacks).toMatch(/SendMessage \$HWNDPARENT[^\n]*\n\s*!insertmacro InstallerFixtureTrace "outer-next-return"/u)
  expect(fixture).toContain('IfErrors 0 +2')
  expect(fixture).toContain('${If} $3 == 1\n        SetErrors\n    ${Else}\n        ClearErrors')
  for (const register of ['$0', '$1', '$2', '$3']) {
    expect(fixture).toContain(`Push ${register}`)
    expect(fixture).toContain(`Pop ${register}`)
  }
  expect(fixture).toContain('FileOpen $1 "${INSTALLER_TEST_TRACE_DIR}\\finish-$0.jsonl" w')
  expect(fixture).toContain('FileClose $1')
  expect(() => createInstallerTestPagesSource(source.replace('Function InstallerFinishLeave\n', '')))
    .toThrow('requires one production marker')
  expect(() => createInstallerTestPagesSource(source + '\nFunction InstallerFinishLeave\n'))
    .toThrow('requires one production marker')
})

it('resolves every copied page include against the original installer source directory', async () => {
  const source = await readFile(new URL('../installer/pages.nsh', import.meta.url), 'utf8')
  const fixture = createInstallerTestPagesSource(source)
  const relativeIncludes = [...source.matchAll(/!include "\$\{__FILEDIR__\}\\([^"\n]+)"/gu)].map(match => match[1])
  expect(relativeIncludes).toEqual(['path.nsh', 'drawing.nsh'])
  for (const name of ['path.nsh', 'drawing.nsh']) expect(fixture).toContain(`!include "\${INSTALLER_SOURCE_DIR}\\${name}"`)
  expect(fixture).not.toContain('${__FILEDIR__}')
  expect(() => createInstallerTestPagesSource(source.replace('!include "${__FILEDIR__}\\path.nsh"', '')))
    .toThrow('requires one production marker')
  expect(() => createInstallerTestPagesSource(source + '\n!include "${__FILEDIR__}\\unexpected.nsh"\n'))
    .toThrow('unresolved source-relative path')
})

it('separates pristine checked launch, waits for error-callback return, and retains the original exit failure', async () => {
  const smoke = await readFile(new URL('./windows-installer-smoke.ps1', import.meta.url), 'utf8')
  const positive = smoke.indexOf('Finish-Setup $process $true pristine-dark $bounds $false')
  const retry = smoke.indexOf('Finish-Setup $process $true dark $bounds')
  expect(positive).toBeGreaterThan(0)
  expect(retry).toBeGreaterThan(positive)
  expect(smoke).toContain('Wait-FinishCallbackReturn $Process $previousReturns')
  expect(smoke).toContain("$_.event -eq 'outer-next-return'")
  const failedFinish = smoke.slice(smoke.indexOf('function Finish-Setup('), smoke.indexOf('function Run-Silent('))
  expect(failedFinish.indexOf('Wait-FinishCallbackReturn')).toBeLessThan(failedFinish.indexOf('PostMessage($finish'))
  expect(failedFinish).toContain('$waitReturned = $Process.WaitForExit(10000)')
  expect(failedFinish).toContain('if ($waitError -or $waitReturned -ne $true) { throw "Finish wait failed')
  expect(failedFinish.indexOf('Read-NativeFailureObserver $Process')).toBeGreaterThan(failedFinish.indexOf('$Process.WaitForExit(10000)'))
  expect(failedFinish.indexOf('Read-NativeFailureObserver $Process')).toBeLessThan(failedFinish.indexOf('throw "Finish wait failed'))
  expect(failedFinish).toContain('Remove-Item -LiteralPath (Join-Path $installPath \'launched.txt\')')
  expect(failedFinish).toContain('foreach ($ownedApp in $ownedApps) { $ownedApp.Dispose() }')
})

it('limits native failure observations to numeric waits and owned windows without process contents', async () => {
  const helper = await readFile(new URL('./windows-installer-diagnostics.ps1', import.meta.url), 'utf8')
  expect(helper).toContain('if (owner == result.ProcessId && seen.Add(window.ToInt64()))')
  expect(helper).toContain('TokenQuery = 0x0008')
  expect(helper).toContain('if (!CloseHandle(token))')
  expect(helper).not.toContain('CloseHandle(processHandle)')
  expect(helper).toContain('[StructLayout(LayoutKind.Explicit, Size = 280)]')
  expect(helper).toContain('WctMaxNodeCount = 16, WctThreadType = 8')
  expect(helper).toContain('if (node.ObjectType == WctThreadType)')
  expect(helper).toContain('CloseThreadWaitChainSession(session)')
  expect(helper).not.toMatch(/\b(?:MiniDumpWriteDump|ReadProcessMemory|GetEnvironmentVariables|CreateToolhelp32Snapshot)\b/u)
  expect(helper).not.toMatch(/(?:public|FieldOffset[^\n]*public)[^\n]*\bObjectName\b/u)
})

it('owns a bounded credential-scrubbed observer and drains it before installer cleanup', async () => {
  const smoke = await readFile(new URL('./windows-installer-smoke.ps1', import.meta.url), 'utf8')
  const observer = smoke.slice(smoke.indexOf('function Read-NativeFailureObserver('), smoke.indexOf('function Finish-Setup('))
  expect(observer).toContain('[Text.Encoding]::Unicode.GetBytes($command)')
  expect(observer).toContain("-match '(KEY|SECRET|TOKEN|PASSWORD)'")
  expect(observer.indexOf('$processes.Add($observer)')).toBeLessThan(observer.indexOf('ReadToEndAsync()'))
  expect(observer).toContain('$observer.WaitForExit(5000)')
  expect(observer).toContain('$observer.Kill()')
  expect(observer).toContain('$observer.WaitForExit(10000)')
  expect(observer).toContain('[void]$stdout.GetAwaiter().GetResult()')
  expect(observer).toContain('[void]$stderr.GetAwaiter().GetResult()')
  expect(observer).toContain('if (-not $started -or $quiescent)')
  expect(observer).not.toMatch(/Write-Output.*\$(?:stdout|stderr)|Start-Sleep/u)
  const worker = await readFile(new URL('./windows-installer-failure-observer.ps1', import.meta.url), 'utf8')
  expect(worker).toContain('[InstallerDiagnostics]::MatchesInstallerPath($retainedProcessHandle, $InstallerPath)')
  expect(worker).toContain('[InstallerDiagnostics]::RegisterComCallbacksForObserver()')
  expect(worker.indexOf("$receipt.status = 'before-wct'")).toBeLessThan(worker.indexOf('[InstallerDiagnostics]::PopulateWaitChains'))
  expect(worker).toContain('[IO.FileMode]::CreateNew')
  expect(worker).toContain('[IO.File]::Replace($temporaryPath, $script:observerReceiptPath, $null)')
  expect(worker).toContain('if ($null -ne $process) { $process.Dispose() }')
  expect(worker).not.toContain('$errorObject.Message')
  expect(smoke).toContain("$observerControl.receipt.status -ne 'complete'")
  expect(smoke).toContain('native-observer-exact-installer-and-quiescent-return')
})

function reusableAssemblyFailures(smoke: string, helper: string, worker: string): string[] {
  const requirements: Record<string, boolean> = {
    privateParentAssembly: smoke.includes('Join-Path $OutputDirectory ("installer-diagnostics-$([Guid]::NewGuid()')
      && smoke.includes("'windows-installer-diagnostics.ps1') -AssemblyPath $diagnosticAssembly")
      && smoke.includes('-AssemblyPath \'$($diagnosticAssembly.Replace'),
    sameGeneratedFile: helper.includes('-OutputAssembly $installerDiagnosticsAssemblyFile')
      && helper.includes('Add-Type -LiteralPath $installerDiagnosticsAssemblyFile')
      && helper.includes('if (Test-Path -LiteralPath $installerDiagnosticsAssemblyFile)'),
    noObserverCompilation: worker.includes('Add-Type -LiteralPath $observerAssemblyFile')
      && !/-TypeDefinition|windows-installer-diagnostics\.ps1/u.test(worker),
  }
  return Object.entries(requirements).filter(([, satisfied]) => !satisfied).map(([name]) => name)
}

it('compiles the reviewed diagnostic helper once into a private assembly and loads the same file in the observer', async () => {
  const [smoke, helper, worker] = await Promise.all([
    readFile(new URL('./windows-installer-smoke.ps1', import.meta.url), 'utf8'),
    readFile(new URL('./windows-installer-diagnostics.ps1', import.meta.url), 'utf8'),
    readFile(new URL('./windows-installer-failure-observer.ps1', import.meta.url), 'utf8'),
  ])
  expect(smoke).toContain('installer-diagnostics-$([Guid]::NewGuid().ToString(\'N\')).dll')
  expect(smoke).toContain("'windows-installer-diagnostics.ps1') -AssemblyPath $diagnosticAssembly")
  expect(smoke).toContain('-AssemblyPath \'$($diagnosticAssembly.Replace')
  expect(smoke).toContain('assemblySha256 = Read-DiagnosticFileHash $diagnosticAssembly')
  expect(helper).toContain('-OutputAssembly $installerDiagnosticsAssemblyFile')
  expect(worker).toContain('Add-Type -LiteralPath $observerAssemblyFile')
  expect(worker).not.toMatch(/-TypeDefinition|windows-installer-diagnostics\.ps1/u)
  expect(smoke).toContain('$observer.WaitForExit(5000)')
  expect(smoke).toContain('$waitReturned = $Process.WaitForExit(10000)')
  expect(reusableAssemblyFailures(smoke, helper, worker)).toEqual([])
  expect(reusableAssemblyFailures(smoke.replace('Join-Path $OutputDirectory ("installer-diagnostics-$([Guid]::NewGuid()',
    'Join-Path $env:TEMP ("shared-diagnostics.dll'), helper, worker)).toContain('privateParentAssembly')
  expect(reusableAssemblyFailures(smoke, helper.replace('-OutputAssembly $installerDiagnosticsAssemblyFile', ''), worker))
    .toContain('sameGeneratedFile')
  expect(reusableAssemblyFailures(smoke, helper, worker.replace('Add-Type -LiteralPath $observerAssemblyFile',
    'Add-Type -TypeDefinition $source'))).toContain('noObserverCompilation')
})

it('hashes private diagnostics with disposed .NET objects rather than optional PowerShell modules', async () => {
  const smoke = await readFile(new URL('./windows-installer-smoke.ps1', import.meta.url), 'utf8')
  const hash = smoke.slice(smoke.indexOf('function Read-DiagnosticFileHash('), smoke.indexOf('$assemblyReceipt ='))
  expect(hash).toContain('[Security.Cryptography.SHA256]::Create()')
  expect(hash).toContain('[IO.File]::OpenRead($Path)')
  expect(hash).toContain('$hasher.ComputeHash($stream)')
  expect(hash).toContain('finally { $stream.Dispose() }')
  expect(hash).toContain('finally { $hasher.Dispose() }')
  expect(smoke).not.toMatch(/Get-FileHash|Import-Module/u)
  expect(smoke).toContain("'powershell-runtime.json'")
  expect(smoke).toContain('psVersion = $PSVersionTable.PSVersion.ToString()')
  expect(smoke).toContain('clrVersion = [Environment]::Version.ToString()')
  expect(smoke).toContain('executablePath = $runtimeProcess.MainModule.FileName')
  expect(smoke).toContain('finally { $runtimeProcess.Dispose() }')
  expect(smoke).not.toMatch(/PSModulePath|GetEnvironmentVariables|\.CommandLine/u)
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
