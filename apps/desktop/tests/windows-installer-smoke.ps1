<# Native installation checks use a unique product identity and a private directory. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [switch]$FailAfterAutomaticRelaunch)
$ErrorActionPreference = 'Stop'
$runtimeProcess = [Diagnostics.Process]::GetCurrentProcess()
try {
    $runtimeReceipt = [ordered]@{
        psVersion = $PSVersionTable.PSVersion.ToString()
        psEdition = $PSVersionTable.PSEdition
        clrVersion = [Environment]::Version.ToString()
        executablePath = $runtimeProcess.MainModule.FileName
    } | ConvertTo-Json
} finally { $runtimeProcess.Dispose() }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'powershell-runtime.json'),
    $runtimeReceipt + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
$diagnosticAssembly = Join-Path $OutputDirectory ("installer-diagnostics-$([Guid]::NewGuid().ToString('N')).dll")
. (Join-Path $PSScriptRoot 'windows-installer-diagnostics.ps1') -AssemblyPath $diagnosticAssembly
function Read-DiagnosticFileHash([string]$Path) {
    # .NET hashing does not depend on optional PowerShell cmdlet modules or module search paths.
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try {
            return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        } finally { $stream.Dispose() }
    } finally { $hasher.Dispose() }
}
$assemblyReceipt = [ordered]@{
    assemblyPath = $diagnosticAssembly
    assemblySha256 = Read-DiagnosticFileHash $diagnosticAssembly
    sourceSha256 = Read-DiagnosticFileHash (Join-Path $PSScriptRoot 'windows-installer-diagnostics.ps1')
    compiledInParent = $true
} | ConvertTo-Json
# This source-generated assembly remains in this run's private diagnostic artifacts, outside the installed payload.
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'diagnostics-assembly.json'),
    $assemblyReceipt + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
