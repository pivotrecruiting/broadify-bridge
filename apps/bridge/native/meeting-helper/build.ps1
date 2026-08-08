param(
  [string]$Config = "Release"
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $rootDir "build"
$outputExe = Join-Path $rootDir "meeting-helper.exe"

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

Invoke-NativeCommand cmake -S $rootDir -B $buildDir -DCMAKE_BUILD_TYPE=$Config
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
if ($env:MEETING_HELPER_ENABLE_MODNET -ne "0") {
  $dllCandidate = Join-Path $onnxRuntimeRoot "lib\onnxruntime.dll"
  if (-not (Test-Path $dllCandidate)) {
    $dllCandidate = Join-Path $onnxRuntimeRoot "onnxruntime.dll"
  }
  if (-not (Test-Path $dllCandidate)) {
    throw "ONNX Runtime DLL not found under $onnxRuntimeRoot"
  }
  Copy-Item -Force $dllCandidate (Join-Path $rootDir "onnxruntime.dll")
  # DirectML execution-provider runtime dependencies. Present in the DirectML
  # ONNX Runtime build; copied next to the exe so the DML provider can load.
  # Absent on a CPU-only ORT build (macOS/CI CPU builds), which is fine.
  $ortLibDir = Split-Path -Parent $dllCandidate
  foreach ($dep in @("onnxruntime_providers_shared.dll", "DirectML.dll")) {
    $depPath = Join-Path $ortLibDir $dep
    if (Test-Path $depPath) {
      Copy-Item -Force $depPath (Join-Path $rootDir $dep)
    }
  }
}

if ($env:MEETING_HELPER_ENABLE_OPENVINO -eq "1") {
  # OpenVINO runtime set next to the exe (same mechanism as the ONNX Runtime
  # DLLs above; electron-builder packages them from here). Keep the list in
  # sync with scripts/prepare-windows-openvino-deps.ps1,
  # electron-builder.config.cjs, scripts/sign-windows-native-resources.cjs
  # and the Windows smoke tests. Fail closed: the exe links openvino.dll, so
  # a missing runtime file must abort the build, not surface as a loader
  # error on customer machines.
  $openVinoRoot = $env:BROADIFY_OPENVINO_ROOT
  if ([string]::IsNullOrWhiteSpace($openVinoRoot)) {
    $openVinoRoot = Join-Path $rootDir "deps\openvino\windows-x64"
  }
  $openVinoBin = Join-Path $openVinoRoot "bin"
  $openVinoFiles = @(
    "openvino.dll",
    "openvino_auto_batch_plugin.dll",
    "openvino_auto_plugin.dll",
    "openvino_hetero_plugin.dll",
    "openvino_intel_cpu_plugin.dll",
    "openvino_intel_gpu_plugin.dll",
    "openvino_intel_npu_plugin.dll",
    "openvino_ir_frontend.dll",
    "openvino_onnx_frontend.dll",
    "cache.json",
    "tbb12.dll",
    "tbbbind_2_5.dll",
    "tbbmalloc.dll"
  )
  foreach ($file in $openVinoFiles) {
    $sourcePath = Join-Path $openVinoBin $file
    if (-not (Test-Path $sourcePath)) {
      throw "OpenVINO runtime file not found: $sourcePath (run scripts/prepare-windows-openvino-deps.ps1)"
    }
    Copy-Item -Force $sourcePath (Join-Path $rootDir $file)
  }
}

Write-Host "Built $outputExe"
