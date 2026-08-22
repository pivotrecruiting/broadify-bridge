param(
  [Parameter(Mandatory = $true)]
  [string]$HelperPath,

  [Parameter(Mandatory = $true)]
  [string]$ModelsDir,

# Kept for caller compatibility; without it the GPU self-test runs on WARP so
# release CI executes the D3D11/D3D12 path even on GPU-less runners.
  [switch]$RequireHardwareAcceleration
)

$ErrorActionPreference = "Stop"

$resolvedHelperPath = (Resolve-Path -LiteralPath $HelperPath).Path
$resolvedModelsDir = (Resolve-Path -LiteralPath $ModelsDir).Path
$helperDirectory = Split-Path -Parent $resolvedHelperPath
$requiredFiles = @(
  $resolvedHelperPath,
  (Join-Path $helperDirectory "onnxruntime.dll"),
  (Join-Path $helperDirectory "onnxruntime_providers_shared.dll"),
  (Join-Path $helperDirectory "DirectML.dll"),
  # OpenVINO matting backend runtime: openvino.dll is a static import of the
  # helper exe (the binary-load smoke below fails without it); the plugins,
  # frontends and TBB are loaded at run time from the same directory.
  (Join-Path $helperDirectory "openvino.dll"),
  (Join-Path $helperDirectory "openvino_auto_batch_plugin.dll"),
  (Join-Path $helperDirectory "openvino_auto_plugin.dll"),
  (Join-Path $helperDirectory "openvino_hetero_plugin.dll"),
  (Join-Path $helperDirectory "openvino_intel_cpu_plugin.dll"),
  (Join-Path $helperDirectory "openvino_intel_gpu_plugin.dll"),
  (Join-Path $helperDirectory "openvino_intel_npu_plugin.dll"),
  (Join-Path $helperDirectory "openvino_ir_frontend.dll"),
  (Join-Path $helperDirectory "openvino_onnx_frontend.dll"),
  (Join-Path $helperDirectory "cache.json"),
  (Join-Path $helperDirectory "tbb12.dll"),
  (Join-Path $helperDirectory "tbbbind_2_5.dll"),
  (Join-Path $helperDirectory "tbbmalloc.dll"),
  (Join-Path $resolvedModelsDir "modnet.onnx")
)

foreach ($path in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Meeting helper smoke test is missing required file: $path"
  }
}

$modelSize = (Get-Item -LiteralPath (Join-Path $resolvedModelsDir "modnet.onnx")).Length
if ($modelSize -lt 1MB) {
  throw "Packaged modnet.onnx looks truncated ($modelSize bytes)."
}

# Binary-load smoke: launching the helper without --run makes it print its
# usage error and exit with code 2. Reaching that point proves the PE loads
# and all import DLLs (onnxruntime, DirectML, ...) resolve from the packaged
# layout — a missing/misplaced DLL aborts with a loader error instead.
$output = & $resolvedHelperPath 2>&1
if ($LASTEXITCODE -ne 2) {
  throw "Meeting helper binary-load smoke expected usage exit code 2, got $LASTEXITCODE. Output: $output"
}
if (-not ($output -match "requires --run")) {
  throw "Meeting helper binary-load smoke did not print its usage banner. Output: $output"
}

# The usage probe above intentionally leaves exit code 2 in $LASTEXITCODE;
# reset it so the CI shell wrapper (which exits with $LASTEXITCODE) does not
# fail the step after a fully successful smoke.
& "$env:ComSpec" /c exit 0 | Out-Null

if (-not $RequireHardwareAcceleration) {
  $env:BROADIFY_MEETING_GPU_SELF_TEST_DRIVER = "warp"
}
$env:BROADIFY_MEETING_GPU_RESIDENT = "1"
$gpuOutput = & $resolvedHelperPath --gpu-selftest 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Meeting helper GPU self-test failed with exit code $LASTEXITCODE. Output: $gpuOutput"
}
$gpuJson = ($gpuOutput | Select-Object -Last 1) | ConvertFrom-Json
if (-not $gpuJson.ok) {
  throw "Meeting helper GPU self-test returned ok=false. Output: $gpuOutput"
}
if ($gpuJson.cpu_frame_copies_per_frame -ne 0) {
  throw "Meeting helper GPU self-test expected cpu_frame_copies_per_frame=0, got $($gpuJson.cpu_frame_copies_per_frame)."
}

Write-Host "Meeting helper packaged-binary smoke passed (loads with packaged DLLs, model present, GPU self-test ok): $resolvedHelperPath"
