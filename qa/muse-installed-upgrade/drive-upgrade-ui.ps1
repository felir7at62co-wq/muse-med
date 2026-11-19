# Drive the genuine installed Muse update UI on a disposable GitHub-hosted Windows runner.
function Assert-MuseQaInteractiveRunner {
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or
        $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
        $env:RUNNER_ARCH -cne 'X64' -or $env:GITHUB_RUN_ID -notmatch '^\d+$' -or
        [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0 -or
        [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
        -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
        throw 'Muse native UI acceptance requires an interactive GitHub-hosted x64 Windows manual job.'
    }
}

function Get-MuseQaOwnedPath {
    param([string]$Path, [string]$Root)
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or -not [IO.Path]::IsPathFullyQualified($Root)) {
        throw 'Expected an absolute owned test path.'
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (-not $full.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path is outside of its dedicated test directory.'
    }
    for ($entry = $full; -not [string]::Equals($entry, $rootFull, [StringComparison]::OrdinalIgnoreCase);
        $entry = [IO.Path]::GetDirectoryName($entry)) {
        $item = Get-Item -LiteralPath $entry -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'An owned test path crosses a reparse point.'
        }
    }
    return $full
}

function Initialize-MuseQaUi {
    Assert-MuseQaInteractiveRunner
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
}

function Test-MuseQaSamePath {
    param([string]$First, [string]$Second)
    return [string]::Equals($First, $Second, [StringComparison]::OrdinalIgnoreCase)
}

function Get-MuseQaCimProcess {
    param([int]$ProcessId)
    Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
}

function Add-MuseQaUiEvidence {
    param($Context, [string]$Event, [int]$ProcessId = $Context.OldPid)
    Assert-MuseQaInteractiveRunner
    $path = Get-MuseQaOwnedPath -Path $Context.EvidencePath -Root $env:RUNNER_TEMP
    $entry = [ordered]@{
        time = [datetime]::UtcNow.ToString('o'); event = $Event; pid = $ProcessId
        fromVersion = $Context.BaselineVersion; targetVersion = $Context.TargetVersion
    }
    [IO.File]::AppendAllText($path, (($entry | ConvertTo-Json -Compress) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false))
    Write-Host "Muse native update: $Event (PID $ProcessId)"
}

function Assert-MuseQaOldProcess {
    param($Context)
    Assert-MuseQaInteractiveRunner
    $p = Get-MuseQaCimProcess $Context.OldPid
    if (-not $p -or -not (Test-MuseQaSamePath $p.ExecutablePath $Context.InstalledExecutable) -or
        $p.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
        ([datetime]$p.CreationDate).ToUniversalTime() -ne $Context.OldCreatedUtc) {
        throw 'The owned old Muse process is no longer available.'
    }
}

function Get-MuseQaUiControl {
    param([int]$ProcessId, [string[]]$Names, [string[]]$Kinds)
    $process = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
    $roots = [Windows.Automation.AutomationElement]::RootElement.FindAll(
        [Windows.Automation.TreeScope]::Children, $process)
    $matches = @{}
    foreach ($root in $roots) {
        foreach ($name in $Names) {
            $condition = [Windows.Automation.PropertyCondition]::new(
                [Windows.Automation.AutomationElement]::NameProperty, $name)
            try {
                if ($root.Current.IsOffscreen) { continue }
                $elements = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
                foreach ($element in $elements) {
                    try {
                        $state = $element.Current
                        if ($state.IsEnabled -and -not $state.IsOffscreen -and
                            $Kinds -ccontains $state.ControlType.ProgrammaticName) {
                            $runtimeId = $element.GetRuntimeId() -join ','
                            $matches[$runtimeId] = $element
                        }
                    } catch [Windows.Automation.ElementNotAvailableException] {}
                }
            } catch [Windows.Automation.ElementNotAvailableException] {}
        }
    }
    if ($matches.Count -gt 1) { throw "Multiple visible controls match the owned PID $ProcessId." }
    if ($matches.Count -eq 1) { return @($matches.Values)[0] }
}

