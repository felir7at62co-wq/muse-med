# Build one new editable project using the installed Windows Jianying CLI.
# The command mapping is derived from Muse's aa剪映 toolkit; no media is rendered here.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $PlanPath,
  [Parameter(Mandatory = $true)][string] $ResultPath,
  [switch] $NativeHost
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$utf8 = New-Object Text.UTF8Encoding($false)

if (-not $NativeHost) {
  $runtime = $null
  try {
    # lyra-cli authenticates the parent process name. Keep the system-host copy
    # private to this operation instead of adding an executable to Jianying's installation.
    if ($env:JY_HOST) {
      if (-not [IO.Path]::IsPathRooted($env:JY_HOST) -or -not (Test-Path -LiteralPath $env:JY_HOST -PathType Leaf)) { throw 'JY_HOST must identify an existing absolute PowerShell-compatible host' }
      $privateHost = [IO.Path]::GetFullPath($env:JY_HOST)
    } else {
      $systemHost = if ($env:MUSE_JIANYING_POWERSHELL) { $env:MUSE_JIANYING_POWERSHELL } else { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
      if (-not [IO.Path]::IsPathRooted($systemHost) -or -not (Test-Path -LiteralPath $systemHost -PathType Leaf)) { throw 'Windows PowerShell is unavailable' }
      $runtime = Join-Path ([IO.Path]::GetTempPath()) ('muse-jy-host-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $runtime | Out-Null
      $privateHost = Join-Path $runtime 'vebun.exe'
      Copy-Item -LiteralPath $systemHost -Destination $privateHost
    }
    & $privateHost -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -PlanPath $PlanPath -ResultPath $ResultPath -NativeHost
    $code = $LASTEXITCODE
  } finally {
    # This unique directory contains only this completed invocation's host copy.
    if ($runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force }
  }
  exit $code
}

$events = New-Object Collections.Generic.List[object]
$warnings = New-Object Collections.Generic.List[string]
$ref = $null
$draftPath = $null
$cli = $null

# Claim this invocation's receipt exclusively before any catch path may rewrite it.
$claim = [IO.File]::Open($ResultPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $bytes = $utf8.GetBytes('{"ok":false,"state":"initializing"}')
  $claim.Write($bytes, 0, $bytes.Length)
} finally { $claim.Dispose() }

function Save-Result([object] $Value) {
  [IO.File]::WriteAllText($ResultPath, ($Value | ConvertTo-Json -Depth 100 -Compress), $utf8)
}

function Invoke-Native([string[]] $Arguments, [switch] $HelpText) {
  $raw = @(& $script:cli @Arguments 2>&1)
  $code = $LASTEXITCODE
  $text = ($raw | Out-String).Trim()
  if ($HelpText) {
    if ($code -ne 0 -or ($text -match '"err_code"\s*:\s*(-?\d+)' -and [long]$Matches[1] -ne 0)) {
      throw "Jianying capability probe failed: $($Arguments -join ' '): $text"
    }
    return $text
  }
  $start = $text.IndexOf('{')
  if ($start -lt 0) { throw "Jianying returned no JSON (exit=$code): $($Arguments[0..([math]::Min(2,$Arguments.Count-1))] -join ' '): $text" }
  $envelope = $text.Substring($start) | ConvertFrom-Json -ErrorAction Stop
  if ($code -ne 0 -or $null -eq $envelope.err_code -or [long]$envelope.err_code -ne 0) {
    throw "Jianying command failed (exit=$code, code=$($envelope.err_code)): $($envelope.err_msg)"
  }
  return $envelope.result
}

function Invoke-Step([string] $Name, [string[]] $Arguments) {
  $event = [ordered]@{ step = $Name; state = 'started'; arguments = $Arguments; result = $null }
  $events.Add($event)
  Save-Result ([ordered]@{ ok = $false; state = 'building'; ref = $script:ref; path = $script:draftPath; events = $events.ToArray() })
  $value = Invoke-Native $Arguments
  $event.state = 'complete'
  $event.result = $value
  Save-Result ([ordered]@{ ok = $false; state = 'building'; ref = $script:ref; path = $script:draftPath; events = $events.ToArray() })
  return $value
}

function Require-Flags([string[]] $Command, [string[]] $Flags) {
  $help = Invoke-Native ($Command + @('--help')) -HelpText
  foreach ($flag in $Flags) {
    if ($help -notmatch ([regex]::Escape($flag) + '(?:[ =,\r\n]|$)')) {
      throw "Installed Jianying does not support $($Command -join ' ') $flag"
    }
  }
}

function Format-Time([long] $Microseconds) { return ([string]$Microseconds + 'us') }
function Format-Number([double] $Value) { return $Value.ToString('R', [Globalization.CultureInfo]::InvariantCulture) }
function Resource-Path([string] $Path) { return ('local:///' + ([IO.Path]::GetFullPath($Path) -replace '\\','/')) }
function Segment-Id([object] $Result) {
  $ids = @($Result.segment_ids)
  if ($ids.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$ids[0])) { throw 'Jianying did not return exactly one new segment ID' }
  return [string]$ids[0]
}

function Set-Volume([string] $Id, [string] $Kind, [double] $Gain) {
  Invoke-Step 'volume' @('draft',$Kind,'volume','--ref',$script:ref,'--seg-id',$Id,'--linear',(Format-Number $Gain)) | Out-Null
}

function Style-Text([string] $Id, [object] $Style, [switch] $Watermark) {
  $args = @('draft','text','style','--ref',$script:ref,'--seg-id',$Id,'--size',(Format-Number $Style.font_size_ui),'--color','#FFFFFF','--bold','false','--letter-spacing','0')
  if ($Watermark) { $args += @('--outline-width','0') }
  # Preserve the existing rich-text stroke target; actual editor typography is reviewed separately.
  else { $args += @('--outline-color','#000000','--outline-width',(Format-Number ($Style.border_width_ui * 0.002))) }
  Invoke-Step 'text-style' $args | Out-Null
  $x = if ($Watermark) { '0.7' } else { '0' }
  $y = if ($Watermark) { '-0.8625' } elseif ($null -ne $Style.editor_y) {
    Format-Number ([double]$Style.editor_y / $script:canvasHeight)
  } else { Format-Number $Style.transform_y }
  Invoke-Step 'text-position' @('draft','text','translate','--ref',$script:ref,'--seg-id',$Id,'--x',$x,'--y',$y) | Out-Null
}

try {
  if (-not (Test-Path -LiteralPath $PlanPath -PathType Leaf)) { throw 'PlanPath must identify a prepared JSON plan' }
  $plan = Get-Content -Raw -LiteralPath $PlanPath -Encoding UTF8 | ConvertFrom-Json
  if ($plan.schema_version -ne 1 -or $plan.audio_mode -cne 'embedded') { throw 'Unsupported AA draft plan' }
  $draftPath = [IO.Path]::GetFullPath([string]$plan.draft_path)
  $ref = [string]$plan.ref
  if ($ref -cne ('local://' + [string]$plan.name)) { throw 'Candidate name and reference differ' }
  if (Test-Path -LiteralPath $draftPath) { throw "Draft already exists: $draftPath" }
  if (-not (Test-Path -LiteralPath ([string]$plan.drafts_dir) -PathType Container)) { throw 'Editor draft root is unavailable' }

  if ($env:JY_CLI) {
    if (-not [IO.Path]::IsPathRooted($env:JY_CLI) -or -not (Test-Path -LiteralPath $env:JY_CLI -PathType Leaf)) { throw 'JY_CLI must name an existing absolute executable' }
    $cli = [IO.Path]::GetFullPath($env:JY_CLI)
  } else {
    $apps = Join-Path $env:LOCALAPPDATA 'JianyingPro\Apps'
    if (Test-Path -LiteralPath $apps -PathType Container) {
      $cli = Get-ChildItem -LiteralPath $apps -Directory | Where-Object { $_.Name -match '^\d+(\.\d+)+$' } |
        Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'lyra-cli.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
  }
  if (-not $cli) { throw 'Installed Jianying lyra-cli.exe is unavailable; no alternate renderer was used' }
  $version = Invoke-Native @('--version') -HelpText
  Require-Flags @('draft','project','create') @('--ref','--dir')
  Require-Flags @('draft','video','add') @('--ref','--resource','--start','--duration','--track','--width','--height')
  Require-Flags @('draft','video','volume') @('--ref','--seg-id','--linear')
  Require-Flags @('draft','subtitle','add') @('--ref','--content','--start','--duration','--track')
  Require-Flags @('draft','text','style') @('--ref','--seg-id','--size','--color','--outline-width')
  Require-Flags @('draft','text','translate') @('--ref','--seg-id','--x','--y')
  $configHelp = Invoke-Native @('draft','config','--help') -HelpText
  if ($configHelp -notmatch '--ratio') { throw 'Installed Jianying cannot set the draft aspect ratio' }
  if ($null -ne $plan.bgm -or $null -ne $plan.ending_audio) {
    Require-Flags @('draft','audio','add') @('--ref','--kind','--resource','--start','--duration')
    Require-Flags @('draft','audio','volume') @('--ref','--seg-id','--linear')
  }
  if ($null -ne $plan.ending_effect) {
    Require-Flags @('draft','video','speed') @('--ref','--seg-id','--speed')
    Require-Flags @('draft','video','mix-mode') @('--ref','--seg-id','--resource','--enable')
  }
  $existing = Invoke-Native @('draft','project','list')
  if (@($existing.projects | Where-Object { $_.ref -ceq $ref -or $_.name -ceq $plan.name -or $_.draft_name -ceq $plan.name }).Count -gt 0) { throw "Candidate already registered: $ref" }
  $created = Invoke-Step 'create' @('draft','project','create','--ref',$ref,'--dir',[string]$plan.drafts_dir)
  if ($created.ref -cne $ref) { throw 'Created project reference differs from the requested candidate' }
  Invoke-Step 'canvas' @('draft','config','--ref',$ref,'--ratio',[string]$plan.ratio) | Out-Null
  $geometry = @('draft','config','--ref',$ref)
  foreach ($field in @('width','height','fps')) {
    if ($configHelp -match ('--' + $field + '(?:[ =,\r\n]|$)')) { $geometry += @("--$field",[string]$plan.delivery.$field) }
    else { $warnings.Add("Installed Jianying config has no --$field; verify actual editor geometry before delivery") }
  }
  if ($geometry.Count -gt 4) { Invoke-Step 'geometry' $geometry | Out-Null }
  if ($null -ne $plan.draft_style.subtitle.editor_y) {
    $canvas = Invoke-Step 'canvas-readback' @('draft','extract','--ref',$ref,'--scope','full')
    $rows = @($canvas.json_result | ConvertFrom-Json | Where-Object { $_.type -eq 'draft' })
    if ($rows.Count -ne 1 -or [double]$rows[0].attributes.height -le 0) { throw 'Cannot read the native canvas height for subtitle positioning' }
    $script:canvasHeight = [double]$rows[0].attributes.height
  }

  $bodyIds = New-Object Collections.Generic.List[string]
  foreach ($video in @($plan.native_videos)) {
    $added = Invoke-Step 'body-video' @('draft','video','add','--ref',$ref,'--resource',(Resource-Path $video.path),'--width',[string]$video.width,'--height',[string]$video.height,'--start',(Format-Time $video.start_us),'--duration',(Format-Time $video.duration_us),'--track','0')
    $id = Segment-Id $added
    $bodyIds.Add($id)
    Set-Volume $id 'video' $plan.audio.master_gain
  }
  $bgmId = $null
  if ($null -ne $plan.bgm) {
    $added = Invoke-Step 'bgm' @('draft','audio','add','--ref',$ref,'--kind','music','--resource',(Resource-Path $plan.native_bgm.path),'--start','0us','--duration',(Format-Time $plan.native_bgm.duration_us))
    $bgmId = Segment-Id $added
    Set-Volume $bgmId 'audio' $plan.audio.bgm_gain
  }
  $endingImageId = $null
  if ($null -ne $plan.ending) {
    Require-Flags @('draft','video','add') @('--is-photo')
    $added = Invoke-Step 'ending-image' @('draft','video','add','--ref',$ref,'--resource',(Resource-Path $plan.native_ending.path),'--width',[string]$plan.native_ending.width,'--height',[string]$plan.native_ending.height,'--is-photo','true','--start',(Format-Time $plan.native_body_end_us),'--duration',(Format-Time $plan.native_ending.duration_us),'--track','0')
    $endingImageId = Segment-Id $added
    Set-Volume $endingImageId 'video' 0
  }
  $endingAudioId = $null
  if ($null -ne $plan.ending_audio) {
    $added = Invoke-Step 'ending-audio' @('draft','audio','add','--ref',$ref,'--kind','sound','--resource',(Resource-Path $plan.native_ending_audio.path),'--start',(Format-Time $plan.native_body_end_us),'--duration',(Format-Time $plan.native_ending_audio.duration_us))
    $endingAudioId = Segment-Id $added
    Set-Volume $endingAudioId 'audio' 1
  }
  $endingEffectId = $null
  if ($null -ne $plan.ending_effect) {
    $added = Invoke-Step 'ending-effect' @('draft','video','add','--ref',$ref,'--resource',(Resource-Path $plan.native_ending_effect.path),'--width',[string]$plan.native_ending_effect.width,'--height',[string]$plan.native_ending_effect.height,'--start',(Format-Time $plan.native_body_end_us),'--duration',(Format-Time $plan.native_ending_effect.source_duration_us))
    $endingEffectId = Segment-Id $added
    Set-Volume $endingEffectId 'video' 0
    if ($plan.native_ending_effect.speed -ne 1) {
      Invoke-Step 'ending-effect-speed' @('draft','video','speed','--ref',$ref,'--seg-id',$endingEffectId,'--speed',(Format-Number $plan.native_ending_effect.speed)) | Out-Null
    }
    Invoke-Step 'ending-effect-screen' @('draft','video','mix-mode','--ref',$ref,'--seg-id',$endingEffectId,'--resource',('vimo://' + [string]$plan.native_ending_effect.blend_resource_id),'--enable') | Out-Null
  }
  $subtitleIds = New-Object Collections.Generic.List[string]
  $subtitleTrack = $null
  foreach ($cue in @($plan.native_subtitles)) {
    $arguments = @('draft','subtitle','add','--ref',$ref,'--content',[string]$cue.text,'--start',(Format-Time $cue.start_us),'--duration',(Format-Time $cue.duration_us))
    if ($null -ne $subtitleTrack) { $arguments += @('--track',[string]$subtitleTrack) }
    $added = Invoke-Step 'subtitle' $arguments
    $id = Segment-Id $added
    if ($null -eq $subtitleTrack) {
      $segment = @($added.affected_segments | Where-Object { $_.segment_id -ceq $id })
      if ($segment.Count -ne 1 -or $null -eq $segment[0].track_index) { throw 'Subtitle addition did not report its track index' }
      $subtitleTrack = [int]$segment[0].track_index
    }
    $subtitleIds.Add($id)
    Style-Text $id $plan.draft_style.subtitle
  }
  $watermarkId = $null
  if ($plan.delivery.add_watermark) {
    $notice = -join ([char[]]@(0x5185,0x5bb9,0x7531,0x41,0x49,0x751f,0x6210))
    $added = Invoke-Step 'watermark' @('draft','text','add','--ref',$ref,'--content',$notice,'--start','0us','--duration',(Format-Time $plan.native_duration_us))
    $watermarkId = Segment-Id $added
    Style-Text $watermarkId $plan.draft_style.watermark -Watermark
  }
  $full = Invoke-Step 'readback-full' @('draft','extract','--ref',$ref,'--scope','full')
  $timeline = Invoke-Step 'readback-timeline' @('draft','extract','--ref',$ref,'--scope','timeline')
  if (-not (Test-Path -LiteralPath (Join-Path $draftPath 'draft_content.json') -PathType Leaf)) { throw 'Jianying did not save the project at the requested draft root' }
  Save-Result ([ordered]@{ ok = $true; state = 'saved'; backend = 'aa-jianying'; ref = $ref; path = $draftPath; draft_id = $created.draft_id;
    runtime = @{ cli = $cli; version = $version; cli_sha256 = (Get-FileHash -LiteralPath $cli -Algorithm SHA256).Hash.ToLowerInvariant() };
    body_segment_ids = $bodyIds.ToArray(); subtitle_segment_ids = $subtitleIds.ToArray();
    bgm_segment_id = $bgmId; ending_image_segment_id = $endingImageId; ending_audio_segment_id = $endingAudioId;
    ending_effect_segment_id = $endingEffectId;
    watermark_segment_id = $watermarkId;
    full = $full; timeline = $timeline;
    warnings = $warnings.ToArray(); events = $events.ToArray(); editor_open_verified = $false })
  exit 0
} catch {
  Save-Result ([ordered]@{ ok = $false; state = 'failed'; backend = 'aa-jianying'; ref = $ref; path = $draftPath;
    error = $_.Exception.Message; events = $events.ToArray(); editor_open_verified = $false })
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
