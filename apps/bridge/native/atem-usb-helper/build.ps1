param(
  [string]$Config = "Release"
)

# Builds the ATEM USB helper (Windows). Run from a Developer PowerShell for
# VS (cl + midl on PATH). SDK interface headers are midl-generated from the
# BMDSwitcherAPI.idl shipped with the locally installed ATEM software (or an
# explicit ATEM_SDK_ROOT); no SDK files are committed or shipped.

$ErrorActionPreference = "Stop"

# The ATEM COM runtime is 64-bit only; a 32-bit build silently fails at
# CoCreateInstance (looks like "ATEM software not installed"). Fail fast.
if ($env:VSCMD_ARG_TGT_ARCH -and $env:VSCMD_ARG_TGT_ARCH -ne "x64") {
  throw "This helper must be built for x64 (current target: $($env:VSCMD_ARG_TGT_ARCH)). Use the 'x64 Native Tools' prompt or Launch-VsDevShell -Arch amd64."
}
if (-not $env:VSCMD_ARG_TGT_ARCH) {
  Write-Warning "VSCMD_ARG_TGT_ARCH is not set - make sure this shell targets x64."
}

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $rootDir "build-win"
$outputExe = Join-Path $rootDir "atem-usb-helper.exe"

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

$sdkRoot = $env:ATEM_SDK_ROOT
if (-not $sdkRoot) {
  $sdkRoot = "C:\Program Files (x86)\Blackmagic Design\Blackmagic ATEM Switchers\Developer SDK\Windows"
}
$idlPath = Join-Path $sdkRoot "include\BMDSwitcherAPI.idl"
if (-not (Test-Path $idlPath)) {
  throw "BMDSwitcherAPI.idl not found under '$sdkRoot\include'. Install the Blackmagic ATEM software or set ATEM_SDK_ROOT."
}

if (Test-Path $outputExe) {
  Remove-Item -Force $outputExe
}
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

# Generate the COM interface header + IID definitions from the SDK IDL.
Invoke-NativeCommand midl /nologo /h BMDSwitcherAPI_h.h /iid BMDSwitcherAPI_i.c /out $buildDir $idlPath

$sourcePath = Join-Path $rootDir "src\atem-usb-helper.cpp"
$iidPath = Join-Path $buildDir "BMDSwitcherAPI_i.c"

Invoke-NativeCommand cl /nologo /std:c++17 /EHsc /O2 /W4 /DUNICODE /D_UNICODE `
  /I $buildDir `
  /Fo"$buildDir\" `
  $sourcePath $iidPath `
  /Fe:$outputExe `
  ole32.lib oleaut32.lib

Write-Host "built $outputExe"