[InstallerCapture]::Initialize()
[InstallerCapture]::ProductName = $ProductName
$installPath = Join-Path $OutputDirectory 'Installed App'
$appPath = Join-Path $installPath ($ProductName + '.exe')
$uninstaller = Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$processHandles = [Collections.Generic.Dictionary[int, IntPtr]]::new()
$results = [Collections.Generic.List[string]]::new()
$primaryFailure = $null
$cleanupFailures = [Collections.Generic.List[System.Management.Automation.ErrorRecord]]::new()
$discoveredAppProcessIds = [Collections.Generic.List[int]]::new()
$remainingAppProcessIds = @()
$negativeControlReached = $false
$negativeControlProcessId = $null
$uninstallExitCode = $null
$expected = Get-Content (Join-Path $PSScriptRoot 'expected/windows-installer.json') -Raw | ConvertFrom-Json
$localizedCopy = @{ ENGLISH = @{}; SIMPCHINESE = @{} }
Get-Content (Join-Path $PSScriptRoot '../installer/strings.nsh') -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^LangString (INSTALLER_\w+) \$\{LANG_(ENGLISH|SIMPCHINESE)\} "(.*)"$') {
        $localizedCopy[$Matches[2]][$Matches[1]] = $Matches[3]
    }
}
function Start-TestProcess([string]$FilePath, [string]$Arguments = '', [Diagnostics.ProcessWindowStyle]$WindowStyle = 'Hidden') {
    $parameters = @{ FilePath = $FilePath; PassThru = $true; WindowStyle = $WindowStyle }
    if ($Arguments) { $parameters.ArgumentList = $Arguments }
    $process = Start-Process @parameters
    try {
        $processHandles.Add($process.Id, [InstallerCapture]::RetainProcessHandle($process))
        $processes.Add($process)
        $tokenReceipt = [ordered]@{
            processId = $process.Id
            token = [InstallerDiagnostics]::ObserveTokenElevation($processHandles[$process.Id])
        } | ConvertTo-Json -Depth 3 -Compress
        [IO.File]::AppendAllText((Join-Path $OutputDirectory 'process-tokens.jsonl'),
            $tokenReceipt + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        return $process
    } catch {
        $acquisitionFailure = $_
        [void]$processes.Remove($process)
        try { Stop-TestProcess $process } catch { $cleanupFailures.Add($_) }
        throw $acquisitionFailure
    }
}
function Wait-Control([Diagnostics.Process]$Process, [string]$Text, [switch]$Dialog, [switch]$Button) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($Process.HasExited) { throw "Process exited before '$Text': $($Process.ExitCode)" }
        $control = if ($Button) { [InstallerCapture]::FindButton($Process.Id, $Text) }
            elseif ($Dialog) { [InstallerCapture]::FindDialogText($Process.Id, $Text) }
            else { [InstallerCapture]::FindText($Process.Id, $Text) }
        if ($control -ne [IntPtr]::Zero) { return $control }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    throw "Missing '$Text': $([InstallerCapture]::VisibleText($Process.Id))"
}
function Start-Setup([string]$Theme, [string]$Path = $installPath, [string]$ExtraArguments = '') {
    $arguments = '/THEME=' + $Theme
    if ($ExtraArguments) { $arguments += ' ' + $ExtraArguments }
    if ($Path) { $arguments += ' /D=' + $Path }
    $process = Start-TestProcess $Installer $arguments Normal
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($process.HasExited) { throw "Setup exited: $($process.ExitCode)" }
        if ([InstallerCapture]::HasIncompleteWindow($process.Id)) { throw 'Installer appeared before its page was ready' }
        $window = [InstallerCapture]::Find($process.Id)
        if ($window -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 5
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    if ($window -eq [IntPtr]::Zero) { throw 'Installer welcome window did not appear' }
    $timer.Restart()
    while ([InstallerCapture]::GetProp($window, 'HarnessInstaller.Presented') -eq [IntPtr]::Zero) {
        if ($process.HasExited -or $timer.Elapsed.TotalSeconds -gt 10) { throw 'Installer welcome window was not presented' }
        Start-Sleep -Milliseconds 10
    }
    [InstallerCapture]::Reveal($window)
    $languages = @($localizedCopy.Keys | Where-Object {
        [InstallerCapture]::FindButton($process.Id, $localizedCopy[$_].INSTALLER_INSTALL) -ne [IntPtr]::Zero
    })
    if ($languages.Count -ne 1) { throw "Cannot identify installer language: $([InstallerCapture]::VisibleText($process.Id))" }
    $script:copy = $localizedCopy[$languages[0]]
    [void](Wait-Control $process $copy.INSTALLER_INSTALL -Button)
    return $process
}
function Click-Control([Diagnostics.Process]$Process, [string]$Text) {
    [InstallerCapture]::Click((Wait-Control $Process $Text -Button))
}
function Dismiss([Diagnostics.Process]$Process, [string]$Text) {
    $control = Wait-Control $Process $Text -Dialog
    $dialog = [InstallerCapture]::TopLevel($control)
    [InstallerCapture]::Click([InstallerCapture]::DialogDismissButton($dialog))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ([InstallerCapture]::IsWindow($dialog)) {
        if ($timer.Elapsed.TotalSeconds -gt 10) { throw 'Dialog did not close' }
        Start-Sleep -Milliseconds 25
    }
}
function Set-PathInput([Diagnostics.Process]$Process, [IntPtr]$Window, [IntPtr]$Edit, [string]$Path, [switch]$PressEnter) {
    [InstallerCapture]::SetEditText($Process.Id, $Edit, $Path)
    $focus = [InstallerCapture]::FocusEdit($Process.Id, $Window, $Edit)
    $actual = [InstallerCapture]::ReadEditText($Process.Id, $Edit)
    if ($actual -cne $Path) { throw "Path input changed before Enter: expected '$Path', actual '$actual'" }
    $inputAction = [ordered]@{
        processId = $Process.Id
        windowHandle = $Window.ToInt64()
        editHandle = $Edit.ToInt64()
        focusHandle = $focus.ToInt64()
        expected = $Path
        actual = $actual
        pressEnter = [bool]$PressEnter
    } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText((Join-Path $OutputDirectory 'input-actions.jsonl'),
        $inputAction + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Installer path input: $inputAction"
    if ($PressEnter -and -not [InstallerCapture]::PostMessage($Edit, 0x100, [IntPtr]13, [IntPtr]::Zero)) {
        throw 'Could not post Enter to the verified path input'
    }
}
function Read-FinishTrace([Diagnostics.Process]$Process) {
    $path = Join-Path (Split-Path -Parent $Installer) ("finish-$($Process.Id).jsonl")
    if (-not (Test-Path -LiteralPath $path)) { return }
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    # A receipt becomes observable only after its complete line has been appended.
    $lines = $text -split "`n"
    for ($index = 0; $index -lt $lines.Length - 1; $index++) {
        if ($lines[$index].Trim()) { $lines[$index] | ConvertFrom-Json }
    }
}
function Wait-FinishCallbackReturn([Diagnostics.Process]$Process, [int]$PreviousReturns) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $returns = @(Read-FinishTrace $Process | Where-Object { $_.event -eq 'outer-next-return' })
        if ($returns.Count -gt $PreviousReturns) { return }
        if ($Process.HasExited) { throw 'Installer exited before the failed Finish callback returned' }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 5)
    throw 'Failed Finish callback did not return before retry'
}
function Read-NativeFailureObserver([Diagnostics.Process]$Process) {
    $observerPath = Join-Path $PSScriptRoot 'windows-installer-failure-observer.ps1'
    $receiptPath = Join-Path $OutputDirectory ("native-observer-$($Process.Id)-$([Guid]::NewGuid().ToString('N')).json")
    $command = "& '$($observerPath.Replace("'", "''"))' -ProcessId $($Process.Id) -InstallerPath '$($Installer.Replace("'", "''"))' -AssemblyPath '$($diagnosticAssembly.Replace("'", "''"))' -OutputPath '$($receiptPath.Replace("'", "''"))'"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
    $startInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' +
        [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($name in @($startInfo.EnvironmentVariables.Keys)) {
        if ([string]$name -match '(KEY|SECRET|TOKEN|PASSWORD)') { $startInfo.EnvironmentVariables.Remove($name) }
    }
    $observer = [Diagnostics.Process]::new()
    $observer.StartInfo = $startInfo
    $started = $false
    $quiescent = $false
    $stdout = $null
    $stderr = $null
    try {
        $started = $observer.Start()
        if (-not $started) { throw 'Native observer process did not start' }
        $processes.Add($observer)
        $stdout = $observer.StandardOutput.ReadToEndAsync()
        $stderr = $observer.StandardError.ReadToEndAsync()
        $timedOut = -not $observer.WaitForExit(5000)
        if ($timedOut) {
            $observer.Kill()
            if (-not $observer.WaitForExit(10000)) { throw 'Native observer survived termination' }
        }
        $quiescent = $true
        $disposition = [ordered]@{
            processId = $Process.Id
            observerProcessId = $observer.Id
            timedOut = $timedOut
            exitCode = $observer.ExitCode
            quiescent = $true
        } | ConvertTo-Json
        [IO.File]::WriteAllText($receiptPath + '.process.json',
            $disposition + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        return [ordered]@{
            observerProcessId = $observer.Id
            timedOut = $timedOut
            exitCode = $observer.ExitCode
            quiescent = $true
            receipt = if (Test-Path -LiteralPath $receiptPath) {
                [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
            } else { $null }
        }
    } finally {
        if ($started -and -not $quiescent) {
            if (-not $observer.HasExited) { $observer.Kill() }
            $quiescent = $observer.WaitForExit(10000)
        }
        if (-not $started -or $quiescent) {
            try {
                # The only writer has exited; both streams must drain even when one read fails.
                if ($stdout) { [void]$stdout.GetAwaiter().GetResult() }
            } finally {
                try {
                    if ($stderr) { [void]$stderr.GetAwaiter().GetResult() }
                } finally {
                    [void]$processes.Remove($observer)
                    $observer.Dispose()
                }
            }
        }
        # Failed termination leaves the registered Process for the ordinary final cleanup.
    }
}
function Finish-Setup([Diagnostics.Process]$Process, [bool]$Launch, [string]$Theme, [string]$Bounds,
    [bool]$InjectLaunchFailure = $true) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $previous = 0
    $window = [InstallerCapture]::Find($Process.Id)
    while ([InstallerCapture]::FindButton($Process.Id, $copy.INSTALLER_FINISH) -eq [IntPtr]::Zero) {
        if ($Process.HasExited -or $timer.Elapsed.TotalSeconds -gt 30) { throw 'Installer did not complete' }
        $visible = [InstallerCapture]::VisibleText($Process.Id)
        if ($visible.Contains('msctls_progress32') -ne $expected.nativeProgressVisible) { throw 'Stock green progress bar is visible' }
        if ($visible -match 'HarnessInstallerProgress[^\r\n]*?(\d+)%') {
            $percent = [int]$Matches[1]
            if ($percent -lt $previous) { throw 'Installation progress went backwards' }
            if ($percent -eq 100 -and [InstallerCapture]::GetProp($window, 'HarnessInstaller.Succeeded') -eq [IntPtr]::Zero) { throw 'Installation showed 100% before success' }
            $previous = $percent
        }
        Start-Sleep -Milliseconds 25
    }
    if ([InstallerCapture]::GetProp($window, 'HarnessInstaller.CompletedPercent').ToInt32() -ne 100) { throw 'Finish page replaced an incomplete progress bar' }
    $checkbox = Wait-Control $Process $copy.INSTALLER_LAUNCH -Button
    $state = [InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    if ($state -ne $expected.launchCheckboxState) { throw 'Unexpected launch checkbox default' }
    if (-not $Launch) {
        [InstallerCapture]::Click($checkbox)
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while ([InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) {
            if ($timer.Elapsed.TotalSeconds -gt 5) { throw 'Checkbox did not toggle' }
            Start-Sleep -Milliseconds 25
        }
    }
    $window = [InstallerCapture]::Find($Process.Id)
    if ([InstallerCapture]::GetProp($window, 'HarnessInstaller.Stage').ToInt32() -ne 4) { throw 'Installation did not reach cleanup' }
    if ([InstallerCapture]::Bounds($window) -ne $Bounds) { throw 'Completion page moved or resized the installer' }
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory ($Theme + '-finish.png')))
    if ($Launch -and (Test-Path -LiteralPath (Join-Path $installPath 'launched.txt'))) {
        Remove-Item -LiteralPath (Join-Path $installPath 'launched.txt')
    }
    if ($Launch -and $InjectLaunchFailure) {
        $previousReturns = @(Read-FinishTrace $Process | Where-Object { $_.event -eq 'outer-next-return' }).Count
        $hiddenApp = $appPath + '.hold'
        Move-Item -LiteralPath $appPath -Destination $hiddenApp
        try {
            Click-Control $Process $copy.INSTALLER_FINISH
            Dismiss $Process $copy.INSTALLER_LAUNCH_FAILED
            # The outer-next return receipt is written after NSIS's page-leave call actually returns.
            Wait-FinishCallbackReturn $Process $previousReturns
            if (-not [InstallerCapture]::IsWindowVisible($window)) { throw 'Launch failure did not restore the finish page' }
        } finally {
            Move-Item -LiteralPath $hiddenApp -Destination $appPath
        }
        $finish = Wait-Control $Process $copy.INSTALLER_FINISH -Button
        [void][InstallerCapture]::SendMessage($window, 0x28, $finish, [IntPtr]1)
        [void][InstallerCapture]::PostMessage($finish, 0x100, [IntPtr]13, [IntPtr]::Zero)
    } else {
        Click-Control $Process $copy.INSTALLER_FINISH
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ([InstallerCapture]::IsWindowVisible($window)) {
        if ($timer.Elapsed.TotalSeconds -gt 2) { throw 'Finish did not dismiss the installer promptly' }
        Start-Sleep -Milliseconds 25
    }
    $waitTimer = [Diagnostics.Stopwatch]::StartNew()
    $waitReturned = $null
    $waitError = $null
    try { $waitReturned = $Process.WaitForExit(10000) } catch { $waitError = $_.ToString() }
    $waitTimer.Stop()
    $handle = $processHandles[$Process.Id]
    $observation = [InstallerCapture]::ObserveProcessExit($Process, $handle)
    $visibleDump = $null
    $visibleDumpError = $null
    try { $visibleDump = [InstallerCapture]::VisibleText($Process.Id) } catch { $visibleDumpError = $_.ToString() }
    $exitReceipt = [ordered]@{
        theme = $Theme
        launch = $Launch
        processId = $Process.Id
        processHandle = $handle.ToInt64()
        windowHandle = $window.ToInt64()
        windowExists = [InstallerCapture]::IsWindow($window)
        windowVisible = [InstallerCapture]::IsWindowVisible($window)
        waitReturned = $waitReturned
        waitElapsedMs = $waitTimer.ElapsedMilliseconds
        waitError = $waitError
        managedHasExited = $observation.ManagedHasExited
        managedHasExitedError = $observation.ManagedHasExitedError
        managedExitCode = $observation.ManagedExitCode
        managedExitCodeError = $observation.ManagedExitCodeError
        nativeWaitResult = $observation.NativeWaitResult
        nativeExitCode = $observation.NativeExitCode
        nativeWin32Error = $observation.NativeWin32Error
        visibleTextDump = $visibleDump
        visibleTextDumpError = $visibleDumpError
    } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText((Join-Path $OutputDirectory 'finish-exit.jsonl'),
        $exitReceipt + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Installer finish exit: $exitReceipt"
    if ($waitError -or $waitReturned -ne $true) {
        try {
            $ownedApps = @(Get-OwnApplications)
            try {
                $diagnosticReceipt = [ordered]@{
                    theme = $Theme
                    injectedLaunchFailure = $InjectLaunchFailure
                    finishTrace = @(Read-FinishTrace $Process)
                    launchMarkerExists = Test-Path -LiteralPath (Join-Path $installPath 'launched.txt')
                    launchMarkerExpected = (Test-Path -LiteralPath (Join-Path $installPath 'launched.txt')) -and
                        [IO.File]::ReadAllText((Join-Path $installPath 'launched.txt')) -ceq 'launched'
                    exactAppProcessIds = @($ownedApps | ForEach-Object { $_.Id })
                    process = Read-NativeFailureObserver $Process
                } | ConvertTo-Json -Depth 9
            } finally {
                foreach ($ownedApp in $ownedApps) { $ownedApp.Dispose() }
            }
            [IO.File]::WriteAllText((Join-Path $OutputDirectory ("finish-hang-$($Process.Id).json")),
                $diagnosticReceipt + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        } catch {
            # Diagnostic failure must not replace the independently observed exit failure.
            Write-Output "Installer hang evidence could not be saved: $_"
        }
    }
    if ($waitError -or $waitReturned -ne $true) { throw "Finish wait failed for PID $($Process.Id): returned=$waitReturned error=$waitError" }
    if ($observation.ManagedHasExited -ne $true -or $observation.ManagedHasExitedError -or
        $observation.ManagedExitCodeError -or $null -eq $observation.ManagedExitCode -or $observation.ManagedExitCode -ne 0) {
        throw "Finish managed exit failed for PID $($Process.Id): code=$($observation.ManagedExitCode) error=$($observation.ManagedExitCodeError)"
    }
    if ($observation.NativeWaitResult -ne 0 -or $null -ne $observation.NativeWin32Error -or
        $null -eq $observation.NativeExitCode -or $observation.NativeExitCode -ne 0) {
        throw "Finish native exit disagrees for PID $($Process.Id): wait=$($observation.NativeWaitResult) code=$($observation.NativeExitCode) Win32=$($observation.NativeWin32Error)"
    }
}
function Run-Silent([string]$Arguments, [int]$Code) {
    $process = Start-TestProcess $Installer $Arguments
    if (-not $process.WaitForExit(60000)) { throw 'Silent setup did not exit' }
    if ($process.ExitCode -ne $Code) { throw "Silent setup returned $($process.ExitCode), expected $Code" }
}
function Get-OwnApplications {
    Get-Process -Name $ProductName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appPath }
}
function Set-RegisteredPathForUpdate([string]$Path) {
    $key = 'HKCU:\Software\' + $RegistryKey
    Set-ItemProperty -LiteralPath $key -Name InstallLocation -Value $Path
    if ((Get-ItemProperty -LiteralPath $key).InstallLocation -cne $Path) {
        throw 'Historical InstallLocation fixture did not retain its requested separators'
    }
}
function Stop-TestProcess([Diagnostics.Process]$Process) {
    try {
        try {
            if (-not $Process.HasExited) { $Process.Kill() }
        } catch {
            if (-not $Process.HasExited) { throw }
        }
        if (-not $Process.WaitForExit(10000)) { throw "Test process $($Process.Id) did not exit during cleanup" }
    } finally {
        [void]$processHandles.Remove($Process.Id)
        $Process.Dispose()
    }
}
function Finish-RebootSetup([Diagnostics.Process]$Process) {
    [void](Wait-Control $Process $copy.INSTALLER_FINISH -Button)
    [void](Wait-Control $Process $copy.INSTALLER_REBOOT_REQUIRED)
    $checkbox = Wait-Control $Process $copy.INSTALLER_LAUNCH -Button
    $state = [InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    if ($state -ne 0 -or [InstallerCapture]::IsWindowEnabled($checkbox)) { throw 'Reboot-required installation enabled immediate launch' }
    Click-Control $Process $copy.INSTALLER_FINISH
    if (-not $Process.WaitForExit(10000) -or $Process.ExitCode -ne 0) { throw 'Reboot-required installation did not finish successfully' }
    if ((Test-Path -LiteralPath (Join-Path $installPath 'launched.txt')) -or @(Get-OwnApplications).Count -ne 0) {
        throw 'Reboot-required installation launched its application'
    }
}
try {
    $zeroHandleRejected = $false
    try {
        [InstallerCapture]::Click([IntPtr]::Zero)
    } catch {
        if ($_.Exception -isnot [ArgumentException] -and $_.Exception.InnerException -isnot [ArgumentException]) { throw }
        $zeroHandleRejected = $true
    }
    if (-not $zeroHandleRejected) { throw 'Native click accepted a zero window handle' }
    $process = Start-Setup light
    $results.Add('welcome-presented-on-first-show')
    $window = [InstallerCapture]::Find($process.Id)
    $observerControl = Read-NativeFailureObserver $process
    if ($observerControl.timedOut -or $observerControl.exitCode -ne 0 -or -not $observerControl.quiescent -or
        $observerControl.receipt.status -ne 'complete' -or -not $observerControl.receipt.installerMatched -or
        $observerControl.receipt.processId -ne $process.Id -or -not $observerControl.receipt.comRegistration.Registered -or
        @($observerControl.receipt.observation.Windows | Where-Object { $_.Handle -eq $window.ToInt64() }).Count -ne 1) {
        throw 'Native observer did not complete for its exact idle installer and window'
    }
    $results.Add('native-observer-exact-installer-and-quiescent-return')
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory 'light-welcome.png'))
    Click-Control $process $copy.INSTALLER_CHOOSE_PATH
    [void](Wait-Control $process $copy.INSTALLER_BROWSE -Button)
    $edit = [InstallerCapture]::FindPathEdit($process.Id, $window)
    if ([InstallerCapture]::ReadEditText($process.Id, $edit) -cne $installPath) { throw 'Initial path input differs from the private installation directory' }
    $foreignOwnerRejected = $false
    try {
        [InstallerCapture]::SetEditText(0, $edit, 'foreign-owner-negative-control')
    } catch {
        if ($_.Exception -isnot [ArgumentException] -and $_.Exception.InnerException -isnot [ArgumentException]) { throw }
        $foreignOwnerRejected = $true
    }
    if (-not $foreignOwnerRejected -or [InstallerCapture]::ReadEditText($process.Id, $edit) -cne $installPath) {
        throw 'Path input accepted another process identity'
    }
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory 'light-path.png'))
    Click-Control $process $copy.INSTALLER_BROWSE
    Dismiss $process $copy.INSTALLER_CHOOSE_PATH
    $editAfterBrowse = [InstallerCapture]::FindPathEdit($process.Id, $window)
    if ($editAfterBrowse -ne $edit -or [InstallerCapture]::ReadEditText($process.Id, $editAfterBrowse) -cne $installPath) {
        throw 'Cancelling Browse changed the path input or its window handle'
    }
    $protectedDirectories = [ordered]@{
        WINDIR = $env:WINDIR
        'ProgramFiles(x86)' = ${env:ProgramFiles(x86)}
        ProgramFiles = $env:ProgramFiles
        USERPROFILE = $env:USERPROFILE
        LOCALAPPDATA = $env:LOCALAPPDATA
    }
    foreach ($protectedDirectory in $protectedDirectories.GetEnumerator()) {
        if ([string]::IsNullOrWhiteSpace($protectedDirectory.Value)) {
            throw "Native invalid-path fixture requires environment variable $($protectedDirectory.Key)"
        }
    }
    $windowsPath = $protectedDirectories.WINDIR.TrimEnd('\')
    $invalidPaths = @((Join-Path $windowsPath 'Harness Installer Test'), [IO.Path]::GetPathRoot($installPath),
        ([IO.Path]::GetPathRoot($installPath) + '\'), ($windowsPath + '\'), ($windowsPath + '\\Harness Installer Test'))
    foreach ($protectedName in @('ProgramFiles(x86)', 'ProgramFiles', 'USERPROFILE', 'LOCALAPPDATA')) {
        $protectedPath = $protectedDirectories[$protectedName].TrimEnd('\')
        $invalidPaths += @($protectedPath, ($protectedPath + '\'))
    }
    $invalidPaths += ($protectedDirectories.ProgramFiles.TrimEnd('\') + '\\Harness Installer Test')
    foreach ($invalidPath in $invalidPaths) {
        Set-PathInput $process $window $edit $invalidPath -PressEnter
        Dismiss $process $copy.INSTALLER_PATH_INVALID
    }
    Set-PathInput $process $window $edit $installPath
    [InstallerCapture]::MoveBy($window, 73, -41)
    $bounds = [InstallerCapture]::Bounds($window)
    Click-Control $process $copy.INSTALLER_INSTALL
    Finish-Setup $process $false light $bounds
    if (-not (Test-Path -LiteralPath $appPath) -or (Test-Path -LiteralPath (Join-Path $installPath 'launched.txt'))) { throw 'Unchecked launch behavior failed' }
    $results.Add('enter-validates-current-path-and-unchecked-launch')
    $results.Add('completion-preserves-window-position')
    $results.Add('welcome-ready-before-first-show')
    $results.Add('successful-install-paints-100-before-finish')

    # This ordinary checked launch has no preceding missing-file failure or modal retry.
    $process = Start-Setup dark
    $bounds = [InstallerCapture]::Bounds([InstallerCapture]::Find($process.Id))
    Click-Control $process $copy.INSTALLER_INSTALL
    Finish-Setup $process $true pristine-dark $bounds $false
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $pristineApp = $null
    while (-not $pristineApp -and $timer.Elapsed.TotalSeconds -lt 15) {
        $pristineApp = Get-OwnApplications | Select-Object -First 1
        if (-not $pristineApp) { Start-Sleep -Milliseconds 25 }
    }
    if (-not $pristineApp) { throw 'Pristine checked Finish did not launch its installed test application' }
    $processes.Add($pristineApp)
    Dismiss $pristineApp 'Installer test application is running.'
    if (-not $pristineApp.WaitForExit(10000) -or $pristineApp.ExitCode -ne 0) { throw 'Pristine launched application did not exit cleanly' }
    $results.Add('pristine-checked-launch-before-failure-retry')

    Set-RegisteredPathForUpdate ($installPath + '\')
    $process = Start-Setup dark ''
    Click-Control $process $copy.INSTALLER_CHOOSE_PATH
    [void](Wait-Control $process $copy.INSTALLER_BROWSE -Button)
    $window = [InstallerCapture]::Find($process.Id)
    $edit = [InstallerCapture]::FindPathEdit($process.Id, $window)
    Set-PathInput $process $window $edit ($installPath + '\\')
    [void][InstallerCapture]::Save([InstallerCapture]::Find($process.Id), (Join-Path $OutputDirectory 'dark-welcome.png'))
    $bounds = [InstallerCapture]::Bounds([InstallerCapture]::Find($process.Id))
    Click-Control $process $copy.INSTALLER_INSTALL
    Finish-Setup $process $true dark $bounds
    $registration = Get-ItemProperty ('HKCU:\Software\' + $RegistryKey)
    if ($registration.InstallLocation -cne $installPath -or -not (Test-Path -LiteralPath $appPath)) {
        throw 'Trailing separators changed the registered installation directory'
    }
    $results.Add('registered-directory-with-trailing-separators')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $app = Get-Process -Name $ProductName -ErrorAction SilentlyContinue
        if ($app) { break }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 15)
    if (-not $app -or $app.Path -ne $appPath) { throw 'Finish did not launch the installed test application' }
    $processes.Add($app)
    $results.Add('registered-directory-and-checked-launch')
    $results.Add('launch-failure-retry-and-prompt-dismissal')

    function Assert-RunningRejected([Diagnostics.Process]$Setup) {
        [void](Wait-Control $Setup $copy.INSTALLER_RUNNING -Dialog)
        $visible = [InstallerCapture]::VisibleText($Setup.Id)
        if ($visible.Contains('HarnessInstallerProgress')) { throw 'Running-app rejection started progress UI' }
        if (Get-ChildItem -LiteralPath $OutputDirectory -Directory -Filter 'Installed App.new-*') { throw 'Running-app rejection staged payload files' }
        Dismiss $Setup $copy.INSTALLER_RUNNING
        if (-not $Setup.WaitForExit(10000) -or $Setup.ExitCode -ne 2 -or $app.HasExited) { throw 'Running application was not preserved' }
    }
    $process = Start-TestProcess $Installer ('/THEME=dark /D=' + $installPath)
    Assert-RunningRejected $process
    $results.Add('running-app-rejected-before-welcome-and-extraction')
    Run-Silent ('/S /D=' + $installPath) 2
    if ($app.HasExited) { throw 'Silent rejection stopped the running application' }
    if (Get-ChildItem -LiteralPath $OutputDirectory -Directory -Filter 'Installed App.new-*') { throw 'Silent rejection staged payload files' }
    $results.Add('silent-running-app-rejected-before-extraction')
    Dismiss $app 'Installer test application is running.'
    if (-not $app.WaitForExit(10000)) { throw 'Test application did not exit' }

    $process = Start-Setup dark
    $app = Start-TestProcess $appPath
    [void](Wait-Control $app 'Installer test application is running.' -Dialog)
    Click-Control $process $copy.INSTALLER_INSTALL
    Assert-RunningRejected $process
    Dismiss $app 'Installer test application is running.'
    if (-not $app.WaitForExit(10000)) { throw 'Test application did not exit' }
    $results.Add('app-started-on-welcome-rejected-before-extraction')

    $otherPath = Join-Path $OutputDirectory 'Other Installation'
    New-Item -ItemType Directory -Path $otherPath | Out-Null
    $otherApp = Join-Path $otherPath ($ProductName + '.exe')
    Copy-Item -LiteralPath $appPath -Destination $otherApp
    $otherProcess = Start-TestProcess $otherApp
    [void](Wait-Control $otherProcess 'Installer test application is running.' -Dialog)
    Run-Silent '/S --updated' 0
    if ($otherProcess.HasExited) { throw 'Unrelated installation was stopped' }
    Dismiss $otherProcess 'Installer test application is running.'
    if (-not $otherProcess.WaitForExit(10000)) { throw 'Unrelated test application did not exit' }
    if (-not (Test-Path -LiteralPath $appPath)) { throw 'Silent update moved the registered installation' }
    $registration = Get-ItemProperty ('HKCU:\Software\' + $RegistryKey)
    if ($registration.InstallLocation -cne $installPath) { throw 'Silent update changed InstallLocation' }
    $results.Add('silent-update-retains-directory-and-ignores-unrelated-process')
    # The /S argument models older Muse updaters; this automatic restart must still expose installation progress.
    Set-RegisteredPathForUpdate ($installPath + '\\')
    $process = Start-TestProcess $Installer '/S --updated --force-run /THEME=dark'
    $window = [InstallerCapture]::Find($process.Id)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $observedProgress = $false
    $observedComplete = $false
    $previous = 0
    while (-not $process.HasExited) {
        if ($timer.Elapsed.TotalSeconds -gt 30) { throw 'Visible automatic update did not complete' }
        if ([InstallerCapture]::FindButton($process.Id, $copy.INSTALLER_FINISH) -ne [IntPtr]::Zero) { throw 'Automatic update waited for a manual finish click' }
        $window = [InstallerCapture]::Find($process.Id)
        $visible = [InstallerCapture]::VisibleText($process.Id)
        if ($visible -match 'HarnessInstallerProgress[^\r\n]*?(\d+)%') {
            $percent = [int]$Matches[1]
            if ($percent -lt $previous) { throw 'Automatic update progress went backwards' }
            if ($percent -eq 100 -and [InstallerCapture]::GetProp($window, 'HarnessInstaller.Succeeded') -eq [IntPtr]::Zero) { throw 'Automatic update showed completion before installation succeeded' }
            if (-not $observedProgress) { [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory 'automatic-update-progress.png')) }
            $observedProgress = $true
            $previous = $percent
        }
        if ([InstallerCapture]::GetProp($window, 'HarnessInstaller.CompletedPercent').ToInt32() -eq 100) { $observedComplete = $true }
        Start-Sleep -Milliseconds 25
    }
    if ((Get-ItemProperty ('HKCU:\Software\' + $RegistryKey)).InstallLocation -cne $installPath) {
        throw 'Automatic update did not canonicalize historical InstallLocation'
    }
    if ($FailAfterAutomaticRelaunch) {
        $timer.Restart()
        $unregisteredApp = $null
        while (-not $unregisteredApp -and $timer.Elapsed.TotalSeconds -lt 10) {
            $unregisteredApp = Get-OwnApplications | Select-Object -First 1
            if (-not $unregisteredApp) { Start-Sleep -Milliseconds 25 }
        }
        if (-not $unregisteredApp) { throw 'Cleanup negative control did not observe the automatically reopened application' }
        try {
            [void](Wait-Control $unregisteredApp 'Installer test application is running.' -Dialog)
            $negativeControlReached = $true
            $negativeControlProcessId = $unregisteredApp.Id
        } finally {
            $unregisteredApp.Dispose()
        }
        throw 'Injected automatic update failure after relaunch'
    }
    if ($process.ExitCode -ne 0 -or -not $observedProgress -or -not $observedComplete) { throw 'Automatic update did not paint verified progress through successful completion' }
    $timer.Restart()
    $app = $null
    while (-not $app -and $timer.Elapsed.TotalSeconds -lt 10) {
        $app = Get-Process -Name $ProductName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appPath } | Select-Object -First 1
        if (-not $app) { Start-Sleep -Milliseconds 25 }
    }
    if (-not $app) { throw 'Automatic update did not relaunch its own installed application' }
    $processes.Add($app)
    [void](Wait-Control $app 'Installer test application is running.' -Dialog)
    Dismiss $app 'Installer test application is running.'
    if (-not $app.WaitForExit(10000)) { throw 'Automatically reopened test application did not exit' }
    $results.Add('automatic-update-shows-progress-and-relaunches-without-finish-click')
    Run-Silent ('/S /allusers /D=' + $installPath) 2
    $foreign = Join-Path $OutputDirectory 'Foreign App'
    New-Item -ItemType Directory -Path $foreign | Out-Null
    Set-Content -LiteralPath (Join-Path $foreign 'keep.txt') -Value 'preserved'
    Run-Silent ('/S /D=' + $foreign) 2
    if ((Get-Content -LiteralPath (Join-Path $foreign 'keep.txt')) -ne 'preserved') { throw 'Foreign directory changed' }
    $results.Add('invalid-destination-rejection')

    $launchMarker = Join-Path $installPath 'launched.txt'
    if (Test-Path -LiteralPath $launchMarker) { Remove-Item -LiteralPath $launchMarker }
    $process = Start-Setup light $installPath '/TEST_REBOOT_REQUIRED=1'
    Click-Control $process $copy.INSTALLER_INSTALL
    Finish-RebootSetup $process
    $results.Add('manual-reboot-required-disables-launch')

    if (Test-Path -LiteralPath $launchMarker) { Remove-Item -LiteralPath $launchMarker }
    $process = Start-TestProcess $Installer '/S --updated --force-run /TEST_REBOOT_REQUIRED=1 /THEME=dark'
    Finish-RebootSetup $process
    $results.Add('automatic-update-reboot-required-disables-launch')

    if (Test-Path -LiteralPath $launchMarker) { Remove-Item -LiteralPath $launchMarker }
    Run-Silent '/S --force-run /TEST_REBOOT_REQUIRED=1' 0
    if ((Test-Path -LiteralPath $launchMarker) -or @(Get-OwnApplications).Count -ne 0) {
        throw 'Silent force-run reboot-required installation launched its application'
    }
    $results.Add('silent-force-run-reboot-required-disables-launch')
} catch {
    $primaryFailure = $_
    Write-Output "Installer check failed: $_"
    try {
        if ($process -and -not $process.HasExited) {
            foreach ($failureWindow in [InstallerCapture]::VisibleWindows($process.Id)) {
                [void][InstallerCapture]::SaveVisibleDesktop($failureWindow,
                    (Join-Path $OutputDirectory ("failure-window-$($failureWindow.ToInt64()).png")))
            }
        }
    } catch {
        Write-Output "Installer failure screenshot could not be saved: $_"
    }
    throw
} finally {
    foreach ($process in $processes) {
        try { Stop-TestProcess $process } catch { $cleanupFailures.Add($_) }
    }
    # The installer may launch this exact private executable before a failing assertion registers it.
    try {
        foreach ($ownedApp in @(Get-OwnApplications)) {
            $discoveredAppProcessIds.Add($ownedApp.Id)
            try { Stop-TestProcess $ownedApp } catch { $cleanupFailures.Add($_) }
        }
    } catch {
        $cleanupFailures.Add($_)
    }
    $uninstallerExists = $false
    try { $uninstallerExists = Test-Path -LiteralPath $uninstaller } catch { $cleanupFailures.Add($_) }
    if ($uninstallerExists) {
        $uninstallProcess = $null
        try {
            $uninstallProcess = Start-TestProcess $uninstaller '/S'
            if (-not $uninstallProcess.WaitForExit(60000)) { throw 'Test uninstaller timed out' }
            $uninstallExitCode = $uninstallProcess.ExitCode
            if ($uninstallExitCode -ne 0) { throw "Test uninstaller returned $uninstallExitCode" }
            $timer = [Diagnostics.Stopwatch]::StartNew()
            while ((Test-Path -LiteralPath $installPath) -or (Test-Path -LiteralPath ('HKCU:\Software\' + $RegistryKey))) {
                if ($timer.Elapsed.TotalSeconds -gt 20) { throw 'Test installation directory or registry entry was not removed' }
                Start-Sleep -Milliseconds 50
            }
        } catch {
            $cleanupFailures.Add($_)
        } finally {
            if ($uninstallProcess) {
                try { Stop-TestProcess $uninstallProcess } catch { $cleanupFailures.Add($_) }
            }
        }
    }
    try {
        $remainingAppProcesses = @(Get-OwnApplications)
        $remainingAppProcessIds = @($remainingAppProcesses | ForEach-Object { $_.Id })
        foreach ($remainingApp in $remainingAppProcesses) { $remainingApp.Dispose() }
        if ($remainingAppProcessIds.Count -ne 0) { throw 'Private test application survived cleanup' }
    } catch {
        $cleanupFailures.Add($_)
    }
    try {
        $cleanupReceipt = [ordered]@{
            appPath = $appPath
            primaryFailure = if ($primaryFailure) { $primaryFailure.ToString() } else { $null }
            cleanupFailures = @($cleanupFailures | ForEach-Object { $_.ToString() })
            negativeControlRequested = [bool]$FailAfterAutomaticRelaunch
            negativeControlReached = $negativeControlReached
            negativeControlProcessId = $negativeControlProcessId
            discoveredAppProcessIds = @($discoveredAppProcessIds)
            remainingAppProcessIds = @($remainingAppProcessIds)
            applicationRemoved = -not (Test-Path -LiteralPath $appPath)
            uninstallerRemoved = -not (Test-Path -LiteralPath $uninstaller)
            installDirectoryExists = Test-Path -LiteralPath $installPath
            uninstallRegistryExists = Test-Path -LiteralPath ('HKCU:\Software\' + $RegistryKey)
            uninstallExitCode = $uninstallExitCode
        } | ConvertTo-Json -Depth 3
        [IO.File]::WriteAllText((Join-Path $OutputDirectory 'cleanup-receipt.json'),
            $cleanupReceipt + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    } catch {
        $cleanupFailures.Add($_)
    }
    foreach ($cleanupFailure in $cleanupFailures) { Write-Output "Installer cleanup failed: $cleanupFailure" }
    if (-not $primaryFailure -and $cleanupFailures.Count -ne 0) { throw $cleanupFailures[0] }
}
$results.Add('uninstall')
if (Compare-Object @($expected.cases) @($results)) { throw 'Installer results differ from expected behavior' }
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'results.json') -Encoding UTF8
$results | ForEach-Object { Write-Output "PASS: $_" }
