<# Prepare the shared CRT before the native UI fixture; never bypass the production prerequisite. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$RuntimeFile, [Parameter(Mandatory)][string]$ReceiptFile)
$ErrorActionPreference = 'Stop'
$requiredVersion = [version]'14.51.36247.0'
$registryPath = 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
$receipt = [ordered]@{
    version = 1; requiredVersion = $requiredVersion.ToString(); registryView = 'Registry64'
    registryPath = $registryPath; before = $null; after = $null
    installExitCode = $null; rebootRequired = $false; passed = $false
}
function Read-VisualCppRuntime {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $base.OpenSubKey($registryPath)
        if ($null -eq $key) { return @{ installed = 0; version = $null } }
        try {
            $installed = $key.GetValue('Installed', $null)
            $parts = @('Major', 'Minor', 'Bld', 'Rbld') | ForEach-Object { $key.GetValue($_, $null) }
            if ($null -eq $installed -or $parts.Count -ne 4 -or
                @($parts | Where-Object { $null -eq $_ -or $_ -isnot [int] -or $_ -lt 0 }).Count -gt 0) {
                return @{ installed = $installed; version = $null }
            }
            return @{ installed = $installed; version = ($parts -join '.') }
        } finally { $key.Dispose() }
    } finally { $base.Dispose() }
}
function Test-VisualCppRuntime($Snapshot) {
    return $Snapshot.installed -is [int] -and $Snapshot.installed -eq 1 -and $null -ne $Snapshot.version -and
        [version]$Snapshot.version -ge $requiredVersion
}
try {
    $receipt.before = Read-VisualCppRuntime
    if (-not (Test-VisualCppRuntime $receipt.before)) {
        if (-not (Test-Path -LiteralPath $RuntimeFile -PathType Leaf)) {
            throw 'The hash-locked Visual C++ fixture prerequisite is missing.'
        }
        $process = Start-Process -FilePath $RuntimeFile -Verb RunAs -ArgumentList '/install /quiet /norestart' -Wait -PassThru
        try { $receipt.installExitCode = $process.ExitCode } finally { $process.Dispose() }
        $receipt.rebootRequired = $receipt.installExitCode -eq 3010
        if ($receipt.installExitCode -notin @(0, 3010)) {
            throw "Visual C++ fixture prerequisite failed with exit code $($receipt.installExitCode)."
        }
    }
    $receipt.after = Read-VisualCppRuntime
    if ($receipt.rebootRequired) {
        throw 'Visual C++ fixture prerequisite requires a Windows restart; native UI qualification has not run.'
    }
    if (-not (Test-VisualCppRuntime $receipt.after)) {
        throw 'The x64 registry does not confirm Installed=1 and Visual C++ 14.51.36247.0 or later.'
    }
    $receipt.passed = $true
} finally {
    [IO.File]::WriteAllText($ReceiptFile, ($receipt | ConvertTo-Json -Depth 5) + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false))
}
