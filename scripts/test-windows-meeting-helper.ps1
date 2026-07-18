param(
  [Parameter(Mandatory = $true)]
  [string]$HelperPath,

  [Parameter(Mandatory = $true)]
  [string]$ModelsDir
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

& $resolvedHelperPath --self-test
if ($LASTEXITCODE -ne 0) {
  throw "Meeting helper GPU self-test failed with exit code $LASTEXITCODE."
}

& $resolvedHelperPath --keyer-self-test --models-dir $resolvedModelsDir
if ($LASTEXITCODE -ne 0) {
  throw "Meeting helper keyer self-test failed with exit code $LASTEXITCODE."
}

Write-Host "Meeting helper GPU and keyer smoke tests passed: $resolvedHelperPath"