function Wait-MuseQaUiControl {
    param($Context, [string[]]$Names, [string[]]$Kinds, [int]$TimeoutSeconds)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Assert-MuseQaOldProcess $Context
        $control = Get-MuseQaUiControl -ProcessId $Context.OldPid -Names $Names -Kinds $Kinds
        if ($control) { return $control }
        Start-Sleep -Milliseconds 200
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw ('Timed out waiting for an owned Muse control: ' + ($Names -join ' / '))
}

function Invoke-MuseQaUiControl {
    param($Control, [switch]$AllowExpand)
    Assert-MuseQaInteractiveRunner
    $pattern = $null
    if ($Control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        return
    }
    if ($AllowExpand -and $Control.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
        $pattern.Expand()
        return
    }
    throw 'This owned control does not expose a supported UI Automation action.'
}

function Read-MuseQaJournal {
    param($Context)
    foreach ($file in (Get-ChildItem -LiteralPath $Context.JournalDirectory -File -Filter '*.jsonl' -ErrorAction Stop |
        Where-Object { $_.Name -match '^(?:\d+-[a-f0-9-]{36}|installer-\d{8}T\d{9}Z-\d+)\.jsonl$' })) {
        if ($file.Length -gt 10MB -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Unexpected upgrade journal input.'
        }
        $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        try {
            $reader = [IO.StreamReader]::new($stream)
            try { $lines = $reader.ReadToEnd() -split '\r?\n' }
            finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
        if ($lines.Count -gt 0 -and $lines[-1] -ceq '') {
            $lines = @($lines | Select-Object -First ($lines.Count - 1))
        }
        for ($index = 0; $index -lt $lines.Length; $index++) {
            if ([string]::IsNullOrWhiteSpace($lines[$index])) { throw 'Empty event in upgrade journal.' }
            try { $record = ConvertFrom-Json -InputObject $lines[$index] -ErrorAction Stop }
            catch {
                # The active process may be appending while we read its last event.
                if ($index -eq $lines.Length - 1) { break }
                throw 'Malformed upgrade journal event.'
            }
            if ($record.pid -and $record.version -and $record.event -and $record.time) { $record }
        }
    }
}

function Wait-MuseQaJournalPhase {
    param($Context, [string]$Phase, [datetime]$AfterUtc, [int]$TimeoutSeconds,
        [string]$RequireAction, [datetime]$ActionAfterUtc = [datetime]::MinValue)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Assert-MuseQaOldProcess $Context
        $entries = @(Read-MuseQaJournal $Context | Where-Object {
            $_.pid -eq $Context.OldPid -and $_.version -ceq $Context.BaselineVersion -and
            $_.processType -ceq 'desktop-main' -and ([datetime]$_.time).ToUniversalTime() -ge $AfterUtc
        })
        if ($entries | Where-Object { $_.event -ceq 'state' -and $_.phase -ceq 'error' }) {
            throw "The old Muse process reported an updater error while awaiting $Phase."
        }
        $actionSeen = -not $RequireAction -or [bool]($entries | Where-Object {
            $_.event -ceq $RequireAction -and ([datetime]$_.time).ToUniversalTime() -ge $ActionAfterUtc
        })
        if ($actionSeen -and ($entries | Where-Object {
            $_.event -ceq 'state' -and $_.phase -ceq $Phase -and $_.targetVersion -ceq $Context.TargetVersion
        })) { return }
        Start-Sleep -Milliseconds 200
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw "Timed out waiting for updater phase $Phase for the exact candidate."
}

function New-MuseUpgradeUiContext {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$OldPid,
        [Parameter(Mandatory)][string]$InstalledExecutable,
        [Parameter(Mandatory)][ValidateSet('1.3.0','1.3.1')][string]$BaselineVersion,
        [Parameter(Mandatory)][ValidateSet('1.3.2')][string]$TargetVersion,
        [Parameter(Mandatory)][string]$ExpectedInstallerPath,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$InstallerSha256,
        [Parameter(Mandatory)][string]$JournalDirectory,
        [Parameter(Mandatory)][string]$EvidencePath
    )
    Initialize-MuseQaUi
    $installed = Get-MuseQaOwnedPath -Path $InstalledExecutable -Root $env:RUNNER_TEMP
    $journals = Get-MuseQaOwnedPath -Path $JournalDirectory -Root $env:RUNNER_TEMP
    $evidence = Get-MuseQaOwnedPath -Path $EvidencePath -Root $env:RUNNER_TEMP
    $pending = Get-MuseQaOwnedPath -Path $ExpectedInstallerPath -Root $env:LOCALAPPDATA
    $expectedLeaf = "muse-med-$TargetVersion-win-x64.exe"
    $expectedPending = Join-Path $env:LOCALAPPDATA ("muse-med-updater\pending\$expectedLeaf")
    if (-not (Test-MuseQaSamePath $pending $expectedPending) -or (Test-Path -LiteralPath $pending) -or
        [IO.Path]::GetFileName($installed) -ine 'muse-med.exe' -or
        (Get-Item -LiteralPath $installed -ErrorAction Stop).VersionInfo.FileVersion -ne $BaselineVersion -or
        -not (Test-Path -LiteralPath $journals -PathType Container) -or
        -not (Test-Path -LiteralPath (Split-Path -Parent $evidence) -PathType Container) -or
        [IO.Path]::GetExtension($evidence) -ine '.jsonl' -or (Test-Path -LiteralPath $evidence)) {
        throw 'Old Muse or isolated updater input is inconsistent; a fresh download and evidence file are required.'
    }
    $p = Get-MuseQaCimProcess $OldPid
    if (-not $p -or -not (Test-MuseQaSamePath $p.ExecutablePath $installed)) {
        throw 'Old Muse PID does not own the expected installed executable.'
    }
    $context = [pscustomobject]@{
        OldPid = $OldPid; OldCreatedUtc = ([datetime]$p.CreationDate).ToUniversalTime()
        InstalledExecutable = $installed; BaselineVersion = $BaselineVersion; TargetVersion = $TargetVersion
        ExpectedInstallerPath = $pending; InstallerSha256 = $InstallerSha256
        JournalDirectory = $journals; EvidencePath = $evidence; Stage = 'initialized'
        CheckBeforeUtc = [datetime]::MinValue; InstallBeforeUtc = [datetime]::MinValue
    }
    Assert-MuseQaOldProcess $context
    Add-MuseQaUiEvidence $context 'owned-old-process-verified'
    return $context
}

