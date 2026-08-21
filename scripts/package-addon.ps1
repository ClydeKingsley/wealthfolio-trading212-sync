$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = Join-Path $projectRoot 'dist'
$manifestPath = Join-Path $projectRoot 'manifest.json'
$readmePath = Join-Path $projectRoot 'README.md'
$licensePath = Join-Path $projectRoot 'LICENSE'
$releaseRoot = Join-Path $projectRoot 'release'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$zipPath = Join-Path $releaseRoot "Trading-212-Sync-$($manifest.version).zip"

if (-not (Test-Path -LiteralPath (Join-Path $distRoot 'addon.js'))) {
  throw 'dist/addon.js is missing. Run pnpm build first.'
}

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

$fullZipPath = [System.IO.Path]::GetFullPath($zipPath)
$releasePrefix = [System.IO.Path]::GetFullPath($releaseRoot).TrimEnd('\') + '\'
if (-not $fullZipPath.StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to replace an unexpected path: $fullZipPath"
}
if (Test-Path -LiteralPath $fullZipPath) {
  Remove-Item -LiteralPath $fullZipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Add-ZipFile {
  param(
    [Parameter(Mandatory = $true)][System.IO.Compression.ZipArchive]$Archive,
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$EntryName
  )

  $entry = $Archive.CreateEntry($EntryName, [System.IO.Compression.CompressionLevel]::Optimal)
  $inputStream = [System.IO.File]::OpenRead($SourcePath)
  $outputStream = $entry.Open()
  try {
    $inputStream.CopyTo($outputStream)
  }
  finally {
    $outputStream.Dispose()
    $inputStream.Dispose()
  }
}

$zipStream = [System.IO.File]::Open(
  $fullZipPath,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::Write,
  [System.IO.FileShare]::None
)
$archive = New-Object System.IO.Compression.ZipArchive(
  $zipStream,
  [System.IO.Compression.ZipArchiveMode]::Create,
  $false
)
try {
  Add-ZipFile -Archive $archive -SourcePath $manifestPath -EntryName 'manifest.json'
  Add-ZipFile -Archive $archive -SourcePath $readmePath -EntryName 'README.md'
  Add-ZipFile -Archive $archive -SourcePath $licensePath -EntryName 'LICENSE'
  Add-ZipFile -Archive $archive -SourcePath (Join-Path $distRoot 'addon.js') -EntryName 'dist/addon.js'
}
finally {
  $archive.Dispose()
  $zipStream.Dispose()
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$hashStream = [System.IO.File]::OpenRead($fullZipPath)
try {
  $hashBytes = $sha256.ComputeHash($hashStream)
}
finally {
  $hashStream.Dispose()
  $sha256.Dispose()
}
$hash = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
$checksumPath = Join-Path $releaseRoot 'SHA256SUMS.txt'
Set-Content -LiteralPath $checksumPath -Value "$hash  $([System.IO.Path]::GetFileName($fullZipPath))" -Encoding ASCII

Write-Output $fullZipPath
Write-Output $checksumPath
