param(
  [string]$Config = "Release",
  [switch]$UseSdkIdl
)

# Builds the ATEM USB helper (Windows). The default build uses the checked-in
# interoperability header and does not require the ATEM SDK or midl. Use
# -UseSdkIdl only as a local cross-check against an installed SDK IDL.

$ErrorActionPreference = "Stop"

if ($env:SKIP_ATEM_USB_HELPER_BUILD -eq "1") {
  Write-Host "Skipping ATEM USB helper build (SKIP_ATEM_USB_HELPER_BUILD=1)."
  exit 0
}

# The ATEM COM runtime is 64-bit only; a 32-bit build silently fails at
# CoCreateInstance (looks like "ATEM software not installed"). Fail fast.
if ($env:VSCMD_ARG_TGT_ARCH -and $env:VSCMD_ARG_TGT_ARCH -ne "x64") {
  throw "This helper must be built for x64 (current target: $($env:VSCMD_ARG_TGT_ARCH)). Use the 'x64 Native Tools' prompt or Launch-VsDevShell -Arch amd64."
}
if (-not $env:VSCMD_ARG_TGT_ARCH) {
  Write-Warning "VSCMD_ARG_TGT_ARCH is not set - make sure this shell targets x64."
}

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $rootDir "src"
$buildDir = Join-Path $rootDir "build-win"
$outputExe = Join-Path $rootDir "atem-usb-helper.exe"
$sourcePath = Join-Path $srcDir "atem-usb-helper.cpp"
$interopHeader = Join-Path $srcDir "bmd_switcher_interop_win.h"
$sdkIdlSha = "interop-v97+v100"
$sdkDiscoveryClsid = "B8C0BA7E-BDED-4B73-96A8-266AF1BC2D7A+8A13D4FA-4801-48E3-BF68-442D63E34500"
$sdkVersion = "9.7+10.0-interop"

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

function Get-IdlUuidBefore {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text,
    [Parameter(Mandatory = $true)]
    [string]$Kind,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $pattern = "(?is)\[[^\]]*uuid\s*\(\s*([0-9a-f-]{36})\s*\)[^\]]*\]\s*$Kind\s+$Name\b"
  $match = [regex]::Match($Text, $pattern)
  if (-not $match.Success) {
    return $null
  }
  return $match.Groups[1].Value.ToUpperInvariant()
}

function Test-BytePattern {
  param([byte[]]$Bytes, [byte[]]$Pattern)
  for ($i = 0; $i -le $Bytes.Length - $Pattern.Length; $i++) {
    $matched = $true
    for ($j = 0; $j -lt $Pattern.Length; $j++) {
      if ($Bytes[$i + $j] -ne $Pattern[$j]) { $matched = $false; break }
    }
    if ($matched) { return $true }
  }
  return $false
}

if ($UseSdkIdl) {
  $sdkCandidates = @()
  if ($env:ATEM_SDK_ROOT) {
    $sdkCandidates += $env:ATEM_SDK_ROOT
  }
  $sdkCandidates += "C:\Program Files (x86)\Blackmagic Design\ATEM Switchers\Developer SDK\Windows"
  $sdkCandidates += "C:\Program Files (x86)\Blackmagic Design\Blackmagic ATEM Switchers\Developer SDK\Windows"

  $triedIdlPaths = @()
  $idlPath = $null
  foreach ($candidate in $sdkCandidates) {
    $candidateIdlPath = Join-Path $candidate "include\BMDSwitcherAPI.idl"
    $triedIdlPaths += $candidateIdlPath
    if (Test-Path $candidateIdlPath) {
      $idlPath = $candidateIdlPath
      break
    }
  }
  if (-not $idlPath) {
    throw "BMDSwitcherAPI.idl not found. Tried: $($triedIdlPaths -join '; '). Install the Blackmagic ATEM software or set ATEM_SDK_ROOT."
  }

  $idlText = Get-Content -Raw -Path $idlPath
  $sdkIdlSha = (Get-FileHash $idlPath -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0, 12)
  $sdkDiscoveryClsid = Get-IdlUuidBefore -Text $idlText -Kind "coclass" -Name "CBMDSwitcherDiscovery"
  if (-not $sdkDiscoveryClsid) {
    throw "Could not extract CBMDSwitcherDiscovery CLSID from $idlPath."
  }
  $versionMatch = [regex]::Match($idlText, "(?im)\b(?:ATEM\s+)?(?:Switchers\s+)?(?:SDK\s+)?(?:version|v)\s*[:= ]+\s*([0-9]+(?:\.[0-9]+)+)")
  $sdkVersion = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { "unknown" }

  Write-Host "Using BMDSwitcherAPI.idl for cross-check: $idlPath"
  Write-Host "BMDSwitcherAPI.idl SHA256: $sdkIdlSha"
  Write-Host "CBMDSwitcherDiscovery CLSID: $sdkDiscoveryClsid"
  New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
  Invoke-NativeCommand midl /nologo /h BMDSwitcherAPI_h.h /iid BMDSwitcherAPI_i.c /out $buildDir $idlPath
} else {
  Write-Host "Using Windows interop header: $interopHeader"
  Write-Host "Interop Discovery CLSIDs: $sdkDiscoveryClsid"
  Write-Host "Interop Discovery IIDs: 83C30ED4-4314-4C81-B1E3-23C518D6D8BD + 1EEE089A-5422-4A76-B068-F6EDCFBD3AC0"
}

if (Test-Path $outputExe) {
  Remove-Item -Force $outputExe
}
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$defineSdkIdlSha = '/DHELPER_SDK_IDL_SHA=\"' + $sdkIdlSha + '\"'
$defineSdkDiscoveryClsid = '/DHELPER_SDK_DISCOVERY_CLSID=\"' + $sdkDiscoveryClsid + '\"'
$defineSdkVersion = '/DHELPER_SDK_VERSION=\"' + $sdkVersion + '\"'

Invoke-NativeCommand cl /nologo /std:c++17 /EHsc /O2 /W4 /DUNICODE /D_UNICODE `
  $defineSdkIdlSha $defineSdkDiscoveryClsid $defineSdkVersion `
  /I $srcDir `
  /Fo"$buildDir\" `
  $sourcePath `
  /Fe:$outputExe `
  ole32.lib oleaut32.lib

$exeBytes = [System.IO.File]::ReadAllBytes($outputExe)
$requiredGuids = @(
  "B8C0BA7E-BDED-4B73-96A8-266AF1BC2D7A",
  "8A13D4FA-4801-48E3-BF68-442D63E34500",
  "83C30ED4-4314-4C81-B1E3-23C518D6D8BD",
  "1EEE089A-5422-4A76-B068-F6EDCFBD3AC0"
)
foreach ($guid in $requiredGuids) {
  if (-not (Test-BytePattern -Bytes $exeBytes -Pattern ([Guid]::Parse($guid)).ToByteArray())) {
    throw "Built helper does not contain required Discovery GUID bytes ($guid)."
  }
}
Write-Host "Verified embedded 9.7 and 10.0 Discovery CLSID/IID bytes in $outputExe"

Write-Host "built $outputExe"