function Invoke-MuseUpdateCheck {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Context, [ValidateRange(5,300)][int]$CheckTimeoutSeconds = 90)
    Assert-MuseQaOldProcess $Context
    if ($Context.Stage -ne 'initialized') { throw 'The update check was already attempted.' }
    $Context.Stage = 'checking'
    $application = Wait-MuseQaUiControl $Context @('Application','应用') @('ControlType.MenuItem','ControlType.Button') $CheckTimeoutSeconds
    Add-MuseQaUiEvidence $Context 'application-menu-requested'
    Invoke-MuseQaUiControl $application -AllowExpand
    $check = Wait-MuseQaUiControl $Context @('Check for Updates…','Check for Updates...','检查更新…','检查更新...') @('ControlType.MenuItem') $CheckTimeoutSeconds
    $Context.CheckBeforeUtc = [datetime]::UtcNow.AddMilliseconds(-10)
    Add-MuseQaUiEvidence $Context 'check-for-updates-selected'
    Invoke-MuseQaUiControl $check
    Wait-MuseQaJournalPhase $Context 'available' $Context.OldCreatedUtc $CheckTimeoutSeconds -RequireAction 'check-requested' -ActionAfterUtc $Context.CheckBeforeUtc
    $Context.Stage = 'available'
}

function Invoke-MuseUpdateDownloadAndInstall {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Context,
        [ValidateRange(5,1200)][int]$DownloadTimeoutSeconds = 900,
        [ValidateRange(5,300)][int]$ConsentTimeoutSeconds = 90
    )
    Assert-MuseQaOldProcess $Context
    if ($Context.Stage -ne 'available') { throw 'The exact candidate was not offered by the old UI.' }
    $Context.Stage = 'downloading'
    $download = Wait-MuseQaUiControl $Context @('Download update','下载更新') @('ControlType.Button') $ConsentTimeoutSeconds
    $downloadBeforeUtc = [datetime]::UtcNow.AddMilliseconds(-10)
    Add-MuseQaUiEvidence $Context 'download-button-selected'
    Invoke-MuseQaUiControl $download
    Wait-MuseQaJournalPhase $Context 'ready' $downloadBeforeUtc $DownloadTimeoutSeconds
    $pending = Get-MuseQaOwnedPath -Path $Context.ExpectedInstallerPath -Root $env:LOCALAPPDATA
    if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256 -ErrorAction Stop).Hash -ine $Context.InstallerSha256) {
        throw 'Downloaded updater bytes do not match the reviewed candidate.'
    }
    Add-MuseQaUiEvidence $Context 'downloaded-installer-bytes-verified'
    $install = Wait-MuseQaUiControl $Context @('Install and Restart','安装并重启') @('ControlType.Button') $ConsentTimeoutSeconds
    $Context.InstallBeforeUtc = [datetime]::UtcNow.AddMilliseconds(-10)
    $Context.Stage = 'install-consent-given'
    Add-MuseQaUiEvidence $Context 'install-and-restart-selected'
    Invoke-MuseQaUiControl $install
}

