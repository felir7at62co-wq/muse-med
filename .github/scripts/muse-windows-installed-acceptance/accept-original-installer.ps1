<# Private CI-only installation acceptance for the already-built exact Muse artifact. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactZip,
  [Parameter(Mandatory = $true)][string]$ArtifactMetadata,
  [Parameter(Mandatory = $true)][string]$EvidenceRoot,
  [string]$SourceRoot = (Get-Location).Path,
  [switch]$PrepareBundledVisualCpp
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Only a disposable GitHub Actions Windows runner is supported' }
$sourceCommit = $env:MUSE_CI_TRANSFER_SOURCE_COMMIT
if ($sourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'MUSE_CI_TRANSFER_SOURCE_COMMIT must contain an explicit complete source commit' }
$zipDigest = '88ebf218fcc748dd620443b0565cc7be4ad4be0c768b684598299cd4230c4c47'
$expectedZipBytes = 766360946
$version = '1.0.3'
$vcHash = '843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c'
$minimumVc = [version]'14.51.36247.0'
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
if (Test-Path -LiteralPath $EvidenceRoot) { throw 'The acceptance evidence directory must be new' }
$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $EvidenceRoot.StartsWith($runnerTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence and installation must stay below RUNNER_TEMP' }
if ((& git -C $SourceRoot rev-parse HEAD).Trim() -ne $sourceCommit) { throw 'Acceptance helpers must come from the exact release source' }
if ($LASTEXITCODE -ne 0) { throw 'Source commit lookup failed' }
if (Get-Process -Name 'muse-med' -ErrorAction SilentlyContinue) { throw 'An existing Muse process prevents isolated acceptance' }
New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
$result = [ordered]@{ version = $version; sourceCommit = $sourceCommit; artifactId = 11460053986; success = $false;
  startedAt = [DateTime]::UtcNow.ToString('o'); stage = 'identity'; guiLaunch = 'not-performed'; cleanMachine = 'not-performed' }
function Save-Result { $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installer-result.json') -Encoding utf8 }
function Get-VcVersion {
  $entry = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
  if ($null -eq $entry -or $entry.Installed -ne 1) { return $null }
  return [version]("{0}.{1}.{2}.{3}" -f $entry.Major, $entry.Minor, $entry.Bld, $entry.Rbld)
}
function Run-Wait([string]$Executable, [string]$Arguments, [int]$TimeoutSeconds) {
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-File -LiteralPath (Join-Path $EvidenceRoot 'timeout-termination.log')
    throw 'Owned acceptance process exceeded its deadline'
  }
  $process.Refresh()
  return $process.ExitCode
}
try {
  Save-Result
  $metadata = Get-Content -LiteralPath $ArtifactMetadata -Raw | ConvertFrom-Json
  if ($metadata.id -ne 11460053986 -or $metadata.name -ne "muse-win-x64-$sourceCommit" -or
    $metadata.size_in_bytes -ne $expectedZipBytes -or $metadata.digest -ne "sha256:$zipDigest" -or $metadata.expired) {
    throw 'The GitHub artifact metadata differs from the qualified build'
  }
  if ($metadata.workflow_run.id -ne 37567499544 -or $metadata.workflow_run.head_sha -ne $sourceCommit -or
    $metadata.workflow_run.repository_id -ne 1365170863 -or $metadata.workflow_run.head_repository_id -ne 1365170863) {
    throw 'The artifact does not belong to the exact qualified workflow run and source repository'
  }
  if ((Get-Item -LiteralPath $ArtifactZip).Length -ne $expectedZipBytes -or
    (Get-FileHash -LiteralPath $ArtifactZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $zipDigest) {
    throw 'The original GitHub artifact ZIP has incorrect complete bytes'
  }
  $result.artifactZip = @{ bytes = $expectedZipBytes; sha256 = $zipDigest; githubDigestMatched = $true;
    workflowRun = $metadata.workflow_run.id; workflowHead = $metadata.workflow_run.head_sha }
  $artifacts = Join-Path $EvidenceRoot 'artifact'
  Expand-Archive -LiteralPath $ArtifactZip -DestinationPath $artifacts
  $record = Get-Content -LiteralPath (Join-Path $artifacts 'unsigned-build.json') -Raw | ConvertFrom-Json
  if ($record.schemaVersion -ne 1 -or $record.target -ne 'win-x64' -or $record.version -ne $version -or
    $record.sourceCommit -ne $sourceCommit -or $record.unsigned -ne $true) { throw 'Unsigned build identity differs' }
  $filenames = @("muse-med-$version-win-x64.exe", "muse-med-$version-win-x64.exe.blockmap", 'latest.yml')
  if (@($record.artifacts.PSObject.Properties).Count -ne $filenames.Count) { throw 'Unexpected build-record members' }
  $archiveFilenames = @($filenames + @('unsigned-build.json', 'builder-debug.yml'))
  $actualFilenames = @(Get-ChildItem -LiteralPath $artifacts -File -Force | Select-Object -ExpandProperty Name)
  if ($actualFilenames.Count -ne 5 -or @(Get-ChildItem -LiteralPath $artifacts -Directory -Force).Count -ne 0 -or
    @(Compare-Object -ReferenceObject $archiveFilenames -DifferenceObject $actualFilenames -CaseSensitive).Count -ne 0) {
    throw 'Unexpected GitHub artifact archive members'
  }
  $diagnostic = Join-Path $artifacts 'builder-debug.yml'
  $diagnosticHash = 'e959fb106c8946f04d42697e9c96b25d90ef50cef404e8e257081d6736d000ea'
  if ((Get-Item -LiteralPath $diagnostic).Length -ne 7902 -or
    (Get-FileHash -LiteralPath $diagnostic -Algorithm SHA256).Hash.ToLowerInvariant() -ne $diagnosticHash) {
    throw 'Original builder diagnostic differs from its fixed archive bytes'
  }
  $result.originalBuilderDiagnostic = @{ bytes = 7902; sha256 = $diagnosticHash; published = $false }
  foreach ($filename in $filenames) {
    $file = Join-Path $artifacts $filename
    $expected = $record.artifacts.$filename
    $sha512 = [Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash -LiteralPath $file -Algorithm SHA512).Hash))
    if ((Get-Item -LiteralPath $file).Length -ne $expected.size -or
      (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.sha256 -or $sha512 -ne $expected.sha512) {
      throw 'An installer, blockmap or feed differs from its completion record'
    }
  }
  $installer = Join-Path $artifacts "muse-med-$version-win-x64.exe"
  $result.installer = @{ filename = [IO.Path]::GetFileName($installer); bytes = $record.artifacts."muse-med-$version-win-x64.exe".size;
    sha256 = $record.artifacts."muse-med-$version-win-x64.exe".sha256; signatureStatus = (Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString() }
  $result.stage = 'extract-original-payload'; Save-Result
  $sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
  if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw 'The runner 7-Zip executable is missing' }
  $stub = Join-Path $EvidenceRoot 'nsis-contents'
  & $sevenZip x '-y' "-o$stub" $installer *> (Join-Path $EvidenceRoot 'nsis-extraction.log')
  if ($LASTEXITCODE -ne 0) { throw 'Original NSIS archive extraction failed' }
  $archives = @(Get-ChildItem -LiteralPath $stub -Recurse -File -Filter 'app-64.7z')
  if ($archives.Count -ne 1) { throw 'Expected one original x64 application archive' }
  $payload = Join-Path $EvidenceRoot 'original-payload'
  & $sevenZip x '-y' "-o$payload" $archives[0].FullName *> (Join-Path $EvidenceRoot 'payload-extraction.log')
  if ($LASTEXITCODE -ne 0) { throw 'Original x64 application extraction failed' }
  $vc = Join-Path $payload 'resources\runtime\media\prerequisites\vc_redist.x64.exe'
  $vcSignature = Get-AuthenticodeSignature -LiteralPath $vc
  if ((Get-Item -LiteralPath $vc).Length -ne 18731856 -or
    (Get-FileHash -LiteralPath $vc -Algorithm SHA256).Hash.ToLowerInvariant() -ne $vcHash -or
    $vcSignature.Status -ne 'Valid' -or $vcSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
    throw 'Embedded Microsoft prerequisite differs from its locked bytes or trusted signer'
  }
  $beforeVc = Get-VcVersion
  $result.visualCpp = @{ embeddedSha256 = $vcHash; minimumVersion = $minimumVc.ToString();
    beforeVersion = $(if ($null -eq $beforeVc) { 'missing' } else { $beforeVc.ToString() }); runnerProvisioned = $false }
  if ($null -eq $beforeVc -or $beforeVc -lt $minimumVc) {
    if (-not $PrepareBundledVisualCpp) { throw 'Silent installation defaults to declining the absent VC prerequisite; explicit disposable-runner provisioning is required' }
    $result.stage = 'prepare-bundled-vc'; Save-Result
    $vcExit = Run-Wait $vc '/install /quiet /norestart' 600
    $result.visualCpp.exitCode = $vcExit
    $result.visualCpp.runnerProvisioned = $true
    if ($vcExit -notin @(0, 1638)) { throw 'Bundled VC prerequisite did not complete without requiring restart' }
  }
  $afterVc = Get-VcVersion
  if ($null -eq $afterVc -or $afterVc -lt $minimumVc) { throw 'The Windows runner lacks the required VC runtime after provisioning' }
  $result.visualCpp.afterVersion = $afterVc.ToString()
  $install = Join-Path $EvidenceRoot 'installed-muse'
  $result.stage = 'silent-install'; Save-Result
  # NSIS consumes /D= through end-of-command; it must remain last. No /force-run is supplied.
  $installExit = Run-Wait $installer "/S /currentuser /no-desktop-shortcut /D=$install" 1200
  $result.installerExitCode = $installExit
  if ($installExit -ne 0) { throw 'The original Muse installer reported failure' }
  if (-not (Test-Path -LiteralPath (Join-Path $install 'muse-med.exe') -PathType Leaf)) { throw 'The installer did not populate the selected directory' }
  if (Get-Process -Name 'muse-med' -ErrorAction SilentlyContinue) { throw 'Silent installation unexpectedly launched the Muse GUI' }
  $result.noGuiAutoLaunch = $true
  $result.executableFileVersion = (Get-Item -LiteralPath (Join-Path $install 'muse-med.exe')).VersionInfo.FileVersion
  $result.executableProductVersion = (Get-Item -LiteralPath (Join-Path $install 'muse-med.exe')).VersionInfo.ProductVersion
  if ($result.executableFileVersion -notmatch '^1\.0\.3(?:\.0)?$' -or $result.executableProductVersion -notmatch '^1\.0\.3(?:\.0)?$') {
    throw 'Installed executable version fields differ from the product release'
  }
  $result.stage = 'installed-byte-and-runtime-checks'; Save-Result
  Push-Location $SourceRoot
  try {
    & pnpm exec tsx (Join-Path $PSScriptRoot 'accept-installed.ts') $artifacts $payload $install (Join-Path $EvidenceRoot 'installed-acceptance.json') *> (Join-Path $EvidenceRoot 'installed-smoke.log')
    if ($LASTEXITCODE -ne 0) { throw 'Installed sealed runtime or Host smoke failed; retain its private diagnostic log' }
  } finally { Pop-Location }
  $acceptance = Get-Content -LiteralPath (Join-Path $EvidenceRoot 'installed-acceptance.json') -Raw | ConvertFrom-Json
  if ($acceptance.success -ne $true) { throw 'Installed acceptance did not record successful completion' }
  $result.installedAppAsarSha256 = $acceptance.appAsarSha256
  $result.completePayloadByteComparison = $acceptance.completePayloadByteComparison
  $result.sealedRuntimeSmoke = $acceptance.sealedRuntimeSmoke
  $result.stage = 'complete'; $result.success = $true
  $result.completedAt = [DateTime]::UtcNow.ToString('o'); Save-Result
  $result | ConvertTo-Json -Depth 12
} catch {
  $result.failureClass = $_.Exception.GetType().Name
  $result.completedAt = [DateTime]::UtcNow.ToString('o'); Save-Result
  throw
}
