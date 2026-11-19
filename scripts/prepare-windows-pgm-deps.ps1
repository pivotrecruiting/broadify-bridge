param(
  # vcpkg checkout to use. Default: VCPKG_ROOT, then VCPKG_INSTALLATION_ROOT
  # (GitHub runners), then C:\vcpkg.
  [string]$VcpkgRoot,
  # Static libraries with the dynamic CRT, like every other helper (ADR-0009).
  [string]$Triplet = "x64-windows-static-md",
  [string]$InstallRoot
)

# Static OpenSSL for the Windows build of the live program (libdatachannel in
# apps/bridge/native/live-stream). Only needed with BROADIFY_PGM_WINDOWS=1 or
# -DLIVE_STREAM_WITH_WEBRTC=ON; a normal Windows release never runs this.
# The version comes from the manifest next to the library (vcpkg.json,
# builtin-baseline), the result lands in the gitignored deps directory that
# live-stream/CMakeLists.txt reads as OPENSSL_ROOT_DIR.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestRoot = Join-Path $repoRoot "apps\bridge\native\live-stream"
$manifestPath = Join-Path $manifestRoot "vcpkg.json"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $manifestRoot "deps\vcpkg_installed"
}
$tripletRoot = Join-Path $InstallRoot $Triplet
$stampPath = Join-Path $tripletRoot ".broadify-manifest-sha256"
$requiredFiles = @(
  (Join-Path $tripletRoot "include\openssl\ssl.h"),
  (Join-Path $tripletRoot "lib\libssl.lib"),
  (Join-Path $tripletRoot "lib\libcrypto.lib")
)

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "vcpkg manifest is missing: $manifestPath"
}
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash

function Get-MissingFiles {
  return @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
}

# Short-circuit: same manifest as the last successful install and all files
# still there (local rebuilds, CI cache hits). Building OpenSSL takes minutes.
if ((Test-Path -LiteralPath $stampPath -PathType Leaf) -and (Get-MissingFiles).Count -eq 0) {
  $stamp = (Get-Content -LiteralPath $stampPath -Raw).Trim()
  if ($stamp -eq $manifestHash) {
    Write-Host "Static OpenSSL ($Triplet) already prepared at $tripletRoot - skipping vcpkg."
    exit 0
  }
  Write-Host "vcpkg manifest changed since the last install - re-running vcpkg."
}

if ([string]::IsNullOrWhiteSpace($VcpkgRoot)) {
  foreach ($candidate in @($env:VCPKG_ROOT, $env:VCPKG_INSTALLATION_ROOT, "C:\vcpkg")) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Container)) {
      $VcpkgRoot = $candidate
      break
    }
  }
}
if ([string]::IsNullOrWhiteSpace($VcpkgRoot) -or -not (Test-Path -LiteralPath $VcpkgRoot -PathType Container)) {
  throw ("vcpkg not found. Pass -VcpkgRoot or set VCPKG_ROOT to a vcpkg checkout " +
    "(git clone https://github.com/microsoft/vcpkg, then bootstrap-vcpkg.bat).")
}

$vcpkgExe = Join-Path $VcpkgRoot "vcpkg.exe"
if (-not (Test-Path -LiteralPath $vcpkgExe -PathType Leaf)) {
  $bootstrap = Join-Path $VcpkgRoot "bootstrap-vcpkg.bat"
  if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) {
    throw "Neither vcpkg.exe nor bootstrap-vcpkg.bat found in $VcpkgRoot"
  }
  & $bootstrap -disableMetrics
  if ($LASTEXITCODE -ne 0) {
    throw "bootstrap-vcpkg.bat failed with exit code $LASTEXITCODE"
  }
}

Write-Host "Installing OpenSSL ($Triplet) from $manifestPath with $vcpkgExe"
& $vcpkgExe install `
  "--vcpkg-root=$VcpkgRoot" `
  "--x-manifest-root=$manifestRoot" `
  "--x-install-root=$InstallRoot" `
  "--triplet=$Triplet" `
  "--host-triplet=$Triplet"
if ($LASTEXITCODE -ne 0) {
  throw "vcpkg install failed with exit code $LASTEXITCODE"
}

$missing = Get-MissingFiles
if ($missing.Count -gt 0) {
  throw ("vcpkg finished but the static OpenSSL tree is incomplete (missing: " + ($missing -join ", ") + ")")
}
# Static means static: an OpenSSL DLL here would end up as an unsigned,
# unlisted file next to the helper (ADR-0009, point 5).
$dlls = @(Get-ChildItem -LiteralPath $tripletRoot -Recurse -Filter "*.dll" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(libssl|libcrypto|ssleay|libeay)' })
if ($dlls.Count -gt 0) {
  throw ("triplet $Triplet produced OpenSSL DLLs, expected static libraries only: " +
    (($dlls | ForEach-Object { $_.FullName }) -join ", "))
}

Set-Content -LiteralPath $stampPath -Value $manifestHash -NoNewline
Write-Host "Prepared static OpenSSL ($Triplet) at $tripletRoot"
