$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $projectRoot 'manifest.json'
$packagePath = Join-Path $projectRoot 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json

if ($manifest.version -ne $package.version) {
  throw "Version mismatch: manifest=$($manifest.version), package=$($package.version)"
}

$textTargets = @(
  (Join-Path $projectRoot 'src'),
  (Join-Path $projectRoot 'dist'),
  (Join-Path $projectRoot 'tests'),
  (Join-Path $projectRoot 'README.md'),
  (Join-Path $projectRoot 'CHANGELOG.md'),
  (Join-Path $projectRoot 'CONTRIBUTING.md'),
  (Join-Path $projectRoot 'SECURITY.md'),
  $manifestPath,
  $packagePath
)
$textFiles = foreach ($target in $textTargets) {
  if ((Get-Item -LiteralPath $target).PSIsContainer) {
    Get-ChildItem -LiteralPath $target -Recurse -File
  }
  else {
    Get-Item -LiteralPath $target
  }
}
$nonEnglishPattern = '[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|zh-CN'
$nonEnglishMatches = @()
foreach ($file in $textFiles) {
  $matches = Select-String -LiteralPath $file.FullName -Pattern $nonEnglishPattern
  if ($matches) {
    $nonEnglishMatches += $matches
  }
}
if ($nonEnglishMatches.Count -gt 0) {
  $nonEnglishMatches | ForEach-Object { Write-Output $_ }
  throw 'Chinese interface text or a Chinese locale remains in the public source or build output.'
}

$releaseRoot = Join-Path $projectRoot 'release'
$zipName = "Trading-212-Sync-$($manifest.version).zip"
$zipPath = Join-Path $releaseRoot $zipName
$checksumPath = Join-Path $releaseRoot 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $zipPath)) {
  throw "Release ZIP is missing: $zipPath"
}
if (-not (Test-Path -LiteralPath $checksumPath)) {
  throw "Checksum file is missing: $checksumPath"
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $actualEntries = @($archive.Entries.FullName | Sort-Object)
  $expectedEntries = @('LICENSE', 'README.md', 'dist/addon.js', 'manifest.json') | Sort-Object
  $entryDifference = Compare-Object -ReferenceObject $expectedEntries -DifferenceObject $actualEntries
  if ($entryDifference) {
    $entryDifference | ForEach-Object { Write-Output $_ }
    throw 'The release ZIP contains an unexpected file set.'
  }

  $zipManifestEntry = $archive.GetEntry('manifest.json')
  $reader = New-Object System.IO.StreamReader($zipManifestEntry.Open())
  try {
    $zipManifest = $reader.ReadToEnd() | ConvertFrom-Json
  }
  finally {
    $reader.Dispose()
  }
  if ($zipManifest.version -ne $manifest.version) {
    throw "ZIP manifest version mismatch: zip=$($zipManifest.version), source=$($manifest.version)"
  }
}
finally {
  $archive.Dispose()
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$hashStream = [System.IO.File]::OpenRead($zipPath)
try {
  $hashBytes = $sha256.ComputeHash($hashStream)
}
finally {
  $hashStream.Dispose()
  $sha256.Dispose()
}
$actualHash = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
$expectedChecksumLine = "$actualHash  $zipName"
$actualChecksumLine = (Get-Content -LiteralPath $checksumPath -Raw -Encoding ASCII).Trim()
if ($actualChecksumLine -ne $expectedChecksumLine) {
  throw 'SHA256SUMS.txt does not match the release ZIP.'
}

Write-Output "Verified release $($manifest.version)"
Write-Output "SHA256 $actualHash"
Write-Output "Entries $($expectedEntries -join ', ')"
