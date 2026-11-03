# Locate the exact visible draft on Jianying's home page before opening its editor.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms, System.Runtime.WindowsRuntime

if (-not ('MuseJianyingDraftWindow' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MuseJianyingDraftWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    public static bool ClickOwned(IntPtr expected, int x, int y) {
        var point = new Point { X = x, Y = y };
        if (GetForegroundWindow() != expected || GetAncestor(WindowFromPoint(point), 2) != expected) return false;
        if (!SetCursorPos(x, y) || GetForegroundWindow() != expected || GetAncestor(WindowFromPoint(point), 2) != expected) return false;
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        return true;
    }
}
"@
}

function Get-MuseJianyingWindows {
    $automation = [System.Windows.Automation.AutomationElement]
    $windows = $automation::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
        try {
            $current = $window.Current
            if ($current.IsOffscreen -or $current.NativeWindowHandle -eq 0 -or
                $current.ClassName -notmatch 'HomePage|MainWindow') { continue }
            $owner = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
            if ($null -eq $owner -or $owner.ProcessName -cne 'JianyingPro') { continue }
            [pscustomobject]@{
                Handle = [IntPtr]$current.NativeWindowHandle
                ProcessId = $current.ProcessId
                Kind = if ($current.ClassName -match 'HomePage') { 'Home' } else { 'Editor' }
                Element = $window
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            # A desktop window can disappear between enumeration and property access.
        }
    }
}

