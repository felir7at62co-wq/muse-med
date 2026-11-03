
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$DraftName,
  [Parameter(Mandatory=$true)][string]$DraftPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$TimeoutMs,
  [uint32]$OwnerPid = 0
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
trap {
  $message = ($_.Exception.Message -split '[\r\n]',2)[0]
  if ($message.Length -gt 300) { $message = $message.Substring(0,300) }
  [Console]::Error.WriteLine($message)
  exit 1
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
. (Join-Path $PSScriptRoot 'native-export-folder.ps1')
. (Join-Path $PSScriptRoot 'native-export-open.ps1')
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class MuseNativeExport {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint Type; public InputData Data; }
  [StructLayout(LayoutKind.Explicit)] private struct InputData {
    [FieldOffset(0)] public KEY Key;
    [FieldOffset(0)] public MOUSE Mouse;
  }
  [StructLayout(LayoutKind.Sequential)] private struct KEY { public ushort VirtualKey, Scan; public uint Flags, Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] private struct MOUSE { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window,uint command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  public static bool Activate(IntPtr target, uint expectedOwner) {
    uint owner;
    IntPtr foreground = GetForegroundWindow();
    if (foreground == IntPtr.Zero) return false;
    GetWindowThreadProcessId(foreground,out owner);
    return owner == expectedOwner && SetForegroundWindow(target);
  }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT bounds);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] input, int size);
  private static void Send(IntPtr window, INPUT[] input) {
    if (GetForegroundWindow() != window) throw new InvalidOperationException("Editor focus changed");
    if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(INPUT))) != input.Length) throw new Win32Exception();
  }
  public static void Click(IntPtr window, int x, int y) {
    if (GetForegroundWindow() != window || !SetCursorPos(x,y)) throw new InvalidOperationException("Editor focus changed");
    POINT p;
    if (!GetCursorPos(out p) || p.X != x || p.Y != y || GetAncestor(WindowFromPoint(p),2) != window)
      throw new InvalidOperationException("The verified editor control is not on top");
    INPUT[] input = new INPUT[2];
    input[0].Data.Mouse.Flags = 2;
    input[1].Data.Mouse.Flags = 4;
    Send(window,input);
  }
  private static INPUT Key(ushort key, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.Type = 1; i.Data.Key.VirtualKey = key;
    i.Data.Key.Scan = scan; i.Data.Key.Flags = flags; return i;
  }
  public static void ControlKey(IntPtr window, ushort key) {
    Send(window,new INPUT[] { Key(17,0,0), Key(key,0,0), Key(key,0,2), Key(17,0,2) });
  }
  public static void End(IntPtr window) {
    Send(window,new INPUT[] { Key(35,0,1), Key(35,0,3) });
  }
  public static string Patch(Bitmap bitmap,int x,int y,int width,int height) {
    byte[] data = new byte[width*height*4];
    for (int row=0;row<height;row++) for (int col=0;col<width;col++) {
      int pixel=bitmap.GetPixel(x+col,y+row).ToArgb();
      int offset=(row*width+col)*4;
      for (int channel=0;channel<4;channel++) data[offset+channel]=(byte)(pixel >> (channel*8));
    }
    using (SHA256 sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant();
  }
}
"@
$null = [MuseNativeExport]::SetThreadDpiAwarenessContext([IntPtr](-4))
$clock = [Diagnostics.Stopwatch]::StartNew()

function Get-MuseExportWindow([IntPtr]$ExpectedHandle = [IntPtr]::Zero) {
  $handle = [MuseNativeExport]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero -or ($ExpectedHandle -ne [IntPtr]::Zero -and $handle -ne $ExpectedHandle)) {
    throw 'The foreground Jianying window changed'
  }
  [uint32]$owner = 0
  [void][MuseNativeExport]::GetWindowThreadProcessId($handle,[ref]$owner)
  $process = Get-Process -Id $owner
  if ($process.ProcessName -ine 'JianyingPro' -or [IO.Path]::GetFileName($process.Path) -ine 'JianyingPro.exe' -or
      [Diagnostics.FileVersionInfo]::GetVersionInfo($process.Path).FileVersion -cne '11.7.0.14652') {
    throw 'Open the selected draft in the supported foreground Jianying 11.7 editor'
  }
  $element = [Windows.Automation.AutomationElement]::FromHandle($handle)
  if ($element.Current.ProcessId -ne $owner -or $element.Current.IsOffscreen) { throw 'Cannot verify Jianying window identity' }
  $bounds = New-Object MuseNativeExport+RECT
  if (-not [MuseNativeExport]::GetWindowRect($handle,[ref]$bounds) -or [MuseNativeExport]::GetDpiForWindow($handle) -ne 96) {
    throw 'Jianying does not match the supported screen scale'
  }
  @{
    Handle=$handle; ProcessId=$owner; Id=$element.Current.AutomationId; Title=$element.Current.Name;
    Left=$bounds.Left; Top=$bounds.Top; Width=$bounds.Right-$bounds.Left; Height=$bounds.Bottom-$bounds.Top
  }
}

