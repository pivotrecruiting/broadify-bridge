param(
  [string]$Config = "Release"
)

# Builds pgm-helper.exe (Windows, ADR-0009) next to this script, the way
# meeting-helper/build.ps1 builds meeting-helper.exe. Running it is the opt-in:
# it configures with -DLIVE_STREAM_WITH_WEBRTC=ON, so it needs the static
# OpenSSL from scripts/prepare-windows-pgm-deps.ps1 and network access for
# FetchContent (libdatachannel, opus). No release script calls it; the wrapper
# scripts/build-pgm-helper.sh only does so with BROADIFY_PGM_WINDOWS=1.
#
#   PGM_HELPER_BUILD_TESTS=0        build the helper only, not the ctest targets
#   PGM_HELPER_CMAKE_EXTRA_ARGS     extra configure arguments, separated by
#                                   whitespace (e.g. FETCHCONTENT_SOURCE_DIR_*)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $rootDir "build"
$outputExe = Join-Path $rootDir "pgm-helper.exe"

function Invoke-Cmake {
  param([string[]]$CmakeArguments)

  & cmake @CmakeArguments
  if ($LASTEXITCODE -ne 0) {
    throw "cmake $($CmakeArguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

if (Test-Path $outputExe) {
  Remove-Item -Force $outputExe
}

$configureArguments = @(
  "-S", $rootDir,
  "-B", $buildDir,
  "-DCMAKE_BUILD_TYPE=$Config",
  "-DLIVE_STREAM_WITH_WEBRTC=ON",
  "-DCMAKE_POLICY_VERSION_MINIMUM=3.5"
)
if (-not [string]::IsNullOrWhiteSpace($env:PGM_HELPER_CMAKE_EXTRA_ARGS)) {
  $configureArguments += @($env:PGM_HELPER_CMAKE_EXTRA_ARGS -split '\s+' | Where-Object { $_ })
}
Invoke-Cmake $configureArguments
Invoke-Cmake @("--build", $buildDir, "--target", "pgm-helper", "--config", $Config)
if ($env:PGM_HELPER_BUILD_TESTS -ne "0") {
  # Everything else of the tree: the ctest targets (run them with
  # ctest --test-dir build --build-config Release).
  Invoke-Cmake @("--build", $buildDir, "--config", $Config)
}

$candidates = @(
  (Join-Path $buildDir "$Config\pgm-helper.exe"),
  (Join-Path $buildDir "pgm-helper.exe")
)
$candidate = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $candidate) {
  $candidate = Get-ChildItem -Path $buildDir -Filter "pgm-helper.exe" -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if ($candidate) {
  Copy-Item -Force $candidate $outputExe
}
if (-not (Test-Path $outputExe)) {
  Write-Host "pgm-helper.exe candidates searched:"
  foreach ($path in $candidates) {
    Write-Host "  $path"
  }
  throw "pgm-helper.exe was not produced by the Windows build. Expected output at $outputExe"
}

Write-Host "Built $outputExe"
