$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$sourcePath = Join-Path $PSScriptRoot '..\assets\agent-cockpit_icon.png'
$outputPath = Join-Path $PSScriptRoot '..\assets\agent-cockpit_icon-64.png'
$source = $null
$bitmap = $null
$graphics = $null

try {
  $source = [System.Drawing.Image]::FromFile([System.IO.Path]::GetFullPath($sourcePath))
  $bitmap = New-Object System.Drawing.Bitmap(64, 64, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $scale = [Math]::Min(64.0 / $source.Width, 64.0 / $source.Height)
  $width = [single]($source.Width * $scale)
  $height = [single]($source.Height * $scale)
  $destination = New-Object System.Drawing.RectangleF(([single]((64 - $width) / 2)), ([single]((64 - $height) / 2)), $width, $height)
  $graphics.DrawImage($source, $destination)
  $bitmap.Save([System.IO.Path]::GetFullPath($outputPath), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
  if ($source) { $source.Dispose() }
}
