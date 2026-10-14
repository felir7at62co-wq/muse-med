<# Isolated, read-only installer diagnosis; the parent owns timeout, termination and awaited worker exit. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$ProcessId,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$InstallerPath,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$process = $null
$observerExitCode = 0
$script:observerReceiptOwned = $false
$script:observerReceiptPath = [IO.Path]::GetFullPath($OutputPath)
$receipt = [ordered]@{
    version = 1; processId = $ProcessId; observerProcessId = $PID
    status = 'starting'; stage = 'initialize'; installerMatched = $false
    comRegistration = $null; observation = $null; errorType = $null; errorCode = $null
}
function Write-ObserverReceipt {
    $directory = [IO.Path]::GetDirectoryName($script:observerReceiptPath)
    $temporaryPath = [IO.Path]::Combine($directory, 'observer-' + [Guid]::NewGuid().ToString('N') + '.json.tmp')
    $temporaryOwned = $false
    try {
        $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $temporaryOwned = $true
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Depth 9) + [Environment]::NewLine)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
        } finally { $stream.Dispose() }
        if ($script:observerReceiptOwned) {
            [IO.File]::Replace($temporaryPath, $script:observerReceiptPath, $null)
        } else {
            # Move refuses an existing destination; this observer never adopts another run's receipt.
            [IO.File]::Move($temporaryPath, $script:observerReceiptPath)
            $script:observerReceiptOwned = $true
        }
        $temporaryOwned = $false
    } finally {
        if ($temporaryOwned -and [IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
    }
}
try {
    Write-ObserverReceipt
    . (Join-Path $PSScriptRoot 'windows-installer-diagnostics.ps1')
    $receipt.stage = 'acquire-installer'
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    # Retaining this object's handle prevents PID reuse until this observer disposes it.
    $retainedProcessHandle = $process.Handle
    if ($retainedProcessHandle -eq [IntPtr]::Zero) { throw 'Installer process handle is unavailable' }
    $receipt.stage = 'verify-installer-image'
    if (-not [InstallerDiagnostics]::MatchesInstallerPath($retainedProcessHandle, $InstallerPath)) {
        throw 'Requested installer image did not match the retained process'
    }
    $receipt.installerMatched = $true
    $receipt.stage = 'register-com'
    # WCT stores global native addresses; Ole32 stays loaded until this dedicated worker exits.
    $receipt.comRegistration = [InstallerDiagnostics]::RegisterComCallbacksForObserver()
    $receipt.stage = 'snapshot'
    $receipt.observation = [InstallerDiagnostics]::CaptureFailureSnapshot($process)
    $receipt.status = 'before-wct'
    $receipt.stage = 'wct'
    Write-ObserverReceipt
    # A hung native call leaves the complete before-wct receipt intact for the bounded parent.
    [InstallerDiagnostics]::PopulateWaitChains($receipt.observation)
    $receipt.status = 'complete'
    $receipt.stage = 'complete'
    Write-ObserverReceipt
} catch {
    $observerExitCode = 1
    $receipt.status = 'error'
    $errorObject = $_.Exception
    while ($null -ne $errorObject.InnerException) { $errorObject = $errorObject.InnerException }
    $receipt.errorType = $errorObject.GetType().FullName
    $receipt.errorCode = if ($errorObject -is [ComponentModel.Win32Exception]) { $errorObject.NativeErrorCode } else { $errorObject.HResult }
    # Exception messages can contain arbitrary target paths; save only the type and numeric error.
    try { Write-ObserverReceipt } catch { Write-Error 'Installer observer could not save its receipt' -ErrorAction Continue }
} finally {
    if ($null -ne $process) { $process.Dispose() }
}
exit $observerExitCode
