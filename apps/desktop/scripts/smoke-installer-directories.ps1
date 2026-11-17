# Exercise the production NSIS directory transaction with private installation directories.
param(
  [Parameter(Mandatory)][string]$Makensis,
  [Parameter(Mandatory)][string]$SevenZip,
  [string]$FrameLibrary,
  [scriptblock]$SignExecutable
)
$ErrorActionPreference = 'Stop'
$Makensis = [System.IO.Path]::GetFullPath($Makensis)
$SevenZip = [System.IO.Path]::GetFullPath($SevenZip)
if ($FrameLibrary) { $FrameLibrary = [System.IO.Path]::GetFullPath($FrameLibrary) }
$scratch = [System.IO.Directory]::CreateTempSubdirectory('dsh-directory-smoke-').FullName
$fixture = Join-Path $PSScriptRoot '../tests/fixtures/installer-directory-smoke.nsi'

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Executable exited with $LASTEXITCODE" }
}

try {
  $payload = Join-Path $scratch 'payload'
  New-Item -ItemType Directory -Path $payload | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $payload 'asset.txt'), 'new asset')
  $deepPayload = Join-Path $payload (('nested-' * 20) + '\asset-' + ('x' * 60) + '.txt')
  [IO.Directory]::CreateDirectory((Split-Path $deepPayload -Parent)) | Out-Null
  [IO.File]::WriteAllText($deepPayload, 'long path asset')
  $archive = Join-Path $scratch 'payload.7z'
  Invoke-Checked $SevenZip @('a', '-bd', '-t7z', $archive, "$payload/*")
  $brokenArchive = Join-Path $scratch 'broken.7z'
  [System.IO.File]::WriteAllText($brokenArchive, 'invalid archive')

  $guardRoot = Join-Path $scratch 'path-guard'
  $reportRoot = Join-Path $guardRoot 'reports'
  $linkedRoot = Join-Path $guardRoot 'junction'
  [IO.Directory]::CreateDirectory($reportRoot) | Out-Null
  New-Item -ItemType Junction -Path $linkedRoot -Target $reportRoot | Out-Null
  $guardFixture = Join-Path $PSScriptRoot '../tests/fixtures/installer-path-guard-smoke.nsi'
  $orderFixture = Join-Path $PSScriptRoot '../tests/fixtures/installer-declaration-order-smoke.nsi'
  Invoke-Checked $Makensis @('/V2', '/WX', "/DOUTPUT_FILE=$guardRoot\declaration-order.exe", "/DDSH_UPGRADE_REPORT_ROOT=$reportRoot", $orderFixture)
  $guardCases = @(
    @{ target = $reportRoot; report = $reportRoot; expected = 2 },
    @{ target = $reportRoot.ToUpperInvariant(); report = $reportRoot; expected = 2 },
    @{ target = (Join-Path $reportRoot 'child'); report = $reportRoot; expected = 2 },
    @{ target = $guardRoot; report = $reportRoot; expected = 2 },
    @{ target = "$reportRoot-neighbor"; report = $reportRoot; expected = 0 },
    @{ target = (Join-Path $guardRoot 'safe'); report = (Join-Path $linkedRoot 'reports'); expected = 2 }
  )
  for ($index = 0; $index -lt $guardCases.Count; $index++) {
    $case = $guardCases[$index]
    $probe = Join-Path $guardRoot "guard-$index.exe"
    Invoke-Checked $Makensis @('/V2', "/DOUTPUT_FILE=$probe", "/DTARGET_DIR=$($case.target)", "/DDSH_UPGRADE_REPORT_ROOT=$($case.report)", $guardFixture)
    $process = Start-Process -FilePath $probe -ArgumentList '/S' -WindowStyle Hidden -PassThru
    try {
      if (-not $process.WaitForExit(30000)) { $process.Kill($true); $process.WaitForExit(); throw 'Path guard probe timed out' }
      if ($process.ExitCode -ne $case.expected) { throw "Path guard case $index exited $($process.ExitCode), expected $($case.expected)" }
    } finally { $process.Dispose() }
  }

  foreach ($mode in @('first', 'created-empty', 'existing-empty', 'hidden-only', 'empty-child', 'upgrade', 'transient-lock', 'locked', 'locked-stage', 'missing-stage', 'restore-conflict', 'broken', 'cancelled', 'post-promote-failure')) {
    $caseRoot = Join-Path $scratch $mode
    $target = Join-Path $caseRoot 'Application'
    New-Item -ItemType Directory -Path $caseRoot | Out-Null
    if ($mode -in @('existing-empty', 'hidden-only', 'empty-child')) {
      [IO.Directory]::CreateDirectory($target) | Out-Null
      if ($mode -eq 'hidden-only') {
        $hidden = Join-Path $target 'user-hidden.txt'
        [IO.File]::WriteAllText($hidden, 'hidden user data')
        [IO.File]::SetAttributes($hidden, [IO.FileAttributes]::Hidden)
      }
      if ($mode -eq 'empty-child') { [IO.Directory]::CreateDirectory((Join-Path $target 'user-empty-folder')) | Out-Null }
    } elseif ($mode -notin @('first', 'created-empty')) {
      New-Item -ItemType Directory -Path $target | Out-Null
      [System.IO.File]::WriteAllText((Join-Path $target 'asset.txt'), 'old asset')
      [System.IO.File]::WriteAllText((Join-Path $target 'obsolete.txt'), 'old only')
      $oldDeep = Join-Path $target ([IO.Path]::GetRelativePath($payload, $deepPayload))
      [IO.Directory]::CreateDirectory((Split-Path $oldDeep -Parent)) | Out-Null
      [IO.File]::WriteAllText($oldDeep, 'old long path asset')
    }
    $probe = Join-Path $caseRoot 'probe.exe'
    $caseArchive = if ($mode -eq 'broken') { $brokenArchive } else { $archive }
    $reportDir = Join-Path $caseRoot 'installer-logs'
    $upgradeReports = Join-Path $scratch "$mode-upgrade-reports"
    $compileArgs = @('/V2', "/DOUTPUT_FILE=$probe", "/DPAYLOAD_FILE=$caseArchive", "/DTARGET_DIR=$target", "/DDSH_SEVENZIP_PATH=$SevenZip")
    $compileArgs += "/DDSH_UPGRADE_REPORT_ROOT=$upgradeReports"
    if ($FrameLibrary) { $compileArgs += @("/DSOURCE_DLL=$FrameLibrary", "/DREPORT_DIR=$reportDir") }
    if ($mode -eq 'missing-stage') { $compileArgs += '/DMISSING_STAGE' }
    if ($mode -eq 'locked-stage') { $compileArgs += '/DLOCKED_STAGE' }
    if ($mode -eq 'restore-conflict') { $compileArgs += '/DRESTORE_CONFLICT' }
    if ($mode -eq 'cancelled') { $compileArgs += '/DCANCELLED' }
    if ($mode -eq 'post-promote-failure') { $compileArgs += '/DPOST_PROMOTE_FAILURE' }
    if ($mode -eq 'created-empty') { $compileArgs += '/DCREATED_EMPTY' }
    Invoke-Checked $Makensis ($compileArgs + $fixture)
    if ($null -ne $SignExecutable) { & $SignExecutable $probe }
    $handle = $null
    $process = $null
    try {
      if ($mode -in @('locked', 'transient-lock')) {
        $handle = [System.IO.File]::Open((Join-Path $target 'asset.txt'), 'Open', 'Read', 'Read')
      }
      $process = Start-Process -FilePath $probe -ArgumentList '/S' -WindowStyle Hidden -PassThru
      if ($mode -eq 'transient-lock') {
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        $observedFailure = $false
        while (-not $process.HasExited -and $deadline.Elapsed.TotalSeconds -lt 30) {
          $pluginPath = "$target.plugin-dir"
          if (Test-Path -LiteralPath $pluginPath) {
            $trace = Join-Path ([IO.File]::ReadAllText($pluginPath)) 'directory-operations.log'
            if (Test-Path -LiteralPath $trace) {
              $stream = [IO.File]::Open($trace, 'Open', 'Read', 'ReadWrite')
              $reader = [IO.StreamReader]::new($stream)
              try { $attempts = $reader.ReadToEnd() } finally { $reader.Dispose() }
              if ($attempts -match 'Windows error: (5|32|33)\b') {
                $observedFailure = $true
                break
              }
            }
          }
          Start-Sleep -Milliseconds 20
        }
        if (-not $observedFailure) { throw 'Transient-lock smoke did not observe the failed operation before release' }
        $handle.Dispose()
        $handle = $null
      }
      if (-not $process.WaitForExit(60000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "Directory smoke $mode did not exit within 60 seconds"
      }
      $expectedExit = if ($mode -in @('first', 'created-empty', 'existing-empty', 'hidden-only', 'empty-child', 'upgrade', 'transient-lock')) { 0 } else { 2 }
      if ($process.ExitCode -ne $expectedExit) {
        throw "Directory smoke $mode exited with $($process.ExitCode), expected $expectedExit"
      }
    } finally {
      if ($null -ne $handle) { $handle.Dispose() }
      if ($null -ne $process) {
        if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
        $process.Dispose()
      }
    }
    if ($mode -in @('created-empty', 'existing-empty', 'hidden-only', 'empty-child')) {
      $backups = @(Get-ChildItem -LiteralPath $caseRoot -Directory -Filter 'Application.old-*')
      $reports = @(Get-ChildItem -LiteralPath $upgradeReports -Filter '*.completed' -ErrorAction SilentlyContinue)
      $expectedBackups = if ($mode -eq 'created-empty') { 0 } else { 1 }
      if ($backups.Count -ne $expectedBackups -or $reports.Count -ne $expectedBackups -or
          [IO.File]::ReadAllText((Join-Path $target 'asset.txt')) -ne 'new asset') { throw "Empty/hidden target protection failed: $mode" }
      if ($mode -eq 'hidden-only' -and [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'user-hidden.txt')) -ne 'hidden user data') { throw 'Hidden user content was not retained' }
      if ($mode -eq 'empty-child' -and -not (Test-Path -LiteralPath (Join-Path $backups[0].FullName 'user-empty-folder') -PathType Container)) { throw 'Empty user subdirectory was not retained' }
      Write-Output "Directory replacement smoke passed: $mode"
      continue
    }
    if ($mode -eq 'post-promote-failure') {
      $backups = @(Get-ChildItem -LiteralPath $caseRoot -Directory -Filter 'Application.old-*')
      if ($backups.Count -ne 1 -or [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'obsolete.txt')) -ne 'old only' -or
          [IO.File]::ReadAllText((Join-Path $target 'user-created-after-promotion.txt')) -ne 'preserve new user data') {
        throw 'Post-promotion failure did not preserve both old and newly written files'
      }
      if (@(Get-ChildItem -LiteralPath $upgradeReports -Filter '*.completed').Count -ne 0) {
        throw 'Failed upgrade incorrectly recorded completion'
      }
      continue
    }
    if ($mode -eq 'restore-conflict') {
      $backups = @(Get-ChildItem -LiteralPath $caseRoot -Directory -Filter 'Application.old-*')
      if ($backups.Count -ne 1 -or [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'asset.txt')) -ne 'old asset' -or
          [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'obsolete.txt')) -ne 'old only' -or
          [IO.File]::ReadAllText((Join-Path "$target.conflict" 'unrelated.txt')) -ne 'unrelated file') {
        throw 'Failed restoration did not preserve the backup and the conflicting destination'
      }
      if ((Test-Path -LiteralPath $target) -or @(Get-ChildItem -LiteralPath $caseRoot -Directory -Filter 'Application.new-*').Count -ne 0) {
        throw 'Reported restoration failure retried recovery or retained its unlocked staging directory'
      }
      if ($FrameLibrary) {
        $reports = @(Get-ChildItem -LiteralPath $reportDir -File)
        if ($reports.Count -ne 1) { throw 'Failed restoration did not save exactly one report' }
        $report = Get-Content -LiteralPath $reports[0].FullName -Raw -Encoding UTF8
        foreach ($expected in @('promote: Windows error: 183', 'restore: Windows error: 183', 'Restoration error: 183', "Preserved backup: $($backups[0].FullName)")) {
          if (-not $report.Contains($expected)) { throw "Failed restoration report lacks '$expected'" }
        }
      }
      Write-Output "Directory replacement smoke passed: $mode"
      continue
    }
    $expectedAsset = if ($mode -in @('first', 'upgrade', 'transient-lock')) { 'new asset' } else { 'old asset' }
    if ([System.IO.File]::ReadAllText((Join-Path $target 'asset.txt')) -ne $expectedAsset) {
      throw "Directory smoke $mode changed the wrong version"
    }
    $expectObsolete = $mode -notin @('first', 'upgrade', 'transient-lock')
    if ((Test-Path -LiteralPath (Join-Path $target 'obsolete.txt')) -ne $expectObsolete) {
      throw "Directory smoke $mode did not preserve the expected old-only file state"
    }
    $backups = @(Get-ChildItem -LiteralPath $caseRoot -Directory -Filter 'Application.old-*')
    if ($mode -in @('upgrade', 'transient-lock')) {
      if ($backups.Count -ne 1 -or [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'obsolete.txt')) -ne 'old only') {
        throw "Directory smoke $mode did not retain the complete previous directory"
      }
      $prepared = @(Get-ChildItem -LiteralPath $upgradeReports -Filter '*.txt')
      $completed = @(Get-ChildItem -LiteralPath $upgradeReports -Filter '*.completed')
      if ($prepared.Count -ne 1 -or $completed.Count -ne 1 -or
          -not ([IO.File]::ReadAllText($completed[0].FullName, [Text.Encoding]::Unicode)).Contains($backups[0].FullName)) {
        throw "Directory smoke $mode did not record the retained directory"
      }
    } elseif ($backups.Count -ne 0) { throw "Directory smoke $mode retained an unexpected backup" }
    if (@(Get-ChildItem -LiteralPath $caseRoot -Directory | Where-Object { $_.Name -notin @('Application', 'installer-logs') -and $_.Name -notlike 'Application.old-*' }).Count -ne 0) {
      throw "Directory smoke $mode left transaction directories behind"
    }
    if ($FrameLibrary) {
      $reports = @(if (Test-Path -LiteralPath $reportDir) { Get-ChildItem -LiteralPath $reportDir -File })
      if ($mode -eq 'broken') {
        if ($reports.Count -ne 1 -or $reports[0].Name -notmatch '^extract-failure-20\d{6}-\d{6}\.log$') {
          throw "Directory smoke $mode did not save exactly one extraction report"
        }
        $report = Get-Content -LiteralPath $reports[0].FullName -Raw -Encoding UTF8
        foreach ($expected in @('Result: 7-Zip exit code 2 (fatal error)', "Archive: $caseArchive", 'Cannot open the file as [7z] archive')) {
          if (-not $report.Contains($expected)) { throw "Directory smoke $mode report lacks '$expected'" }
        }
      } elseif ($mode -in @('locked', 'locked-stage', 'missing-stage')) {
        if ($reports.Count -ne 1 -or $reports[0].Name -notmatch '^directory-failure-20\d{6}-\d{6}\.log$') {
          throw "Directory smoke $mode did not save exactly one directory report"
        }
        $report = Get-Content -LiteralPath $reports[0].FullName -Raw -Encoding UTF8
        $expectedError = if ($mode -ne 'missing-stage') { '(5|32|33)' } else { '2' }
        if ($report -notmatch "Windows error: $expectedError\b") { throw "Directory smoke $mode reported an unexpected Windows error" }
        foreach ($expected in @('Operation: MoveFileExW', 'Restoration error: 0')) {
          if (-not $report.Contains($expected)) { throw "Directory smoke $mode report lacks '$expected'" }
        }
        $attempts = ([regex]::Matches($report, 'Windows error: ')).Count - 1
        $expectedAttempts = if ($mode -ne 'missing-stage') { 10 } else { 1 }
        if ($attempts -ne $expectedAttempts) { throw "Directory smoke $mode recorded $attempts failed attempts, expected $expectedAttempts" }
      } elseif ($reports.Count -ne 0) {
        throw "Directory smoke $mode saved an unexpected extraction report"
      }
    }
    Write-Output "Directory replacement smoke passed: $mode"
  }
} finally {
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $resolvedScratch = [System.IO.Path]::GetFullPath($scratch)
  if (-not $resolvedScratch.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing cleanup outside the temporary root: $resolvedScratch"
  }
  if ($linkedRoot -and (Test-Path -LiteralPath $linkedRoot)) {
    $linkItem = Get-Item -LiteralPath $linkedRoot -Force
    if (-not ($linkItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Path guard fixture link changed type' }
    Remove-Item -LiteralPath $linkedRoot -Force
  }
  Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
}
