[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('1.3.0','1.3.1')] [string] $FromVersion,
    [Parameter(Mandatory)] [string] $BaselineInstaller,
    [Parameter(Mandatory)] [string] $CandidateArtifacts,
    [Parameter(Mandatory)] [ValidatePattern('^\d+\.\d+\.\d+$')] [string] $TargetVersion,
    [Parameter(Mandatory)] [ValidatePattern('^[a-f0-9]{40}$')] [string] $SourceCommit,
    [Parameter(Mandatory)] [string] $EvidenceDirectory,
    [string] $OldBlockmap
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_EVENT_NAME -ne 'workflow_dispatch' -or
    $env:GITHUB_REPOSITORY -ne 'felir7at62co-wq/muse-med' -or (Get-Process -Id $PID).SessionId -eq 0) {
    throw 'Installed-app acceptance requires an interactive GitHub-hosted Windows runner.'
}
if ([version]$TargetVersion -le [version]$FromVersion) { throw 'The candidate must be newer than the baseline.' }
$temp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path.TrimEnd('\')
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
if (-not $evidence.StartsWith("$temp\", [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $evidence)) {
    throw 'Evidence directory must be a new path under RUNNER_TEMP.'
}
$work = Join-Path $temp ('muse-upgrade-' + [guid]::NewGuid().ToString('N').Substring(0,12))
$homePath = Join-Path $work 'home'
$install = Join-Path $work 'installed'
$journals = Join-Path $evidence 'journals'
foreach($path in @($evidence, $work, $homePath, $journals)) { New-Item -ItemType Directory -Path $path | Out-Null }

function Write-QAPhase([string]$Phase) {
    $stamp = [DateTime]::UtcNow.ToString('o')
    Write-Host ("muse-qa {0} {1}" -f $stamp,$Phase)
    [pscustomobject]@{utc=$stamp;phase=$Phase} | ConvertTo-Json -Compress |
        Add-Content -LiteralPath (Join-Path $evidence 'phases.jsonl') -Encoding utf8NoBOM
}
Write-QAPhase 'runner-guard-passed'

$baselines = @{
    '1.3.0' = @{ installer='38f3ed42a16c3ec9de3eb10fa6dfa2d589f1af4a29fe1162e854aeb75c24e1d1'; blockmap='826a948f8f5fbf81cbea33149fc3afa645556dcec42d1e73d419739e7e04114f' }
    '1.3.1' = @{ installer='0d17ecf88533e992e629d7f8f1c8e21e0e86b10d5744fe6b164ab9229d68e9fb'; blockmap='4cf71bf3012a62ee22b6e1b7fa8f6c54eee4d51d79eeb5143e00dd60ff980788' }
}
$baseline = (Resolve-Path -LiteralPath $BaselineInstaller).Path
$fromHash = (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()
if ($fromHash -ne $baselines[$FromVersion].installer) { throw 'Baseline installer bytes did not match the original EXE.' }
$artifacts = (Resolve-Path -LiteralPath $CandidateArtifacts).Path
$candidateName = "muse-med-$TargetVersion-win-x64.exe"
$candidateHash = (Get-FileHash -LiteralPath (Join-Path $artifacts $candidateName) -Algorithm SHA256).Hash.ToLowerInvariant()
$build = Get-Content -LiteralPath (Join-Path $artifacts 'unsigned-build.json') -Raw | ConvertFrom-Json
if ($build.sourceCommit -ne $SourceCommit -or $build.version -ne $TargetVersion -or $build.target -ne 'win-x64') {
    throw 'Candidate provenance does not match the requested commit, version, and platform.'
}
Write-QAPhase 'installer-input-hashes-verified'
$ssl = (Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $ssl) { throw 'OpenSSL is required for loopback TLS.' }
$cert = Join-Path $work 'loopback.pem'
$key = Join-Path $work 'loopback-key.pem'
$der = Join-Path $work 'loopback.cer'
& $ssl.Source req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Muse disposable upgrade QA' -addext 'subjectAltName=IP:127.0.0.1' -addext 'basicConstraints=critical,CA:TRUE' -keyout $key -out $cert 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Could not generate the loopback certificate.' }
& $ssl.Source x509 -in $cert -outform DER -out $der
if ($LASTEXITCODE -ne 0) { throw 'Could not convert the loopback certificate.' }
$trusted = $null
$feed = $null
$priorUser = @{}
$priorProcess = @{}
$priorCA = $env:NODE_EXTRA_CA_CERTS
try {
    Write-QAPhase 'import-loopback-certificate'
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
    $trustedPath = 'Cert:\LocalMachine\Root\' + $certificate.Thumbprint
    $quotedDer = '"' + $der + '"'
    $certutil = (Get-Command certutil.exe).Source
    $trustCommand = Start-Process -FilePath $certutil -ArgumentList @('-f','-addstore','Root',$quotedDer) -WindowStyle Hidden -PassThru
    if (-not $trustCommand.WaitForExit(30000)) {
        Stop-Process -Id $trustCommand.Id -ErrorAction SilentlyContinue
        throw 'The disposable runner did not complete certificate import within 30 seconds.'
    }
    if ($trustCommand.ExitCode -ne 0) { throw 'The disposable runner did not trust the temporary loopback certificate.' }
    $trusted = Get-Item -LiteralPath $trustedPath
    Write-QAPhase 'loopback-certificate-imported'
    $env:NODE_EXTRA_CA_CERTS = $cert
    $feedReady = Join-Path $work 'feed-ready.json'
    $node = (Get-Command node.exe).Source
    $feedArgs = @((Join-Path $PSScriptRoot 'serve-upgrade-fixture.mjs'), '--artifacts', $artifacts,
        '--version', $TargetVersion, '--commit', $SourceCommit, '--cert', $cert, '--key', $key,
        '--ready', $feedReady, '--evidence', (Join-Path $evidence 'feed-requests.json'), '--rc-alias')
    if ($OldBlockmap) {
        $feedArgs += @('--old-blockmap', (Resolve-Path -LiteralPath $OldBlockmap).Path,
            '--old-blockmap-sha256', $baselines[$FromVersion].blockmap)
    }
    $start = [Diagnostics.ProcessStartInfo]::new($node)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WorkingDirectory = $PWD.Path
    foreach ($value in $feedArgs) { [void]$start.ArgumentList.Add($value) }
    $feed = [Diagnostics.Process]::Start($start)
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    while (-not (Test-Path -LiteralPath $feedReady)) {
        if ($feed.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'The verified HTTPS feed did not start.' }
        Start-Sleep -Milliseconds 400
    }
    $ready = Get-Content -LiteralPath $feedReady -Raw | ConvertFrom-Json
    $feedUri = [uri]$ready.feedUrl
    if ($feedUri.Scheme -ne 'https' -or $feedUri.Host -ne '127.0.0.1' -or -not $feedUri.AbsoluteUri.EndsWith('/')) {
        throw 'The feed must be a private HTTPS loopback directory.'
    }
    $null = Invoke-WebRequest -Uri ([uri]::new($feedUri,'latest.yml')) -TimeoutSec 20

    Write-QAPhase 'trusted-feed-ready'
    $installer = Start-Process -FilePath $baseline -ArgumentList "/S /CURRENTUSER /D=$install" -WindowStyle Hidden -PassThru
    if (-not $installer.WaitForExit(240000) -or $installer.ExitCode -ne 0) { throw 'The original Windows installer did not complete.' }
    $app = Join-Path $install 'muse-med.exe'
    $sourceFile = Join-Path $install 'resources/muse-update-sources.json'
    $asar = Join-Path $install 'resources/app.asar'
    $source = Get-Content -LiteralPath $sourceFile -Raw | ConvertFrom-Json
    $releaseUrl = 'https://muse.tos-cn-beijing.volces.com/releases/feeds/win-x64/'
    if ($source.version -ne $FromVersion -or $source.primary.url -ne $releaseUrl) {
        throw 'The old installation does not identify as the original baseline.'
    }
    Write-QAPhase 'original-installer-complete'
    $seedReceipt = Join-Path $evidence 'seeded-session.json'
    & $node (Join-Path $PSScriptRoot 'seed-upgrade-session.mjs') --install-root $install --home $homePath --output $seedReceipt
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $seedReceipt)) { throw 'The old packaged Host did not create a test session.' }
    $seeded = Get-Content -LiteralPath $seedReceipt -Raw | ConvertFrom-Json
    $sessionFile = [IO.Path]::GetFullPath((Join-Path $homePath $seeded.sessionPath))
    if (-not $sessionFile.StartsWith("$homePath\", [StringComparison]::OrdinalIgnoreCase)) { throw 'The seeded session must be inside the private product home.' }
    $oldAppHash = (Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash
    $oldAsarHash = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash
    $source.primary.url = $feedUri.AbsoluteUri
    $source | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $sourceFile -Encoding utf8NoBOM
    if ((Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash -ne $oldAppHash -or
        (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash -ne $oldAsarHash) {
        throw 'The isolated feed setting changed an application binary.'
    }
    $skillPath = Join-Path $install 'QA-Workspace/.agents/skills/local/SKILL.md'
    New-Item -ItemType Directory -Path (Split-Path $skillPath) -Force | Out-Null
    Set-Content -LiteralPath $skillPath -Value 'Disposable Windows update acceptance workspace sentinel' -Encoding utf8NoBOM
    $skillHash = (Get-FileHash -LiteralPath $skillPath -Algorithm SHA256).Hash
    $isolatedVariables = @{ MUSE_MED_HOME = $homePath; DSH_DESKTOP_UPDATE_JOURNAL_DIR = $journals }
    foreach($name in $isolatedVariables.Keys) {
        $priorUser[$name] = [Environment]::GetEnvironmentVariable($name,'User')
        $priorProcess[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
        [Environment]::SetEnvironmentVariable($name,$isolatedVariables[$name],'User')
        [Environment]::SetEnvironmentVariable($name,$isolatedVariables[$name],'Process')
    }
    Write-QAPhase 'seeded-session-and-private-update-configured'
    $old = Start-Process -FilePath $app -ArgumentList '--force-renderer-accessibility' -WorkingDirectory $install -WindowStyle Normal -PassThru
    . (Join-Path $PSScriptRoot 'drive-upgrade-ui.ps1')
    $uiInputs = @{
        OldPid = $old.Id; InstalledExecutable = $app; BaselineVersion = $FromVersion; TargetVersion = $TargetVersion
        ExpectedInstallerPath = Join-Path $env:LOCALAPPDATA "muse-med-updater/pending/$candidateName"
        InstallerSha256 = $candidateHash; JournalDirectory = $journals; EvidencePath = Join-Path $evidence 'ui-events.jsonl'
    }
    $ui = New-MuseUpgradeUiContext @uiInputs
    Write-QAPhase 'old-application-started'
    Invoke-MuseUpdateCheck -Context $ui
    Write-QAPhase 'offer-seen-in-old-application'
    Invoke-MuseUpdateDownloadAndInstall -Context $ui
    Write-QAPhase 'download-verified-and-install-confirmed'
    $successor = Wait-MuseInstallerRestart -Context $ui

    Write-QAPhase 'native-installer-exited-and-new-app-restarted'
    $updatedSources = Get-Content -LiteralPath $sourceFile -Raw | ConvertFrom-Json
    $installedVersion = (Get-Item -LiteralPath $app).VersionInfo.FileVersion
    if ($updatedSources.version -ne $TargetVersion -or $installedVersion -ne $TargetVersion -or $updatedSources.primary.url -ne $releaseUrl) {
        throw 'The restarted installation does not identify as the intended release.'
    }
    $backups = @(Get-ChildItem -LiteralPath $work -Directory -Filter 'installed.old-*')
    if ($backups.Count -ne 1) { throw 'The upgrade did not retain exactly one old installation directory.' }
    $relativeSkill = [IO.Path]::GetRelativePath($install, $skillPath)
    if ((Get-FileHash -LiteralPath (Join-Path $backups[0].FullName $relativeSkill) -Algorithm SHA256).Hash -ne $skillHash) {
        throw 'The upgrade changed the test workspace Skill file.'
    }
    $readbackText = & $node (Join-Path $PSScriptRoot 'verify-upgrade-session.mjs') --home $homePath --seed $seedReceipt
    if ($LASTEXITCODE -ne 0) { throw 'The candidate did not preserve the original logical session and messages.' }
    $readback = ($readbackText -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $readback.verified -or $readback.sessionId -ne $seeded.sessionId -or $readback.workspaceId -ne $seeded.workspaceId) {
        throw 'Session identity after the upgrade differs from the seeded session.'
    }
    $readback | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'readback.json') -Encoding utf8NoBOM
    $sessionUi = @{
        Context = $ui; SuccessorPid = $successor.Pid; WorkspaceTitle = $seeded.workspaceTitle
        SessionTitle = $seeded.sessionTitle; UserText = $seeded.userText; AssistantText = $seeded.assistantText
    }
    Write-QAPhase 'session-data-readback-verified'
    $visible = Confirm-MuseReopenedSessionUi @sessionUi
    if (-not ($visible.Reopened -and $visible.WorkspaceVerified -and $visible.UserMessageVerified -and $visible.AssistantMessageVerified)) {
        throw 'The restarted application did not reopen and show the seeded conversation.'
    }
    [pscustomobject]@{
        passed = $true; fromVersion = $FromVersion; toVersion = $TargetVersion; sourceCommit = $SourceCommit
        exactBaselineInstallerSha256 = $fromHash; exactCandidateInstallerSha256 = $candidateHash
        installedProductGuiCheckedAndDownloaded = $true; actualInstallerHandoffAndRestart = $true
        installedVersion = $installedVersion; installDirUserSkillBytePreserved = $true
        testSessionIdentityAndMessagesPreserved = $true; sessionReopenedInGui = $true; successor = $successor
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8NoBOM
} finally {
    foreach($name in $priorUser.Keys) {
        [Environment]::SetEnvironmentVariable($name,$priorUser[$name],'User')
        [Environment]::SetEnvironmentVariable($name,$priorProcess[$name],'Process')
    }
    [Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS',$priorCA,'Process')
    if ($feed -and -not $feed.HasExited) { Stop-Process -Id $feed.Id -ErrorAction SilentlyContinue }
    if ($trusted) { Remove-Item -LiteralPath $trustedPath -ErrorAction SilentlyContinue }
}
