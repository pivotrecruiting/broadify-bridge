param(
  [string]$Config = "Release"
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $rootDir "build"
$outputExe = Join-Path $rootDir "meeting-helper.exe"
$modnetEnabled = if ([string]::IsNullOrWhiteSpace($env:MEETING_HELPER_ENABLE_MODNET)) { "1" } else { $env:MEETING_HELPER_ENABLE_MODNET }
Write-Host "Meeting helper MODNet enabled: $modnetEnabled"

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

if (Test-Path $outputExe) {
  Remove-Item -Force $outputExe
}

Invoke-NativeCommand cmake -S $rootDir -B $buildDir -DCMAKE_BUILD_TYPE=$Config -DMEETING_HELPER_ENABLE_MODNET=$modnetEnabled
Invoke-NativeCommand cmake --build $buildDir --target meeting-helper --config $Config --verbose

$candidates = @(
  (Join-Path $buildDir "$Config\meeting-helper.exe"),
  (Join-Path $buildDir "meeting-helper.exe")
)
$candidate = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $candidate) {
  $candidate = Get-ChildItem -Path $buildDir -Filter "meeting-helper.exe" -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if ($candidate) {
  Copy-Item -Force $candidate $outputExe
}
if (-not (Test-Path $outputExe)) {
  Write-Host "meeting-helper.exe candidates searched:"
  foreach ($path in $candidates) {
    Write-Host "  $path"
  }
  Write-Host "Build directory executable outputs:"
  Get-ChildItem -Path $buildDir -Recurse -File -Include "*.exe" -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName |
    ForEach-Object { Write-Host "  $_" }
  throw "meeting-helper.exe was not produced by the Windows build. Expected output at $outputExe"
}

$onnxRuntimeRoot = $env:BROADIFY_ONNXRUNTIME_ROOT
if ([string]::IsNullOrWhiteSpace($onnxRuntimeRoot)) {
  $onnxRuntimeRoot = Join-Path $rootDir "deps\onnxruntime\windows-x64"
}
if ($modnetEnabled -ne "0") {
  $dllCandidate = Join-Path $onnxRuntimeRoot "lib\onnxruntime.dll"
  if (-not (Test-Path $dllCandidate)) {
    $dllCandidate = Join-Path $onnxRuntimeRoot "onnxruntime.dll"
  }
  if (-not (Test-Path $dllCandidate)) {
    throw "ONNX Runtime DLL not found under $onnxRuntimeRoot"
  }
  Copy-Item -Force $dllCandidate (Join-Path $rootDir "onnxruntime.dll")
  $ortLibDir = Split-Path -Parent $dllCandidate
  foreach ($dependency in @("onnxruntime_providers_shared.dll", "DirectML.dll")) {
    $dependencyPath = Join-Path $ortLibDir $dependency
    if (-not (Test-Path $dependencyPath)) {
      throw "DirectML runtime dependency missing: $dependencyPath"
    }
    Copy-Item -Force $dependencyPath (Join-Path $rootDir $dependency)
  }
}

Write-Host "Built $outputExe"