function Get-MuseQaOwnedInstaller {
    param($Context)
    $leaf = [IO.Path]::GetFileName($Context.ExpectedInstallerPath)
    $elevation = Join-Path (Split-Path -Parent $Context.InstalledExecutable) 'resources\elevate.exe'
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = '$leaf'" -ErrorAction Stop |
        Where-Object {
            $_.SessionId -eq $sessionId -and
            (Test-MuseQaSamePath $_.ExecutablePath $Context.ExpectedInstallerPath) -and
            ([datetime]$_.CreationDate).ToUniversalTime() -ge $Context.InstallBeforeUtc -and
            $_.CommandLine -match '(?:^|\s)--updated(?=\s|$)' -and
            $_.CommandLine -match '(?:^|\s)--force-run(?=\s|$)'
        } | Where-Object {
            if ($_.ParentProcessId -eq $Context.OldPid) { return $true }
            $parent = Get-MuseQaCimProcess $_.ParentProcessId
            return $parent -and $parent.ParentProcessId -eq $Context.OldPid -and
                $parent.SessionId -eq $sessionId -and (Test-MuseQaSamePath $parent.ExecutablePath $elevation) -and
                ([datetime]$parent.CreationDate).ToUniversalTime() -ge $Context.InstallBeforeUtc
        })
    if ($processes.Count -gt 1) { throw 'Multiple expected installer processes were found.' }
    if ($processes.Count -eq 1) { return $processes[0] }
}

function Get-MuseQaRelaunchedCandidate {
    param($Context)
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'muse-med.exe'" -ErrorAction Stop |
        Where-Object {
            $_.ProcessId -ne $Context.OldPid -and $_.SessionId -eq $sessionId -and
            (Test-MuseQaSamePath $_.ExecutablePath $Context.InstalledExecutable) -and
            ([datetime]$_.CreationDate).ToUniversalTime() -ge $Context.InstallBeforeUtc -and
            $_.CommandLine -match '(?:^|\s)--updated(?=\s|$)' -and $_.CommandLine -notmatch '(?:^|\s)--type='
        })
    if ($processes.Count -gt 1) { throw 'Multiple automatically relaunched candidates were found.' }
    if ($processes.Count -eq 1) { return $processes[0] }
}

