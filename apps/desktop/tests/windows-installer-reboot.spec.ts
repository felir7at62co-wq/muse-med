/** Synthetic receipt and control states exercise installer waits without opening native windows. */
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const source = fileURLToPath(new URL('./windows-installer-smoke.ps1', import.meta.url))

it('uses the same completion wait for ordinary and reboot upgrades with explicit manual and automatic expectations', async () => {
  const smoke = await readFile(source, 'utf8')
  const ordinary = smoke.slice(smoke.indexOf('function Finish-Setup('), smoke.indexOf('function Run-Silent('))
  const reboot = smoke.slice(smoke.indexOf('function Finish-RebootSetup('), smoke.indexOf('\ntry {', smoke.indexOf('function Finish-RebootSetup(')))
  expect(ordinary).toContain('$window = Wait-InstallerFinish $Process $Theme $ExpectBackup')
  expect(reboot).toContain("[void](Wait-InstallerFinish $Process 'reboot' $ExpectBackup (-not $ExpectBackup))")
  expect(reboot.indexOf('Wait-InstallerFinish')).toBeLessThan(reboot.indexOf('Wait-Control'))
  expect(smoke).toMatch(/Click-Control \$process \$copy\.INSTALLER_INSTALL\s+Finish-RebootSetup \$process \$true/u)
  expect(smoke).toMatch(new RegExp("Start-TestProcess \\$Installer '/S --updated --force-run "
    + "/TEST_REBOOT_REQUIRED=1 /THEME=dark'\\s+Finish-RebootSetup \\$process \\$false", 'u'))
  expect(reboot).toContain("throw 'Reboot-required installation enabled immediate launch'")
  expect(reboot).toContain("throw 'Reboot-required installation launched its application'")
  expect(smoke).toContain("throw 'Automatic reboot-required update did not retain exactly one completed backup receipt'")
})

