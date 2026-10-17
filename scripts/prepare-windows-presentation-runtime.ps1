# Provisions the bundled LibreOffice runtime for Windows PPTX->PDF conversion,
# mirroring scripts/download-presentation-runtime-macos.sh.
#
# Downloads a pinned LibreOffice Windows x64 archive from the release mirror,
# verifies its SHA256, and unpacks it into
#   apps/bridge/vendor/presentation-runtime/win-x64/
# so that <win-x64>/program/soffice.exe exists. electron-builder then packages
# that directory as extraResources (see electron-builder.config.cjs).
#
# The archive must be a .zip whose root contains LibreOffice's `program/`
# (and `share/`, ...) directory tree, i.e. unzipping it into win-x64/ yields
# win-x64/program/soffice.exe.
#
# Configuration (set in CI):
#   PRESENTATION_RUNTIME_URL_WIN     - https URL of the .zip
#   PRESENTATION_RUNTIME_SHA256_WIN  - lowercase hex SHA256 of the .zip
#
# When the URL/SHA are not set the script is a no-op (exit 0): the build then
# ships without a bundled LibreOffice and PPTX falls back to a system install.

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$vendorDir = Join-Path $rootDir "apps/bridge/vendor/presentation-runtime"
$runtimeDir = Join-Path $vendorDir "win-x64"
$soffice = Join-Path $runtimeDir "program/soffice.exe"

$url = $env:PRESENTATION_RUNTIME_URL_WIN
$sha256 = $env:PRESENTATION_RUNTIME_SHA256_WIN

if ([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($sha256)) {
  if (Test-Path $soffice) {
    Write-Host "Windows presentation runtime not pinned; using existing unpacked runtime at $runtimeDir"
    exit 0
  }
  Write-Host "Windows presentation runtime URL/SHA256 not configured; skipping bundle (PPTX will use a system LibreOffice if installed)."
  exit 0
}

$tmpfile = [System.IO.Path]::GetTempFileName()
try {
  Write-Host "Downloading Windows presentation runtime from: $url"
  Invoke-WebRequest -Uri $url -OutFile $tmpfile -UseBasicParsing

  $actual = (Get-FileHash -Path $tmpfile -Algorithm SHA256).Hash.ToLower()
  $expected = $sha256.ToLower()
  if ($actual -ne $expected) {
    Write-Error "Windows presentation runtime SHA256 mismatch.`nExpected: $expected`nActual:   $actual"
    exit 1
  }

  if (Test-Path $runtimeDir) {
    Remove-Item -Recurse -Force $runtimeDir
  }
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  Expand-Archive -Path $tmpfile -DestinationPath $runtimeDir -Force

  if (-not (Test-Path $soffice)) {
    Write-Error "Downloaded Windows presentation runtime is missing $soffice"
    exit 1
  }
  Write-Host "Prepared Windows presentation runtime at $runtimeDir"
}
finally {
  Remove-Item -Force $tmpfile -ErrorAction SilentlyContinue
}
