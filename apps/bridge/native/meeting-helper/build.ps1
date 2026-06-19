param(
  [string]$Config = "Release"
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $rootDir "build"

cmake -S $rootDir -B $buildDir -DCMAKE_BUILD_TYPE=$Config
cmake --build $buildDir --config $Config

$candidate = Join-Path $buildDir "$Config\meeting-helper.exe"
if (-not (Test-Path $candidate)) {
  $candidate = Join-Path $buildDir "meeting-helper.exe"
}
if (Test-Path $candidate) {
  Copy-Item -Force $candidate (Join-Path $rootDir "meeting-helper.exe")
}
$outputExe = Join-Path $rootDir "meeting-helper.exe"
if (-not (Test-Path $outputExe)) {
  throw "meeting-helper.exe was not produced by the Windows build. Expected output at $outputExe"
}

$onnxRuntimeRoot = $env:BROADIFY_ONNXRUNTIME_ROOT
if ([string]::IsNullOrWhiteSpace($onnxRuntimeRoot)) {
  $onnxRuntimeRoot = Join-Path $rootDir "deps\onnxruntime\windows-x64"
}
if ($env:MEETING_HELPER_ENABLE_MODNET -ne "0") {
  $dllCandidate = Join-Path $onnxRuntimeRoot "lib\onnxruntime.dll"
  if (-not (Test-Path $dllCandidate)) {
    $dllCandidate = Join-Path $onnxRuntimeRoot "onnxruntime.dll"
  }
  if (-not (Test-Path $dllCandidate)) {
    throw "ONNX Runtime DLL not found under $onnxRuntimeRoot"
  }
  Copy-Item -Force $dllCandidate (Join-Path $rootDir "onnxruntime.dll")
}

Write-Host "Built $outputExe"