function Wait-MuseInstallerRestart {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Context, [ValidateRange(5,1200)][int]$InstallTimeoutSeconds = 900)
    Assert-MuseQaInteractiveRunner
    if ($Context.Stage -ne 'install-consent-given') { throw 'Native installation was not authorized in the old GUI.' }
    $Context.Stage = 'restarting'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $installerSeen = 0
    $finishClicked = $false
    do {
        $installer = Get-MuseQaOwnedInstaller $Context
        if ($installer) {
            if ($installerSeen -and $installerSeen -ne $installer.ProcessId) {
                throw 'The owned installer process was replaced unexpectedly.'
            }
            if (-not $installerSeen) {
                $installerSeen = [int]$installer.ProcessId
                Add-MuseQaUiEvidence $Context 'owned-installer-observed' $installerSeen
            }
            if (-not $finishClicked) {
                $finish = Get-MuseQaUiControl $installerSeen @('Finish','完成') @('ControlType.Button')
                if ($finish) {
                    $launch = Get-MuseQaUiControl $installerSeen @('Launch now','立即启动') @('ControlType.CheckBox')
                    $toggle = $null
                    if (-not $launch -or -not $launch.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$toggle) -or
                        $toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) {
                        throw 'Owned installer Finish appeared without a checked launch control.'
                    }
                    $current = Get-MuseQaOwnedInstaller $Context
                    if (-not $current -or $current.ProcessId -ne $installerSeen) {
                        throw 'The exact candidate installer exited before the Finish action.'
                    }
                    Add-MuseQaUiEvidence $Context 'native-finish-selected' $installerSeen
                    Invoke-MuseQaUiControl $finish
                    $finishClicked = $true
                }
            }
        }
        $successor = Get-MuseQaRelaunchedCandidate $Context
        if ($successor) {
            $entries = @(Read-MuseQaJournal $Context | Where-Object {
                ([datetime]$_.time).ToUniversalTime() -ge $Context.InstallBeforeUtc
            })
            $old = @($entries | Where-Object {
                $_.version -ceq $Context.BaselineVersion -and $_.pid -eq $Context.OldPid -and $_.processType -ceq 'desktop-main'
            })
            $completed = @($entries | Where-Object {
                $_.version -ceq $Context.TargetVersion -and $_.processType -ceq 'windows-installer' -and $_.event -ceq 'installer-completed'
            })
            $new = @($entries | Where-Object {
                $_.version -ceq $Context.TargetVersion -and $_.pid -eq $successor.ProcessId -and $_.processType -ceq 'desktop-main'
            })
            $quit = @($old | Where-Object event -CEQ 'quit-requested')
            $restartedEvent = @($new | Where-Object event -CEQ 'started')
            $interactive = @($new | Where-Object event -CEQ 'ui-interactive')
            $handoff = @($old | Where-Object event -CEQ 'installer-handoff')
            if ($interactive.Count -eq 1 -and $handoff.Count -eq 1 -and
                $quit.Count -eq 1 -and $completed.Count -eq 1 -and $restartedEvent.Count -eq 1) {
                $oldProcess = Get-MuseQaCimProcess $Context.OldPid
                if ($oldProcess -and ([datetime]$oldProcess.CreationDate).ToUniversalTime() -eq $Context.OldCreatedUtc) {
                    throw 'The previous Muse process remained alive after the successor became interactive.'
                }
                if (([datetime]$restartedEvent[0].time).ToUniversalTime() -lt ([datetime]$completed[0].time).ToUniversalTime() -or
                    ([datetime]$restartedEvent[0].time).ToUniversalTime() -lt ([datetime]$quit[0].time).ToUniversalTime()) {
                    throw 'The successor became active before the installer and old process handoff had completed.'
                }
                if ($installerSeen -and $completed[0].pid -ne $installerSeen) {
                    throw 'The installer completion journal did not belong to the observed candidate EXE.'
                }
                if ((Get-Item -LiteralPath $Context.InstalledExecutable -ErrorAction Stop).VersionInfo.FileVersion -ne $Context.TargetVersion) {
                    throw 'The restarted executable does not have the expected file version.'
                }
                $restarted = Get-MuseQaRelaunchedCandidate $Context
                if (-not $restarted -or $restarted.ProcessId -ne $successor.ProcessId) {
                    throw 'The exact installed candidate exited before the readiness check.'
                }
                $Context.Stage = 'restarted'
                Add-MuseQaUiEvidence $Context 'candidate-relaunched-and-interactive' $successor.ProcessId
                return [pscustomobject]@{
                    Pid = [int]$successor.ProcessId; InstallerPid = [int]$completed[0].pid
                    FromVersion = $Context.BaselineVersion; ToVersion = $Context.TargetVersion
                    FinishClicked = $finishClicked
                }
            }
        }
        Start-Sleep -Milliseconds 200
    } while ($watch.Elapsed.TotalSeconds -lt $InstallTimeoutSeconds)
    throw 'Timed out waiting for the installer-driven Muse relaunch and matching interactive journal.'
}

