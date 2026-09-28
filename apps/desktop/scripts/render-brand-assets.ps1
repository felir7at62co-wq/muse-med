<#
Render every product brand image from the product icon: the installer's brand images, the
uninstaller sidebar, and the welcome page's mark.

`prepare-windows-installer.ps1` converts the installer PNGs to the BMPs the NSIS window helper
draws, so installation pages present the product's own mark instead of an upstream brand. Run
this after `renderer/icon.png` changes:

  pwsh -NoProfile -File apps/desktop/scripts/render-brand-assets.ps1
#>
[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '../installer/assets'),
  [string]$WelcomeDirectory = (Join-Path $PSScriptRoot '../renderer/assets')
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$background = [Drawing.Color]::FromArgb(23, 24, 26)
$light = [Drawing.Color]::FromArgb(244, 244, 245)
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $output | Out-Null
$icon = [Drawing.Bitmap]::FromFile([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../renderer/icon.png')))

<#
Coarse-scan the icon for its light artwork so a cropped mark fills the badge rather than
inheriting the icon's own margins.
#>
function Get-MarkRectangle([Drawing.Bitmap]$bitmap) {
  $minX = $bitmap.Width; $minY = $bitmap.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $bitmap.Height; $y += 4) {
    for ($x = 0; $x -lt $bitmap.Width; $x += 4) {
      $pixel = $bitmap.GetPixel($x, $y)
      if ($pixel.R -lt 96 -or $pixel.G -lt 96 -or $pixel.B -lt 96) { continue }
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
  if ($maxX -lt 0) { throw 'render-installer-brand: the product icon has no light artwork' }
  $size = [Math]::Max($maxX - $minX, $maxY - $minY) + 8
  $centreX = [int](($minX + $maxX) / 2); $centreY = [int](($minY + $maxY) / 2)
  $left = [Math]::Max(0, [Math]::Min($bitmap.Width - $size, $centreX - [int]($size / 2)))
  $top = [Math]::Max(0, [Math]::Min($bitmap.Height - $size, $centreY - [int]($size / 2)))
  return [Drawing.Rectangle]::new($left, $top, $size, $size)
}

function New-RoundedPath([Drawing.RectangleF]$rectangle, [single]$radius) {
  $path = [Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($rectangle.X, $rectangle.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($rectangle.Right - $diameter, $rectangle.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($rectangle.Right - $diameter, $rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rectangle.X, $rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-Mark([Drawing.Graphics]$graphics, [int]$scale, [single]$centreX, [single]$centreY, [single]$diameter, [bool]$dark) {
  # Soft halo: stacked low-alpha ellipses approximate the blur a real shadow would need.
  for ($step = 6; $step -ge 1; $step--) {
    $radius = $diameter / 2 + $step * $scale
    $brush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(6, 15, 17, 20))
    try { $graphics.FillEllipse($brush, $centreX - $radius, $centreY - $radius + 2 * $scale, $radius * 2, $radius * 2) }
    finally { $brush.Dispose() }
  }
  # Without a ring the dark-mode badge dissolves into the installer's own dark background.
  $ring = if ($dark) { [Drawing.Color]::FromArgb(38, 255, 255, 255) } else { [Drawing.Color]::FromArgb(20, 15, 17, 20) }
  $badge = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 23, 23, 23))
  $edge = [Drawing.Pen]::new($ring, [single](1.5 * $scale))
  try {
    $graphics.FillEllipse($badge, $centreX - $diameter / 2, $centreY - $diameter / 2, $diameter, $diameter)
    $graphics.DrawEllipse($edge, $centreX - $diameter / 2, $centreY - $diameter / 2, $diameter, $diameter)
  }
  finally { $badge.Dispose(); $edge.Dispose() }
  $mark = $diameter * 0.66
  $graphics.DrawImage($icon,
    [Drawing.RectangleF]::new([single]($centreX - $mark / 2), [single]($centreY - $mark / 2), [single]$mark, [single]$mark),
    $script:markRectangle, [Drawing.GraphicsUnit]::Pixel)
}

function Draw-Lockup([Drawing.Graphics]$graphics, [int]$scale, [bool]$dark, [single]$centreX, [single]$top) {
  $foreground = if ($dark) { $light } else { $background }
  $boxText = if ($dark) { $background } else { [Drawing.Color]::White }
  $font = [Drawing.Font]::new('Segoe UI Semibold', 31 * $scale, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
  $format = [Drawing.StringFormat]::GenericTypographic
  try {
    $name = $graphics.MeasureString('muse', $font, 4000, $format)
    $suffix = $graphics.MeasureString('MED', $font, 4000, $format)
    $padding = 7 * $scale; $gap = 4 * $scale
    $boxWidth = $suffix.Width + 2 * $padding
    $boxHeight = $suffix.Height - 5 * $scale
    $left = $centreX - ($name.Width + $gap + $boxWidth) / 2
    $nameBrush = [Drawing.SolidBrush]::new($foreground)
    $boxBrush = [Drawing.SolidBrush]::new($foreground)
    $textBrush = [Drawing.SolidBrush]::new($boxText)
    $path = New-RoundedPath ([Drawing.RectangleF]::new($left + $name.Width + $gap, $top + 3 * $scale, $boxWidth, $boxHeight)) (6 * $scale)
    try {
      $graphics.DrawString('muse', $font, $nameBrush, $left, $top, $format)
      $graphics.FillPath($boxBrush, $path)
      $graphics.DrawString('MED', $font, $textBrush, $left + $name.Width + $gap + $padding, $top, $format)
    }
    finally { $nameBrush.Dispose(); $boxBrush.Dispose(); $textBrush.Dispose(); $path.Dispose() }
  }
  finally { $font.Dispose() }
}

function New-BrandImage([int]$scale, [bool]$dark) {
  $bitmap = [Drawing.Bitmap]::new(600 * $scale, 196 * $scale, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    Draw-Mark $graphics $scale (300 * $scale) (80 * $scale) (122 * $scale) $dark
    Draw-Lockup $graphics $scale $dark (300 * $scale) (146 * $scale)
  }
  finally { $graphics.Dispose() }
  return $bitmap
}

function New-SidebarImage {
  $bitmap = [Drawing.Bitmap]::new(164, 314, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.Clear([Drawing.Color]::FromArgb(243, 244, 246))
    $tile = New-RoundedPath ([Drawing.RectangleF]::new(16, 62, 132, 132)) 18
    $fill = [Drawing.SolidBrush]::new([Drawing.Color]::White)
    $edge = [Drawing.Pen]::new([Drawing.Color]::FromArgb(229, 231, 235), 1)
    try {
      $graphics.FillPath($fill, $tile)
      $graphics.DrawPath($edge, $tile)
    }
    finally { $fill.Dispose(); $edge.Dispose(); $tile.Dispose() }
    Draw-Mark $graphics 1 82 128 104 $false
  }
  finally { $graphics.Dispose() }
  return $bitmap
}

function New-WelcomeMark([bool]$dark) {
  # Rendered at 4x the 33px badge the welcome lockup displays, so a HiDPI window stays crisp.
  $bitmap = [Drawing.Bitmap]::new(176, 176, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    Draw-Mark $graphics 4 88 86 136 $dark
  }
  finally { $graphics.Dispose() }
  return $bitmap
}

$script:markRectangle = Get-MarkRectangle $icon
$assets = @{
  'brand.png' = New-BrandImage 1 $false
  'brand-2x.png' = New-BrandImage 2 $false
  'brand-dark.png' = New-BrandImage 1 $true
  'brand-dark-2x.png' = New-BrandImage 2 $true
  'uninstaller-sidebar.png' = New-SidebarImage
}
foreach ($name in $assets.Keys) {
  $path = Join-Path $output $name
  $assets[$name].Save($path, [Drawing.Imaging.ImageFormat]::Png)
  $assets[$name].Dispose()
  "rendered $name  $((Get-Item $path).Length) bytes"
}

$welcome = [IO.Path]::GetFullPath($WelcomeDirectory)
New-Item -ItemType Directory -Force $welcome | Out-Null
$marks = @{ 'welcome-mark.png' = New-WelcomeMark $false; 'welcome-mark-dark.png' = New-WelcomeMark $true }
foreach ($name in $marks.Keys) {
  $path = Join-Path $welcome $name
  $marks[$name].Save($path, [Drawing.Imaging.ImageFormat]::Png)
  $marks[$name].Dispose()
  "rendered $name  $((Get-Item $path).Length) bytes"
}
$icon.Dispose()
