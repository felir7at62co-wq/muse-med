# ocr_bridge.ps1 — 用 Windows 内置 OCR 识别截图，输出 JSON（零外部依赖）
#
#   powershell -File ocr_bridge.ps1 -Image in.png -Out out.json [-Lang zh-Hans-CN]
#
# 输出 JSON:
#   { ok, lang, imageSize:[w,h], count, lines:[ {text,x,y,w,h,cx,cy,words:[...]} ] }
# 坐标是相对传入图片左上角的像素坐标（调用方负责裁剪与偏移换算）。

param(
    [Parameter(Mandatory=$true)][string]$Image,
    [Parameter(Mandatory=$true)][string]$Out,
    [string]$Lang = "zh-Hans-CN"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# ---- WinRT 异步 -> 同步 ----
$script:AsTaskGeneric = $null
$m = [System.WindowsRuntimeSystemExtensions].GetMethods()
foreach ($x in $m) {
    if ($x.Name -ne 'AsTask') { continue }
    $ps = $x.GetParameters()
    if ($ps.Count -ne 1) { continue }
    if ($ps[0].ParameterType.Name -like 'IAsyncOperation*') { $script:AsTaskGeneric = $x; break }
}

function Await($op, $type) {
    $g = $script:AsTaskGeneric.MakeGenericMethod($type)
    $t = $g.Invoke($null, @($op))
    [void]$t.Wait(-1)
    return $t.Result
}

$result = [ordered]@{ ok = $false; lang = $Lang; lines = @() }

try {
    [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    [void][Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]

    $sfOp    = [Windows.Storage.StorageFile]::GetFileFromPathAsync($Image)
    $file    = Await $sfOp ([Windows.Storage.StorageFile])
    $stOp    = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
    $stream  = Await $stOp ([Windows.Storage.Streams.IRandomAccessStream])
    $dcOp    = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
    $decoder = Await $dcOp ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmOp    = $decoder.GetSoftwareBitmapAsync()
    $bitmap  = Await $bmOp ([Windows.Graphics.Imaging.SoftwareBitmap])

    $langObj = New-Object Windows.Globalization.Language($Lang)
    $engine  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
    if ($engine -eq $null) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }

    if ($engine -eq $null) {
        $result.error = "no OCR engine available for $Lang"
    } else {
        $ocrOp = $engine.RecognizeAsync($bitmap)
        $ocr   = Await $ocrOp ([Windows.Media.Ocr.OcrResult])
        $all   = New-Object System.Collections.ArrayList

        foreach ($ln in $ocr.Lines) {
            $wlist = New-Object System.Collections.ArrayList
            $minX = [double]::MaxValue; $minY = [double]::MaxValue
            $maxX = [double]::MinValue; $maxY = [double]::MinValue
            foreach ($wd in $ln.Words) {
                $r = $wd.BoundingRect
                $o = [ordered]@{
                    text = $wd.Text
                    x = [int]$r.X; y = [int]$r.Y
                    w = [int]$r.Width; h = [int]$r.Height
                    cx = [int]($r.X + $r.Width / 2); cy = [int]($r.Y + $r.Height / 2)
                }
                [void]$wlist.Add([pscustomobject]$o)
                if ($r.X -lt $minX) { $minX = $r.X }
                if ($r.Y -lt $minY) { $minY = $r.Y }
                if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
                if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
            }
            if ($wlist.Count -gt 0) {
                $lo = [ordered]@{
                    text = $ln.Text
                    x = [int]$minX; y = [int]$minY
                    w = [int]($maxX - $minX); h = [int]($maxY - $minY)
                    cx = [int](($minX + $maxX) / 2); cy = [int](($minY + $maxY) / 2)
                    words = $wlist
                }
                [void]$all.Add([pscustomobject]$lo)
            }
        }
        $result.lines = $all
        $result.count = $all.Count
        $result.imageSize = @([int]$decoder.PixelWidth, [int]$decoder.PixelHeight)
        $result.ok = $true
    }
} catch {
    $result.error = $_.Exception.Message
}

$json = $result | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
