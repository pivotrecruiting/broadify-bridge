param(
  [Parameter(Mandatory = $true)]
  [string]$HelperPath,

  [Parameter(Mandatory = $true)]
  [string]$ModelsDir,

  # Kept for caller compatibility; the integrated (Windows-parity) helper has
  # no runtime self-test entry, so hardware acceleration cannot be asserted
  # here anymore. Runtime health is covered by ctest + the RC test cycle.
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

Write-Host "Meeting helper packaged-binary smoke passed (loads with packaged DLLs, model present): $resolvedHelperPath"
