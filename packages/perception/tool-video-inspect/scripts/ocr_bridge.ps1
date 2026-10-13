param()

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Result([hashtable]$Value) {
  [Console]::Out.Write(($Value | ConvertTo-Json -Depth 12 -Compress))
}

function Convert-Box($Rect) {
  return [ordered]@{
    x = [double]$Rect.X
    y = [double]$Rect.Y
    width = [double]$Rect.Width
    height = [double]$Rect.Height
  }
}

function Await($Operation, $Type) {
  $generic = $script:AsTaskGeneric.MakeGenericMethod($Type)
  $task = $generic.Invoke($null, @($Operation))
  [void]$task.Wait(-1)
  return $task.Result
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:AsTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } |
    Select-Object -First 1
  if ($null -eq $script:AsTaskGeneric) { throw 'WinRT async bridge unavailable' }
  [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  $payloadText = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($payloadText)) {
    Write-Result @{ ok = $false; code = 'invalid_input' }
    exit 0
  }
  $payload = $payloadText | ConvertFrom-Json
  if ($null -eq $payload.frames -or $null -eq $payload.language) {
    Write-Result @{ ok = $false; code = 'invalid_input' }
    exit 0
  }

  $engine = $null
  if ([string]$payload.language -eq 'auto') {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  } else {
    $available = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
      Where-Object { $_.LanguageTag -eq [string]$payload.language } |
      Select-Object -First 1
    if ($null -eq $available) {
      Write-Result @{ ok = $false; code = 'language_unavailable' }
      exit 0
    }
    $language = [Windows.Globalization.Language]::new([string]$payload.language)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  }
  if ($null -eq $engine) {
    Write-Result @{ ok = $false; code = 'ocr_engine_unavailable' }
    exit 0
  }

  $results = @()
  foreach ($frame in $payload.frames) {
    try {
      $bytes = [Convert]::FromBase64String([string]$frame.image_base64)
      $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
      $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
      $writer.WriteBytes($bytes)
      [void](Await ($writer.StoreAsync()) ([UInt32]))
      [void](Await ($writer.FlushAsync()) ([Boolean]))
      [void]$writer.DetachStream()
      [void]$writer.Dispose()
      [void]$stream.Seek(0)

      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $recognized = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lines = @()
      foreach ($line in $recognized.Lines) {
        $words = @()
        foreach ($word in $line.Words) {
          $words += [ordered]@{ text = [string]$word.Text; bounding_box = Convert-Box $word.BoundingRect }
        }
        $lineRect = $line.Words | Select-Object -First 1
        if ($null -eq $lineRect) {
          $bounding = [ordered]@{ x = 0.0; y = 0.0; width = 0.0; height = 0.0 }
        } else {
          $left = ($line.Words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
          $top = ($line.Words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
          $right = ($line.Words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
          $bottom = ($line.Words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
          $bounding = [ordered]@{ x = [double]$left; y = [double]$top; width = [double]($right - $left); height = [double]($bottom - $top) }
        }
        $lines += [ordered]@{ text = [string]$line.Text; bounding_box = $bounding; words = $words }
      }
      $results += [ordered]@{
        id = [string]$frame.id
        timestamp_seconds = [double]$frame.timestamp_seconds
        image_width = [int]$bitmap.PixelWidth
        image_height = [int]$bitmap.PixelHeight
        lines = $lines
      }
      [void]$bitmap.Dispose()
      [void]$stream.Dispose()
    } catch {
      Write-Result @{ ok = $false; code = 'frame_decode_failed' }
      exit 0
    }
  }

  Write-Result @{
    ok = $true
    language_used = [string]$engine.RecognizerLanguage.LanguageTag
    frames = $results
  }
} catch {
  Write-Result @{ ok = $false; code = 'ocr_engine_unavailable' }
}