function Find-MuseQaNamedTreeRow {
    param([int]$ProcessId, [string]$Name)
    $direct = Get-MuseQaUiControl $ProcessId @($Name) @('ControlType.TreeItem')
    if ($direct) { return $direct }
    $leaf = Get-MuseQaUiControl $ProcessId @($Name) @('ControlType.Text')
    if (-not $leaf) { return }
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    try {
        for ($current = $walker.GetParent($leaf); $current; $current = $walker.GetParent($current)) {
            $kind = $current.Current.ControlType.ProgrammaticName
            if ($kind -ceq 'ControlType.TreeItem' -and -not $current.Current.IsOffscreen -and $current.Current.IsEnabled) {
                return $current
            }
            if ($kind -in @('ControlType.Tree','ControlType.Document','ControlType.Window')) { return }
        }
    } catch [Windows.Automation.ElementNotAvailableException] {}
}

function Confirm-MuseReopenedSessionUi {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][int]$SuccessorPid,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$WorkspaceTitle,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$SessionTitle,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$UserText,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$AssistantText,
        [ValidateRange(5,300)][int]$TimeoutSeconds = 120
    )
    Assert-MuseQaInteractiveRunner
    if ($Context.Stage -ne 'restarted' -or ($SessionTitle -in @($WorkspaceTitle, $UserText, $AssistantText)) -or
        $UserText -eq $AssistantText) {
        throw 'GUI readback requires the verified successor and distinct seeded conversation markers.'
    }
    $noticeNames = @(
        'The installer reports that the update completed. The recorded backup is not automatically cleaned up, and workspace and skills inside it are not moved to the new installation. Check that the backup still exists and copy needed files to a safe location.',
        '安装报告显示更新已完成，记录的旧应用备份不会自动清理；其中的工作区和技能不会自动迁回新安装目录。请先确认备份仍在，再将需要的文件复制到安全位置。'
    )
    $noticeAcknowledged = $false
    $expanded = $false
    $opened = $false
    $workspaceSeen = $false
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $current = Get-MuseQaRelaunchedCandidate $Context
        if (-not $current -or $current.ProcessId -ne $SuccessorPid) {
            throw 'The verified successor process is no longer available for GUI readback.'
        }
        if (-not $noticeAcknowledged) {
            $notice = Get-MuseQaUiControl $SuccessorPid $noticeNames @('ControlType.Text')
            if ($notice) {
                $acknowledge = Get-MuseQaUiControl $SuccessorPid @('OK','确定') @('ControlType.Button')
                if ($acknowledge) {
                    Invoke-MuseQaUiControl $acknowledge
                    $noticeAcknowledged = $true
                    Add-MuseQaUiEvidence $Context 'backup-notice-acknowledged' $SuccessorPid
                }
                Start-Sleep -Milliseconds 300
                continue
            }
        }
        $workspace = Find-MuseQaNamedTreeRow $SuccessorPid $WorkspaceTitle
        if ($workspace -or (Get-MuseQaUiControl $SuccessorPid @($WorkspaceTitle) @('ControlType.Text'))) {
            $workspaceSeen = $true
        }
        if ($workspaceSeen -and
            (Get-MuseQaUiControl $SuccessorPid @($UserText) @('ControlType.Text')) -and
            (Get-MuseQaUiControl $SuccessorPid @($AssistantText) @('ControlType.Text'))) {
            $Context.Stage = 'session-readback-verified'
            Add-MuseQaUiEvidence $Context 'seeded-session-visible-in-relaunched-gui' $SuccessorPid
            return [pscustomobject]@{ Pid = $SuccessorPid; Reopened = $true; WorkspaceVerified = $true;
                UserMessageVerified = $true; AssistantMessageVerified = $true; SessionRowSelected = $opened }
        }
        if (-not $opened) {
            $session = Find-MuseQaNamedTreeRow $SuccessorPid $SessionTitle
            if ($session) {
                Invoke-MuseQaUiControl $session
                $opened = $true
                Add-MuseQaUiEvidence $Context 'seeded-session-row-selected' $SuccessorPid
            } elseif ($workspace -and -not $expanded) {
                $pattern = $null
                if ($workspace.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
                    if ($pattern.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Collapsed) {
                        $pattern.Expand()
                    }
                } else {
                    Invoke-MuseQaUiControl $workspace
                }
                $expanded = $true
            }
        }
        Start-Sleep -Milliseconds 300
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw 'The exact seeded workspace and two conversation messages were not observed in the relaunched Muse GUI.'
}