it.runIf(process.platform === 'win32')('acknowledges a validated manual backup before Finish and rejects missing or unexpected acknowledgements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installer-reboot-receipts-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const reports = join(root, 'reports'), current = join(root, 'Installed App'), backup = current + '.old-test'
  const previousBackup = current + '.old-previous'
  await Promise.all([mkdir(reports), mkdir(backup), mkdir(previousBackup)])
  await Promise.all([writeFile(join(backup, 'Synthetic.exe'), 'synthetic payload'),
    writeFile(join(reports, 'synthetic.completed'), Buffer.from(
      `Upgrade completed. Retained backup: ${backup}\r\nCurrent directory: ${current}\r\n`, 'utf16le')),
    writeFile(join(previousBackup, 'Synthetic.exe'), 'previous synthetic payload'),
    writeFile(join(reports, 'previous.completed'), Buffer.from(
      `Upgrade completed. Retained backup: ${previousBackup}\r\nCurrent directory: ${current}\r\n`, 'utf16le'))])
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  const probe = join(root, 'reboot-receipts.ps1')
  await writeFile(probe, '\ufeff' + `
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${literal(source)}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Installer smoke source did not parse' }
foreach ($name in @('Read-OwnUpgradeReports', 'Wait-InstallerFinish')) {
    $functions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
    if ($functions.Count -ne 1) { throw 'Expected one actual completion dependency' }
    if ($name -eq 'Wait-InstallerFinish') { $waitSource = $functions[0].Extent.Text }
    Invoke-Expression $functions[0].Extent.Text
}
Add-Type -TypeDefinition @'
using System;
public static class InstallerCapture {
    public static bool Pending;
    public static int Acknowledgements;
    public static int FinishChecks;
    public static int WindowChecks;
    public static bool InitialWindowMissing;
    public static bool Success;
    public static string ExpectedBackup;
    public static IntPtr Find(int process) { return WindowChecks++ == 0 && InitialWindowMissing ? IntPtr.Zero : new IntPtr(10); }
    public static IntPtr FindButton(int process, string text) { return FinishChecks++ == 0 || Pending ? IntPtr.Zero : new IntPtr(11); }
    public static IntPtr FindDialogText(int process, string text) { return Pending && text == ExpectedBackup ? new IntPtr(12) : IntPtr.Zero; }
    public static IntPtr TopLevel(IntPtr control) { return control; }
    public static bool SaveNative(IntPtr control, string path, bool option) { return true; }
    public static string VisibleText(int process) { return InitialWindowMissing ? "HarnessInstallerProgress 100%" : "HarnessInstallerProgress 98%"; }
    public static IntPtr GetProp(IntPtr window, string name) { return window != IntPtr.Zero && Success ? new IntPtr(1) : IntPtr.Zero; }
}
'@
$UpgradeReportDirectory = ${literal(reports)}
$OutputDirectory = ${literal(root)}
$installPath = ${literal(current)}
$ProductName = 'Synthetic'
$copy = @{ INSTALLER_FINISH = 'Finish' }
$expected = @{ nativeProgressVisible = $false }
[InstallerCapture]::ExpectedBackup = ${literal(backup)}
function Dismiss([Diagnostics.Process]$Process, [string]$Text) {
    if ($Text -cne ${literal(backup)}) { throw 'Acknowledgement did not use the validated receipt backup' }
    [InstallerCapture]::Acknowledgements++
    [InstallerCapture]::Pending = $false
}
function Run-Case([bool]$Pending, [bool]$ExpectBackup, [bool]$AllowBackupReceipt, [bool]$SeenPrevious = $false,
    [bool]$InitialWindowMissing = $false, [bool]$PrematureProgress = $false) {
    $script:seenUpgradeReports = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($SeenPrevious) { [void]$script:seenUpgradeReports.Add(${literal(join(reports, 'previous.completed'))}) }
    [InstallerCapture]::Pending = $Pending
    [InstallerCapture]::Acknowledgements = 0
    [InstallerCapture]::FinishChecks = 0
    [InstallerCapture]::WindowChecks = 0
    [InstallerCapture]::InitialWindowMissing = $InitialWindowMissing
    [InstallerCapture]::Success = -not $PrematureProgress
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try {
        try {
            [void](Wait-InstallerFinish $process 'reboot' $ExpectBackup $AllowBackupReceipt)
            return @{ acknowledged = [InstallerCapture]::Acknowledgements; error = $null }
        } catch { return @{ acknowledged = [InstallerCapture]::Acknowledgements; error = $_.Exception.Message } }
    } finally { $process.Dispose() }
}
$results = @{
    manual = Run-Case $true $true $false
    manualSeenPrevious = Run-Case $true $true $false $true
    automatic = Run-Case $false $false $true
    automaticSeenPrevious = Run-Case $false $false $true $true
    missingManual = Run-Case $false $true $false
    unexpectedAutomatic = Run-Case $true $false $true
    freshWithReceipt = Run-Case $false $false $false
    lateWindow = Run-Case $false $false $true $false $true
    prematureProgress = Run-Case $false $false $true $false $true $true
}
$refresh = '        $window = [InstallerCapture]::Find($Process.Id)'
if (-not $waitSource.Contains($refresh)) { throw 'Expected the live progress-window sample' }
Invoke-Expression $waitSource.Replace($refresh, '')
$results.legacyWindow = Run-Case $false $false $true $false $true
ConvertTo-Json -InputObject $results -Compress -Depth 4
`)
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined) throw new Error('Windows SystemRoot is unavailable')
  const result = spawnSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    manual: { acknowledged: 1, error: null },
    manualSeenPrevious: { acknowledged: 1, error: null },
    automatic: { acknowledged: 0, error: null },
    automaticSeenPrevious: { acknowledged: 0, error: null },
    missingManual: { acknowledged: 0, error: 'Unexpected number of retained-backup notices' },
    unexpectedAutomatic: { acknowledged: 0, error: 'Automatic update waited for a retained-backup acknowledgement' },
    freshWithReceipt: { acknowledged: 0, error: 'Fresh installation unexpectedly retained an old directory' },
    lateWindow: { acknowledged: 0, error: null },
    prematureProgress: { acknowledged: 0, error: 'Installation showed 100% before success' },
    legacyWindow: { acknowledged: 0, error: 'Installation showed 100% before success' },
  })
})
