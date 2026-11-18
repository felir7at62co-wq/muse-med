<#
.SYNOPSIS
Starts an existing isolated studio deployment and optionally opens its web page.
.PARAMETER DeploymentPath
Directory containing deployment.json, studio data, and logs; defaults to this script's directory.
.PARAMETER OpenBrowser
Opens the configured loopback URL only after the expected service reports ready.
.PARAMETER NoDialog
Reports failures through the terminating error and log without a Windows message box.
.PARAMETER StartupTimeoutSeconds
Maximum readiness wait, including an existing studio process that is still starting.
#>
[CmdletBinding()]
param(
  [string]$DeploymentPath = $PSScriptRoot,
  [switch]$OpenBrowser,
  [switch]$NoDialog,
  [ValidateRange(5, 180)][int]$StartupTimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
$studioMutex = $null
$lockOwned = $false
$launcherLog = $null

function Get-StudioHealth([string]$HealthUrl) {
  try { return Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 }
  catch { # A refused, incomplete, or non-JSON response is not readiness evidence.
    return $null
  }
}

function Assert-StudioIdentity($Health) {
  if ($null -ne $Health -and $Health.app -ne 'Muse LocalMiniDrama isolated') {
    throw 'The configured port belongs to another application. Check deployment.json; no process was stopped.'
  }
}

try {
  $deploymentRoot = (Resolve-Path -LiteralPath $DeploymentPath).Path
  $logDirectory = Join-Path $deploymentRoot 'logs'
  [void][IO.Directory]::CreateDirectory($logDirectory)
  $launcherLog = Join-Path $logDirectory 'studio-launcher.log'
  $meta = Get-Content -LiteralPath (Join-Path $deploymentRoot 'deployment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $studioUri = [uri]$meta.studioUrl
  if (-not $studioUri.IsAbsoluteUri -or $studioUri.Scheme -ne 'http' -or -not $studioUri.IsLoopback -or $studioUri.UserInfo -or $studioUri.Query -or $studioUri.Fragment -or $studioUri.AbsolutePath -ne '/') {
    throw 'deployment.json must contain an HTTP loopback studioUrl without credentials, a path, or query parameters.'
  }
  $serverPath = Join-Path $meta.worktree '.local/localminidrama/backend-node/src/server.js'
  $healthUrl = $studioUri.AbsoluteUri.TrimEnd('/') + '/health'
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $deploymentHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($deploymentRoot.ToLowerInvariant()))).Replace('-', '') }
  finally { $hash.Dispose() }
  $studioMutex = [Threading.Mutex]::new($false, ('Local\MuseLocalMiniDramaStudio-' + $deploymentHash))
  try { $lockOwned = $studioMutex.WaitOne([TimeSpan]::FromSeconds($StartupTimeoutSeconds + 5)) }
  catch [Threading.AbandonedMutexException] { $lockOwned = $true }
  if (-not $lockOwned) { throw 'Another studio launch has not finished. See logs/studio-launcher.log and try again after it finishes.' }

  $health = Get-StudioHealth $healthUrl
  Assert-StudioIdentity $health
  if ($null -eq $health -or $health.status -ne 'ok') {
    $studioProcess = $null
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $studioUri.Port })
    foreach ($listener in $listeners) {
      $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
      if (-not $owner -or -not $owner.CommandLine -or $owner.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw ('Port ' + $studioUri.Port + ' is busy and does not report the expected studio. No second server was started; check the port owner.')
      }
      $studioProcess = Get-Process -Id $listener.OwningProcess
    }
    $pidPath = Join-Path $deploymentRoot 'studio.pid'
    if (-not $studioProcess -and (Test-Path -LiteralPath $pidPath)) {
      $savedPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
      if ($savedPid -match '^\d+$') {
        $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $savedPid)
        if ($owner -and $owner.CommandLine -and $owner.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          $studioProcess = Get-Process -Id $owner.ProcessId
        }
      }
    }
    if (-not $studioProcess) {
      foreach ($required in @($meta.node, $serverPath, (Join-Path $meta.worktree '.local/localminidrama/frontweb/dist/index.html'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw ('Studio file is missing: ' + $required + '. Restore the isolated deployment before retrying.') }
      }
      $env:WEB_DIST_PATH = Join-Path $meta.worktree '.local/localminidrama/frontweb/dist'
      $env:FFPROBE_PATH = Join-Path $deploymentRoot 'studio/tools/ffmpeg/ffprobe.exe'
      $env:FFMPEG_PATH = Join-Path $meta.worktree '.local/localminidrama/backend-node/tools/ffmpeg/ffmpeg.exe'
      $runName = 'studio-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + $PID
      $stdOut = Join-Path $logDirectory ($runName + '.out.log')
      $stdErr = Join-Path $logDirectory ($runName + '.err.log')
      $studioProcess = Start-Process -FilePath $meta.node -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory (Join-Path $deploymentRoot 'studio') -WindowStyle Hidden -RedirectStandardOutput $stdOut -RedirectStandardError $stdErr -PassThru
      # Windows PowerShell requires the handle to retain a fast child's exit code.
      [void]$studioProcess.Handle
      $studioProcess.Id | Set-Content -LiteralPath $pidPath
      Add-Content -LiteralPath $launcherLog -Value ((Get-Date -Format o) + ' Started studio PID ' + $studioProcess.Id + '; stderr: ' + $stdErr) -Encoding UTF8
    }
    $readiness = [Diagnostics.Stopwatch]::StartNew()
    do {
      $studioProcess.Refresh()
      if ($studioProcess.HasExited) { throw ('Studio exited before readiness (exit code ' + $studioProcess.ExitCode + '). See ' + $logDirectory + ' and retry after correcting the reported error.') }
      $health = Get-StudioHealth $healthUrl
      Assert-StudioIdentity $health
      if ($null -ne $health -and $health.status -eq 'ok') { break }
      Start-Sleep -Milliseconds 250
    } while ($readiness.Elapsed.TotalSeconds -lt $StartupTimeoutSeconds)
    if ($null -eq $health -or $health.status -ne 'ok') {
      throw ('Studio did not become ready within ' + $StartupTimeoutSeconds + ' seconds. Its process was left running; see ' + $logDirectory + ' before retrying.')
    }
  }
  Add-Content -LiteralPath $launcherLog -Value ((Get-Date -Format o) + ' Studio ready: ' + $studioUri.AbsoluteUri) -Encoding UTF8
  if ($OpenBrowser) { Start-Process -FilePath $studioUri.AbsoluteUri }
}
catch {
  $launchError = $_
  if ($lockOwned) {
    $studioMutex.ReleaseMutex()
    $lockOwned = $false
  }
  if ($launcherLog) {
    try { Add-Content -LiteralPath $launcherLog -Value ((Get-Date -Format o) + ' ERROR: ' + $launchError.Exception.Message) -Encoding UTF8 }
    catch { Write-Warning ('Could not write the studio launcher log: ' + $_.Exception.Message) }
  }
  if (-not $NoDialog) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [void][System.Windows.Forms.MessageBox]::Show(('Studio launch failed.' + [Environment]::NewLine + $launchError.Exception.Message), 'Muse LocalMiniDrama', 'OK', 'Error')
    }
    catch { Write-Warning ('Could not show the studio error dialog: ' + $_.Exception.Message) }
  }
  throw $launchError
}
finally {
  if ($lockOwned) { $studioMutex.ReleaseMutex() }
  if ($studioMutex) { $studioMutex.Dispose() }
}