function Assert-MuseRegisteredDraft {
  $draftRoot = Join-Path $env:LOCALAPPDATA 'JianyingPro\User Data\Projects\com.lveditor.draft'
  $index = Join-Path $draftRoot 'root_meta_info.json'
  $expected = [IO.Path]::GetFullPath($DraftPath).TrimEnd('\')
  $registry = Get-Content -LiteralPath $index -Raw -Encoding UTF8 | ConvertFrom-Json
  $rows = @($registry.all_draft_store | Where-Object { $_.draft_name -ceq $DraftName })
  if ($rows.Count -ne 1 -or [string]::IsNullOrWhiteSpace($rows[0].draft_id) -or
      [string]::IsNullOrWhiteSpace($rows[0].draft_fold_path) -or
      [IO.Path]::GetFullPath($rows[0].draft_fold_path).TrimEnd('\') -ine $expected) {
    throw 'The exact saved draft is not registered in the local Jianying Home index'
  }
}

function Get-MuseOwnedExportModal([IntPtr]$EditorHandle,[uint32]$EditorPid) {
  $popup = [MuseNativeExport]::GetLastActivePopup($EditorHandle)
  if ($popup -eq [IntPtr]::Zero -or $popup -eq $EditorHandle -or [MuseNativeExport]::GetWindow($popup,4) -ne $EditorHandle) {
    return
  }
  $node = [Windows.Automation.AutomationElement]::FromHandle($popup).Current
  if ($node.ProcessId -eq $EditorPid -and -not $node.IsOffscreen -and $node.AutomationId -ceq 'ExportWindow_Container') {
    @{Handle=$popup; Id=$node.AutomationId; Title=$node.Name}
  }
}

function Select-MuseForegroundCandidate {
  $root = [Windows.Automation.AutomationElement]::RootElement
  $roots = $root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  $locked = Test-Path -LiteralPath (Join-Path $DraftPath '.locked') -PathType Leaf
  $candidates = @(
    foreach ($candidate in $roots) {
      $current = $candidate.Current
      if ($current.IsOffscreen -or $current.NativeWindowHandle -eq 0) { continue }
      $editor = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
      if ($null -eq $editor -or $editor.ProcessName -ine 'JianyingPro' -or
          [IO.Path]::GetFileName($editor.Path) -ine 'JianyingPro.exe' -or
          [Diagnostics.FileVersionInfo]::GetVersionInfo($editor.Path).FileVersion -cne '11.7.0.14652') { continue }
      if ($current.AutomationId -ceq 'MainWindow') {
        $popup = Get-MuseOwnedExportModal ([IntPtr]$current.NativeWindowHandle) $current.ProcessId
        if ($null -ne $popup) {
          if ($popup.Title -ceq ('导出-'+$DraftName)) { $popup }
          continue
        }
      }
      if (($current.AutomationId -ceq 'ExportWindow_Container' -and $current.Name -ceq ('导出-'+$DraftName)) -or
          ($locked -and $current.AutomationId -ceq 'MainWindow' -and $current.Name -ceq '剪映专业版') -or
          (-not $locked -and $current.AutomationId -ceq 'HomeWindow')) {
        @{Handle=[IntPtr]$current.NativeWindowHandle; Id=$current.AutomationId}
      }
    }
  )
  $modals = @($candidates | Where-Object { $_.Id -ceq 'ExportWindow_Container' } | Group-Object Handle | ForEach-Object { $_.Group[0] })
  if ($modals.Count -eq 1) { return $modals[0] }
  if ($modals.Count -eq 0 -and $candidates.Count -eq 1) { return $candidates[0] }
}

function Get-MuseWindowImage($Window) {
  $now = Get-MuseExportWindow $Window.Handle
  if ($now.Left -ne $Window.Left -or $now.Top -ne $Window.Top -or $now.Width -ne $Window.Width -or $now.Height -ne $Window.Height) {
    throw 'Jianying window moved during verification'
  }
  $bitmap = New-Object Drawing.Bitmap($now.Width,$now.Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($now.Left,$now.Top,0,0,$bitmap.Size,[Drawing.CopyPixelOperation]::SourceCopy)
    if ([MuseNativeExport]::GetForegroundWindow() -ne $Window.Handle) { throw 'Jianying focus changed during verification' }
    return $bitmap
  } catch {
    $bitmap.Dispose()
    throw
  } finally { $graphics.Dispose() }
}

function Assert-MusePatches($Bitmap,$Patches) {
  foreach ($patch in $Patches) {
    $actual = [MuseNativeExport]::Patch($Bitmap,$patch.X,$patch.Y,$patch.Width,$patch.Height)
    if ($actual -cne $patch.Digest) { throw ('Cannot verify Jianying export option: ' + $patch.Name) }
  }
}

function New-MusePatch($Name,$X,$Y,$Width,$Height,$Digest) {
  @{Name=$Name; X=$X; Y=$Y; Width=$Width; Height=$Height; Digest=$Digest}
}

$editorPatches = @(
  (New-MusePatch 'editor export button' 1304 3 63 30 'ca4894523e553b9474068edb31ce6fa46abd407a2564afd6b6f4b5b748b0eacf')
  (New-MusePatch 'editor draft properties' 1028 43 79 27 '647d85f4d6597b06b349476db4b7a4686808ace62faf89ee800229c75de18e8b')
  (New-MusePatch 'editor draft name label' 1027 92 78 21 '5d4c80eaeee98b300f9f14641d46c0f47caf7acc54b68e6c6f21ae724be5cddf')
)
$completionPatches = @(
  (New-MusePatch 'export completed banner' 291 67 268 23 '5dec44fb17ced9e4f60d14f39fa3d9f269717c93a3d623c936db98bd2d4391ad')
  (New-MusePatch 'completion close button' 550 375 78 29 '1a2a57c42910f204a7db3eac975f4e37c09533b249235bb017b31cb0fac3f9d9')
  (New-MusePatch 'completion footer separator' 277 358 352 7 '5cff37cc9830e64668f622bcad87c645bb654b3803a7c0e21946373b1abd34de')
)
$titlePatch = New-MusePatch 'title edit field' 445 88 9 26 '9eaa9042fca17ea7d036749ef802ed00fbf5549cfcd557c8fa4386923c26150c'
$folderPatch = New-MusePatch 'folder picker' 596 124 26 28 '213aaf158086c4592ebfc05853cd8a54a51cb8daea07c814bb400fb865c69fbd'
$modalPatches = @(
  (New-MusePatch 'title label' 355 88 63 25 'ae858fa42302384d9c1dc9d504fd6b7030391ec3a0e37bbb10c879ea0e3808f0')
  (New-MusePatch 'video export selected' 356 182 86 23 'db83ae7f0857ccfcdff875b91a980d70fa72276994c71b74f7a4bdc6e5777f35')
  (New-MusePatch 'enhancement off' 356 215 274 31 '35c6281447b03cb7c6398e8285cfd04ca869a5d880f3b5c3d1e98749ceb73b34')
  (New-MusePatch 'original resolution' 356 251 274 25 'da0999ede1b1f107df4a9a10bb3a6a1a3dec4837f7743163c38f5951c9338df3')
  (New-MusePatch 'MP4 format' 355 325 275 27 'e63ff84abfc14f1a2b8ca631af65ebece768e683ec00582dcc42735f4f9320a0')
  (New-MusePatch '30 fps' 355 364 275 27 '03ff8444988263635a3e63c7d9e63266e9a603284b62150e02cf42a83c6e2dac')
  (New-MusePatch 'AI frame interpolation off' 355 400 275 30 'bca2bd6b1c7cb301f362665b98153d4c6759b8937f9a004f72e1a923c809ec74')
  (New-MusePatch 'cloud backup off' 355 495 159 29 'df6eb6c349f55a021c7ed7c2df3a7c85bd7d7eca357b73f4df82aeeadd387dde')
  (New-MusePatch 'separate audio export off' 355 549 90 27 '4c6e698e1afdefc96857dd85266070178fe381a714abc8c29a92bea39bc8f70e')
  (New-MusePatch 'local export button' 468 679 79 30 '4e9ce98a37f67d2be1dafa7231c12037f07e75d8e8b78a261fd997bcba0b4bc3')
)

function Assert-MuseModal($Window) {
  $now = Get-MuseExportWindow $Window.Handle
  if ($now.Id -cne 'ExportWindow_Container' -or $now.Title -cne ('导出-'+$DraftName) -or
      $now.ProcessId -ne $Window.ProcessId -or $now.Width -ne 640 -or $now.Height -ne 720) {
    throw 'The export dialog does not match the exact selected Jianying draft'
  }
}

function Assert-MuseModalPatches($Window,$Additional) {
  $settleDeadline = [Math]::Min($TimeoutMs,$clock.ElapsedMilliseconds+3000)
  $matched = 0
  $lastError = 'The native export dialog did not settle'
  do {
    Assert-MuseModal $Window
    $bitmap = Get-MuseWindowImage $Window
    try {
      Assert-MusePatches $bitmap ($modalPatches + $Additional)
      $matched++
      if ($matched -eq 2) { return }
    } catch {
      $lastError = $_.Exception.Message
      $matched = 0
    } finally { $bitmap.Dispose() }
    Start-Sleep -Milliseconds 150
  } while ($clock.ElapsedMilliseconds -lt $settleDeadline)
  throw $lastError
}

function Invoke-MuseWindowClick($Window,[int]$X,[int]$Y) {
  $now = Get-MuseExportWindow $Window.Handle
  if ($now.ProcessId -ne $Window.ProcessId -or $now.Id -cne $Window.Id -or $now.Title -cne $Window.Title -or
      $now.Left -ne $Window.Left -or $now.Top -ne $Window.Top -or $now.Width -ne $Window.Width -or $now.Height -ne $Window.Height) {
    throw 'Jianying window identity changed before input'
  }
  [MuseNativeExport]::Click($Window.Handle,$Window.Left+$X,$Window.Top+$Y)
}

if ($DraftName -notmatch '^[a-zA-Z0-9_-]{1,120}$' -or
    -not [IO.Path]::IsPathRooted($DraftPath) -or [IO.Path]::GetFileName($DraftPath) -cne $DraftName -or
    -not [IO.Path]::IsPathRooted($OutputPath) -or [IO.Path]::GetFileName($OutputPath) -notmatch '^[a-zA-Z0-9_-]{1,120}\.mp4$') {
  throw 'Invalid native export request'
}
$directory = [IO.Path]::GetDirectoryName($OutputPath)
if (-not [IO.Directory]::Exists($directory) -or (Test-Path -LiteralPath $OutputPath)) { throw 'Select a new MP4 in an existing directory' }
$switchDeadline = [Math]::Min($TimeoutMs,10000)
$attemptedActivation = $false
do {
  $foregroundHandle = [MuseNativeExport]::GetForegroundWindow()
  [uint32]$foregroundOwner = 0
  [void][MuseNativeExport]::GetWindowThreadProcessId($foregroundHandle,[ref]$foregroundOwner)
  $foregroundProcess = Get-Process -Id $foregroundOwner -ErrorAction SilentlyContinue
  if ($null -ne $foregroundProcess -and $foregroundProcess.ProcessName -ieq 'JianyingPro') { break }
  if ($OwnerPid -ne 0 -and $foregroundOwner -eq $OwnerPid -and -not $attemptedActivation) {
    $attemptedActivation = $true
    $candidate = Select-MuseForegroundCandidate
    if ($null -ne $candidate) { [void][MuseNativeExport]::Activate($candidate.Handle,$OwnerPid) }
  }
  Start-Sleep -Milliseconds 150
} while ($clock.ElapsedMilliseconds -lt $switchDeadline)
$window = Get-MuseExportWindow
if ($window.Id -ceq 'ExportWindow_Container' -and $window.Title -ceq ('导出-'+$DraftName) -and
    $window.Width -eq 640 -and $window.Height -eq 415) {
  $image = Get-MuseWindowImage $window
  try { Assert-MusePatches $image $completionPatches } finally { $image.Dispose() }
  $completedPid = $window.ProcessId
  Invoke-MuseWindowClick $window 588 389
  $closeDeadline = [Math]::Min($TimeoutMs,$clock.ElapsedMilliseconds+3000)
  do {
    Start-Sleep -Milliseconds 150
    $window = Get-MuseExportWindow
    if ($window.ProcessId -ne $completedPid) { throw 'Jianying process changed while closing the previous export' }
  } while ($window.Id -ceq 'ExportWindow_Container' -and $clock.ElapsedMilliseconds -lt $closeDeadline)
  if ($window.Id -cne 'MainWindow') { throw 'Jianying did not return to the editor after closing the previous export' }
}
if ($window.Id -cne 'ExportWindow_Container') {
  if (-not (Test-Path -LiteralPath (Join-Path $DraftPath '.locked') -PathType Leaf)) {
    $remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
    if ($remaining -le 0) { throw 'Jianying draft open deadline elapsed' }
    Assert-MuseRegisteredDraft
    $editor = Open-MuseJianyingDraft $DraftName $remaining
    $window = Get-MuseExportWindow $editor.Handle
    $draftLock = Join-Path $DraftPath '.locked'
    $lockDeadline = [Math]::Min($TimeoutMs,$clock.ElapsedMilliseconds+2000)
    while (-not (Test-Path -LiteralPath $draftLock -PathType Leaf) -and $clock.ElapsedMilliseconds -lt $lockDeadline) {
      Start-Sleep -Milliseconds 100
      $window = Get-MuseExportWindow $editor.Handle
    }
    if (-not (Test-Path -LiteralPath $draftLock -PathType Leaf) -or $window.ProcessId -ne $editor.ProcessId) {
      throw 'The selected Jianying draft did not acquire its editor lock'
    }
  }
  if ($window.Id -cne 'MainWindow' -or $window.Title -cne '剪映专业版' -or $window.Width -ne 1469 -or $window.Height -ne 768) {
    throw 'The active editor is not the supported Jianying layout'
  }
  $editorPid = $window.ProcessId
  $editorHandle = $window.Handle
  $settleDeadline = [Math]::Min($TimeoutMs,$clock.ElapsedMilliseconds+3000)
  $matches = 0
  $lastError = 'The native editor did not settle'
  do {
    $window = Get-MuseExportWindow
    if ($window.ProcessId -ne $editorPid) { throw 'Jianying process changed while opening export' }
    if ($window.Id -ceq 'ExportWindow_Container') { break }
    if ($window.Handle -ne $editorHandle) { throw 'Jianying editor changed while opening export' }
    $popup = Get-MuseOwnedExportModal $editorHandle $editorPid
    if ($null -ne $popup) {
      if ($popup.Title -cne ('导出-'+$DraftName)) { throw 'A different Jianying draft export dialog is open' }
      [void][MuseNativeExport]::Activate($popup.Handle,$editorPid)
    } else {
      $image = Get-MuseWindowImage $window
      try {
        Assert-MusePatches $image $editorPatches
        $matches++
      } catch {
        $lastError = $_.Exception.Message
        $matches = 0
      } finally { $image.Dispose() }
      if ($matches -eq 2) {
        Invoke-MuseWindowClick $window 1336 18
        break
      }
    }
    Start-Sleep -Milliseconds 150
  } while ($clock.ElapsedMilliseconds -lt $settleDeadline)
  if ($window.Id -cne 'ExportWindow_Container' -and $matches -ne 2) { throw $lastError }
  $openDeadline = [Math]::Min($TimeoutMs,$clock.ElapsedMilliseconds+3000)
  while ($window.Id -cne 'ExportWindow_Container' -and $clock.ElapsedMilliseconds -lt $openDeadline) {
    Start-Sleep -Milliseconds 100
    $window = Get-MuseExportWindow
    if ($window.ProcessId -ne $editorPid) { throw 'Jianying process changed while opening export' }
  }

}
Assert-MuseModalPatches $window @($folderPatch,$titlePatch)
Invoke-MuseWindowClick $window 609 138
$remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
if ($remaining -le 0) { throw 'Jianying folder selection deadline elapsed' }
$selected = Select-MuseJianyingExportFolder $window.Handle $window.ProcessId $directory $remaining
if ([IO.Path]::GetFullPath($selected).TrimEnd('\') -ine [IO.Path]::GetFullPath($directory).TrimEnd('\')) {
  throw 'Native picker did not select the exact requested directory'
}
function Confirm-MuseExportTitle($Window,[string]$Title,[switch]$Write) {
  Assert-MuseModalPatches $Window @($titlePatch)
  $clipboard = [Windows.Forms.Clipboard]::GetDataObject()
  $sentinel = 'Muse-export-check-' + [Guid]::NewGuid().ToString('N')
  $copied = $null
  try {
    [Windows.Forms.Clipboard]::SetText($sentinel)
    Invoke-MuseWindowClick $Window 535 101
    Start-Sleep -Milliseconds 150
    [MuseNativeExport]::ControlKey($Window.Handle,65)
    Start-Sleep -Milliseconds 100
    if ($Write) {
      [Windows.Forms.Clipboard]::SetText($Title)
      [MuseNativeExport]::ControlKey($Window.Handle,86)
      Start-Sleep -Milliseconds 350
      [Windows.Forms.Clipboard]::SetText($sentinel)
      [MuseNativeExport]::ControlKey($Window.Handle,65)
      Start-Sleep -Milliseconds 120
    }
    [MuseNativeExport]::ControlKey($Window.Handle,67)
    $copyDeadline = [Math]::Min($TimeoutMs,$clock.ElapsedMilliseconds+1600)
    do {
      Start-Sleep -Milliseconds 100
      Assert-MuseModal $Window
      $copied = [Windows.Forms.Clipboard]::GetText()
      if ($copied -ceq $Title) { break }
    } while ($clock.ElapsedMilliseconds -lt $copyDeadline)
    if ($copied -cne $Title) {
      $phase = if ($Write) { 'write' } else { 'confirm' }
      if ($copied -ceq $sentinel) { throw "Jianying output name $phase did not return a clipboard value" }
      $mismatch = 0
      $length = [Math]::Min($copied.Length,$Title.Length)
      while ($mismatch -lt $length -and $copied[$mismatch] -ceq $Title[$mismatch]) { $mismatch++ }
      throw "Jianying output name $phase mismatch (expected length $($Title.Length), read length $($copied.Length), first difference $mismatch)"
    }
    [MuseNativeExport]::End($Window.Handle)
  } finally {
    if ([Windows.Forms.Clipboard]::GetText() -cin @($sentinel,$Title,$copied)) {
      if ($null -eq $clipboard) { [Windows.Forms.Clipboard]::Clear() }
      else { [Windows.Forms.Clipboard]::SetDataObject($clipboard,$true) }
    }
  }
}

$title = [IO.Path]::GetFileNameWithoutExtension($OutputPath)
Confirm-MuseExportTitle $window $title -Write
Assert-MuseModalPatches $window @($folderPatch)
Invoke-MuseWindowClick $window 609 138
$remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
if ($remaining -le 0) { throw 'Jianying folder verification deadline elapsed' }
$confirmed = Confirm-MuseJianyingExportFolder $window.Handle $window.ProcessId $directory $remaining
if ([IO.Path]::GetFullPath($confirmed).TrimEnd('\') -ine [IO.Path]::GetFullPath($directory).TrimEnd('\')) {
  throw 'Jianying changed the committed export directory'
}
Confirm-MuseExportTitle $window $title
Assert-MuseModalPatches $window @()
if ($clock.ElapsedMilliseconds -ge $TimeoutMs -or (Test-Path -LiteralPath $OutputPath)) {
  throw 'The output path is no longer available or the deadline elapsed'
}
Invoke-MuseWindowClick $window 508 693

$lastLength = -1L
$lastWrite = 0L
$stableSince = 0L
while ($clock.ElapsedMilliseconds -lt $TimeoutMs) {
  Start-Sleep -Milliseconds 250
  if (-not [IO.File]::Exists($OutputPath)) { continue }
  try { $file = [IO.File]::Open($OutputPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None) }
  catch [IO.IOException] { $lastLength = -1L; continue }
  try {
    $size = $file.Length
    $modified = [IO.File]::GetLastWriteTimeUtc($OutputPath).Ticks
    if ($size -gt 0 -and $size -eq $lastLength -and $modified -eq $lastWrite) {
      if ($clock.ElapsedMilliseconds - $stableSince -ge 1500) {
        [Console]::WriteLine('NATIVE_EXPORT_COMPLETE')
        exit 0
      }
    } else {
      $lastLength = $size; $lastWrite = $modified; $stableSince = $clock.ElapsedMilliseconds
    }
  } finally { $file.Dispose() }
}
throw 'Jianying did not finish the requested export before the deadline'
