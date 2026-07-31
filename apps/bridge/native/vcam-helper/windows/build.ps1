param(
  [string]$Config = "Release"
)

# Builds the Windows virtual-camera media source (broadify-vcam.dll) and drops
# it next to this script, where electron-builder's win extraResources pick it
# up. The DLL is loaded by the Windows Frame Server after the installer
# registers its CLSID (see build/windows-installer.nsh).

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $rootDir "build"
$outputDll = Join-Path $rootDir "broadify-vcam.dll"

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE"
  }
}

if (Test-Path $outputDll) {
  Remove-Item -Force $outputDll
}

Invoke-NativeCommand cmake -S $rootDir -B $buildDir -DCMAKE_BUILD_TYPE=$Config
Invoke-NativeCommand cmake --build $buildDir --target broadify-vcam --config $Config --verbose

$builtDll = Join-Path (Join-Path $buildDir $Config) "broadify-vcam.dll"
if (-not (Test-Path $builtDll)) {
  # Single-config generators (Ninja) emit straight into the build directory.
  $builtDll = Join-Path $buildDir "broadify-vcam.dll"
}
if (-not (Test-Path $builtDll)) {
  throw "broadify-vcam.dll not found under $buildDir"
}

Copy-Item -Force $builtDll $outputDll
Write-Host "broadify-vcam.dll -> $outputDll"