function Find-MuseJianyingDraftControl($homeWindow, [string]$DraftName) {
    $elements = $homeWindow.Element.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $description = [System.Windows.Automation.AutomationProperty]::LookupById(30159)
    $described = @()
    $named = @()
    foreach ($item in $elements) {
        try {
            $current = $item.Current
            if ($current.IsOffscreen -or $current.BoundingRectangle.IsEmpty) { continue }
            if ($null -ne $description -and
                $item.GetCurrentPropertyValue($description, $true) -ceq "HomePageDraftTitle:${DraftName}") {
                $described += $current.BoundingRectangle
            } elseif ($current.Name -ceq $DraftName -and
                $current.ControlType -eq [System.Windows.Automation.ControlType]::Text) {
                $named += $current.BoundingRectangle
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            # The draft grid can refresh while its descendants are enumerated.
        }
    }
    $matches = if ($described.Count -gt 0) { @($described) } else { @($named) }
    if (@($matches).Count -gt 1) { throw 'Several visible Jianying drafts have the exact selected title' }
    if (@($matches).Count -eq 1) {
        $rect = @($matches)[0]
        return [pscustomobject]@{ X = [int]($rect.X + $rect.Width / 2); Y = [int]($rect.Y + $rect.Height / 2) }
    }
}

function Wait-MuseJianyingOcr($Operation, $Type, $AsTask, [int]$TimeoutMs) {
    $task = $AsTask.MakeGenericMethod($Type).Invoke($null, @($Operation))
    if (-not $task.Wait($TimeoutMs)) { throw 'Windows OCR timed out while reading the Jianying home page' }
    return $task.Result
}

function Measure-MuseJianyingDraftPixels($Screen, $Background, [int]$Left, [int]$Right, [int]$Top, [int]$Bottom) {
    $count = 0
    for ($y = $Top; $y -lt $Bottom; $y += 5) {
        for ($x = $Left; $x -lt $Right; $x += 5) {
            $pixel = $Screen.GetPixel($x, $y)
            if (([Math]::Abs($pixel.R - $Background.R) + [Math]::Abs($pixel.G - $Background.G) +
                [Math]::Abs($pixel.B - $Background.B)) -gt 22) { $count++ }
        }
    }
    return $count
}

function Test-MuseJianyingSearchIcon($Screen) {
    $mask = @(
        '.........#......'
        '......#######...'
        '....###....###..'
        '....##.......##.'
        '...##.........#.'
        '...#..........##'
        '...#..........##'
        '..##.......#####'
    )
    $differences = 0
    for ($y = 0; $y -lt $mask.Count; $y++) {
        for ($x = 0; $x -lt $mask[$y].Length; $x++) {
            $pixel = $Screen.GetPixel(917 + $x, 321 + $y)
            $lit = $pixel.R -ge 95 -and $pixel.G -ge 95 -and $pixel.B -ge 95
            if ($lit -ne ($mask[$y][$x] -eq '#')) { $differences++ }
        }
    }
    return $differences -le 8
}

function Find-MuseJianyingDraftText($homeWindow, [string]$DraftName, [int]$TimeoutMs, [string]$Mode = 'Exact') {
    [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { throw 'Windows OCR is unavailable for locating the selected Jianying draft' }
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
    } | Select-Object -First 1

    $rect = New-Object MuseJianyingDraftWindow+Rect
    if ([MuseJianyingDraftWindow]::GetForegroundWindow() -ne $homeWindow.Handle -or
        -not [MuseJianyingDraftWindow]::GetWindowRect($homeWindow.Handle, [ref]$rect)) {
        throw 'The selected Jianying home page is no longer in the foreground'
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    $limit = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($width -lt 1 -or $height -lt 1 -or $width -gt $limit -or $height -gt $limit) {
        throw 'The Jianying home page size is unsupported for Windows OCR'
    }
    $screen = [System.Drawing.Bitmap]::new($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($screen)
    $bytes = [IO.MemoryStream]::new()
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
    $bitmap = $null
    try {
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
        $screen.Save($bytes, [System.Drawing.Imaging.ImageFormat]::Png)
        $writer.WriteBytes($bytes.ToArray())
        [void](Wait-MuseJianyingOcr ($writer.StoreAsync()) ([UInt32]) $asTask $TimeoutMs)
        [void](Wait-MuseJianyingOcr ($writer.FlushAsync()) ([Boolean]) $asTask $TimeoutMs)
        [void]$writer.DetachStream()
        $stream.Seek(0)
        $decoder = Wait-MuseJianyingOcr ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]) $asTask $TimeoutMs
        $bitmap = Wait-MuseJianyingOcr ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]) $asTask $TimeoutMs
        $result = Wait-MuseJianyingOcr ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]) $asTask $TimeoutMs
        if ($Mode -ne 'Exact') {
            $heading = -join (0x672C, 0x5730, 0x8349, 0x7A3F | ForEach-Object { [char]$_ })
            $headings = @($result.Lines | Where-Object { ($_.Text -replace '\s', '') -ceq $heading })
            if ($headings.Count -ne 1) { throw 'The local drafts section could not be identified' }
            $origin = ($headings[0].Words | Select-Object -First 1).BoundingRect
            $gridX = [int]$origin.X
            $headerY = [int]($origin.Y + $origin.Height / 2)
            if ($width -ne 1168 -or $height -ne 780 -or $gridX -lt 240 -or $gridX -gt 252 -or
                $headerY -lt 321 -or $headerY -gt 334) {
                throw 'The Jianying home layout has not been qualified for exact draft search'
            }
            if ($Mode -eq 'Search') {
                $x = 813
                $pixel = $screen.GetPixel($x, $headerY - 7)
                if ($pixel.R -le 12 -and $pixel.G -le 12 -and $pixel.B -le 12) {
                    return [pscustomobject]@{ X = $rect.Left + $x; Y = $rect.Top + $headerY; Collapsed = $false }
                }
                if (Test-MuseJianyingSearchIcon $screen) {
                    return [pscustomobject]@{ X = $rect.Left + 926; Y = $rect.Top + 329; Collapsed = $true }
                }
                throw 'The Jianying local draft search field is not visible'
            }
            $listTitle = @($result.Lines | Where-Object {
                $first = ($_.Words | Select-Object -First 1).BoundingRect
                $last = ($_.Words | Select-Object -Last 1).BoundingRect
                -not [string]::IsNullOrWhiteSpace($_.Text) -and
                    $first.X -ge $gridX + 50 -and $first.X -le $gridX + 78 -and
                    $first.Y -ge $headerY + 82 -and $first.Y -le $headerY + 105 -and
                    $last.X + $last.Width -le $gridX + 370
            })
            $background = $screen.GetPixel($width - 40, $height - 40)
            if ($listTitle.Count -gt 0) {
                # The Chinese OCR engine can misread Latin title characters. The
                # clipboard confirms the title, and the row must be isolated.
                $thumbnail = Measure-MuseJianyingDraftPixels $screen $background ($gridX + 3) ($gridX + 45) ($headerY + 75) ($headerY + 115)
                $below = Measure-MuseJianyingDraftPixels $screen $background ($gridX - 5) ($width - 36) ($headerY + 125) ($height - 25)
                if ($listTitle.Count -ne 1 -or $thumbnail -lt 32 -or $below -gt 25) { return }
                return [pscustomobject]@{ X = $rect.Left + $gridX + 18; Y = $rect.Top + $headerY + 94; DoubleClick = $true }
            }
            # Grid captions are truncated and sometimes missed by OCR. The exact search
            # and registered draft are checked separately from this single-card check.
            $inside = Measure-MuseJianyingDraftPixels $screen $background ($gridX + 5) ($gridX + 100) ($headerY + 32) ($headerY + 132)
            $right = Measure-MuseJianyingDraftPixels $screen $background ($gridX + 114) ($width - 36) ($headerY + 26) ($height - 25)
            $below = Measure-MuseJianyingDraftPixels $screen $background ($gridX - 5) ($gridX + 114) ($headerY + 179) ($height - 25)
            if ($inside -lt 100 -or $right -gt 35 -or $below -gt 25) { return }
            return [pscustomobject]@{ X = $rect.Left + $gridX + 48; Y = $rect.Top + $headerY + 82 }
        }
        $matches = @($result.Lines | Where-Object { $_.Text -ceq $DraftName })
        if ($matches.Count -gt 1) { throw 'Several visible Jianying titles match the selected draft' }
        if ($matches.Count -eq 1) {
            $first = ($matches[0].Words | Select-Object -First 1).BoundingRect
            $last = ($matches[0].Words | Select-Object -Last 1).BoundingRect
            return [pscustomobject]@{
                X = [int]($rect.Left + ($first.X + $last.X + $last.Width) / 2)
                Y = [int]($rect.Top + $first.Y + $first.Height / 2)
            }
        }
    } finally {
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        $writer.Dispose()
        $stream.Dispose()
        $bytes.Dispose()
        $graphics.Dispose()
        $screen.Dispose()
    }
}

function Send-MuseJianyingSearchKeys($homeWindow, [string]$Keys) {
    if ([MuseJianyingDraftWindow]::GetForegroundWindow() -ne $homeWindow.Handle) {
        throw 'The Jianying home page lost focus while confirming the draft search'
    }
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
}

function Confirm-MuseJianyingDraftSearch($homeWindow, $point, [string]$DraftName, [switch]$Write) {
    if ($DraftName -cnotmatch '^Supermuse-approved-[0-9]+-[a-f0-9]{16}-01$') {
        throw 'The selected draft does not have a supported Muse-generated name'
    }
    $previous = [System.Windows.Forms.Clipboard]::GetDataObject()
    $sentinel = 'Muse-draft-search-' + [guid]::NewGuid().ToString('N')
    if (-not [MuseJianyingDraftWindow]::ClickOwned($homeWindow.Handle, $point.X, $point.Y)) {
        throw 'The Jianying draft search field is no longer focused'
    }
    $ownedSequence = [MuseJianyingDraftWindow]::GetClipboardSequenceNumber()
    $changedClipboard = $false
    try {
        Start-Sleep -Milliseconds 150
        if ($Write) {
            Send-MuseJianyingSearchKeys $homeWindow '^a'
            Start-Sleep -Milliseconds 100
            [System.Windows.Forms.Clipboard]::SetText($DraftName)
            $ownedSequence = [MuseJianyingDraftWindow]::GetClipboardSequenceNumber()
            $changedClipboard = $true
            Send-MuseJianyingSearchKeys $homeWindow '^v'
            Start-Sleep -Milliseconds 350
        }
        [System.Windows.Forms.Clipboard]::SetText($sentinel)
        $ownedSequence = [MuseJianyingDraftWindow]::GetClipboardSequenceNumber()
        $changedClipboard = $true
        Send-MuseJianyingSearchKeys $homeWindow '^a'
        Start-Sleep -Milliseconds 120
        Send-MuseJianyingSearchKeys $homeWindow '^c'
        $until = [Diagnostics.Stopwatch]::StartNew()
        $copied = $sentinel
        do {
            Start-Sleep -Milliseconds 100
            if ([MuseJianyingDraftWindow]::GetForegroundWindow() -ne $homeWindow.Handle) {
                throw 'The Jianying home page lost focus before the draft search was confirmed'
            }
            $copied = [System.Windows.Forms.Clipboard]::GetText()
            if ($copied -cne $sentinel) {
                $ownedSequence = [MuseJianyingDraftWindow]::GetClipboardSequenceNumber()
                break
            }
        } while ($until.ElapsedMilliseconds -lt 1600)
        if ($copied -cne $DraftName) {
            if ($copied -ceq $sentinel) { throw 'The Jianying draft search did not return a clipboard value' }
            throw "The Jianying search did not confirm the complete draft name (expected length $($DraftName.Length), read length $($copied.Length))"
        }
        Send-MuseJianyingSearchKeys $homeWindow '{END}'
    } finally {
        if ($changedClipboard -and $ownedSequence -eq [MuseJianyingDraftWindow]::GetClipboardSequenceNumber()) {
            if ($null -eq $previous) { [System.Windows.Forms.Clipboard]::Clear() }
            else { [System.Windows.Forms.Clipboard]::SetDataObject($previous, $true, 3, 50) }
        }
    }
}
function Open-MuseJianyingDraft([string]$DraftName, [int]$TimeoutMs) {
    if ([string]::IsNullOrWhiteSpace($DraftName) -or $TimeoutMs -lt 1) { throw 'An exact draft name and positive timeout are required' }
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    $dpi = [MuseJianyingDraftWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
    try {
        $homeDeadline = [Math]::Min($TimeoutMs, 2000)
        do {
            $windows = @(Get-MuseJianyingWindows)
            if (@($windows | Where-Object Kind -eq 'Editor').Count -gt 0) {
                throw 'Return to the Jianying home page before opening the selected draft'
            }
            $homes = @($windows | Where-Object Kind -eq 'Home')
            if ($homes.Count -gt 1) { throw 'Exactly one visible Jianying home page is required' }
            if ($homes.Count -eq 1 -or $elapsed.ElapsedMilliseconds -ge $homeDeadline) { break }
            Start-Sleep -Milliseconds 100
        } while ($elapsed.ElapsedMilliseconds -lt $homeDeadline)
        if ($homes.Count -ne 1) { throw 'Exactly one visible Jianying home page is required' }
        $homeWindow = $homes[0]
        if ([MuseJianyingDraftWindow]::GetForegroundWindow() -ne $homeWindow.Handle) {
            [void][MuseJianyingDraftWindow]::SetForegroundWindow($homeWindow.Handle)
        }
        $point = Find-MuseJianyingDraftControl $homeWindow $DraftName
        if ($null -eq $point) {
            $point = Find-MuseJianyingDraftText $homeWindow $DraftName ([Math]::Max(1, $TimeoutMs - [int]$elapsed.ElapsedMilliseconds))
        }
        if ($null -eq $point) {
            $search = Find-MuseJianyingDraftText $homeWindow $DraftName ([Math]::Max(1, $TimeoutMs - [int]$elapsed.ElapsedMilliseconds)) 'Search'
            if ($elapsed.ElapsedMilliseconds -ge $TimeoutMs) { throw 'Jianying draft search timed out' }
            if ($search.Collapsed) {
                if (-not [MuseJianyingDraftWindow]::ClickOwned($homeWindow.Handle, $search.X, $search.Y)) {
                    throw 'The Jianying draft search button is no longer available'
                }
                $expandDeadline = [Math]::Min($TimeoutMs, $elapsed.ElapsedMilliseconds + 2000)
                do {
                    Start-Sleep -Milliseconds 150
                    $remaining = [int]($expandDeadline - $elapsed.ElapsedMilliseconds)
                    if ($remaining -le 0) { break }
                    $search = Find-MuseJianyingDraftText $homeWindow $DraftName $remaining 'Search'
                } while ($search.Collapsed)
                if ($search.Collapsed) { throw 'The Jianying draft search field did not expand' }
            }
            Confirm-MuseJianyingDraftSearch $homeWindow $search $DraftName -Write
            $tileDeadline = [Math]::Min($TimeoutMs, $elapsed.ElapsedMilliseconds + 10000)
            while ($elapsed.ElapsedMilliseconds -lt $tileDeadline) {
                $remaining = [int]($tileDeadline - $elapsed.ElapsedMilliseconds)
                $point = Find-MuseJianyingDraftText $homeWindow $DraftName ([Math]::Max(1, $remaining)) 'Tile'
                if ($null -ne $point) { break }
                Start-Sleep -Milliseconds 100
            }
            if ($null -eq $point) { throw 'The exact draft search did not show one isolated matching draft within 10 seconds' }
            Confirm-MuseJianyingDraftSearch $homeWindow $search $DraftName
            $confirmed = Find-MuseJianyingDraftText $homeWindow $DraftName ([Math]::Max(1, $TimeoutMs - [int]$elapsed.ElapsedMilliseconds)) 'Tile'
            if ($null -eq $confirmed -or $confirmed.X -ne $point.X -or $confirmed.Y -ne $point.Y -or
                $confirmed.DoubleClick -ne $point.DoubleClick) {
                throw 'The exact filtered draft changed before opening'
            }
        }
        if ($elapsed.ElapsedMilliseconds -ge $TimeoutMs -or
            -not [MuseJianyingDraftWindow]::ClickOwned($homeWindow.Handle, $point.X, $point.Y)) {
            throw 'The selected Jianying draft is no longer at the verified location'
        }
        if ($point.DoubleClick) {
            Start-Sleep -Milliseconds 70
            if ($elapsed.ElapsedMilliseconds -lt $TimeoutMs -and [MuseJianyingDraftWindow]::GetForegroundWindow() -eq $homeWindow.Handle) {
                if (-not [MuseJianyingDraftWindow]::ClickOwned($homeWindow.Handle, $point.X, $point.Y)) {
                    throw 'The selected Jianying list row changed before opening'
                }
            }
        }
        $editorDeadline = [Math]::Min($TimeoutMs, $elapsed.ElapsedMilliseconds + 8000)
        do {
            $editors = @(Get-MuseJianyingWindows | Where-Object Kind -eq 'Editor')
            if ($editors.Count -gt 1) { throw 'Several Jianying editors appeared after opening the selected draft' }
            if ($editors.Count -eq 1 -and $editors[0].Handle -eq [MuseJianyingDraftWindow]::GetForegroundWindow() -and
                $editors[0].ProcessId -eq $homeWindow.ProcessId) {
                return $editors[0]
            }
            Start-Sleep -Milliseconds 100
        } while ($elapsed.ElapsedMilliseconds -lt $editorDeadline)
        throw 'The editor for the selected Jianying draft did not become active within eight seconds'
    } finally {
        if ($dpi -ne [IntPtr]::Zero) { [void][MuseJianyingDraftWindow]::SetThreadDpiAwarenessContext($dpi) }
    }
}
