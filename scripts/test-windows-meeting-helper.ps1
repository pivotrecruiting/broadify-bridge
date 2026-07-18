param(
  [Parameter(Mandatory = $true)]
  [string]$HelperPath,

  [Parameter(Mandatory = $true)]
  [string]$ModelsDir,

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

$previousGpuSelfTestDriver = [Environment]::GetEnvironmentVariable("BROADIFY_MEETING_GPU_SELF_TEST_DRIVER", "Process")
$previousKeyerSelfTestProvider = [Environment]::GetEnvironmentVariable("BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER", "Process")

if (-not $RequireHardwareAcceleration) {
  $env:BROADIFY_MEETING_GPU_SELF_TEST_DRIVER = "warp"
  $env:BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER = "cpu"
} else {
  Remove-Item Env:BROADIFY_MEETING_GPU_SELF_TEST_DRIVER -ErrorAction SilentlyContinue
  Remove-Item Env:BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER -ErrorAction SilentlyContinue
}

try {
  & $resolvedHelperPath --self-test
  if ($LASTEXITCODE -ne 0) {
    throw "Meeting helper GPU self-test failed with exit code $LASTEXITCODE."
  }

  & $resolvedHelperPath --keyer-self-test --models-dir $resolvedModelsDir
  if ($LASTEXITCODE -ne 0) {
    throw "Meeting helper keyer self-test failed with exit code $LASTEXITCODE."
  }
} finally {
  [Environment]::SetEnvironmentVariable("BROADIFY_MEETING_GPU_SELF_TEST_DRIVER", $previousGpuSelfTestDriver, "Process")
  [Environment]::SetEnvironmentVariable("BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER", $previousKeyerSelfTestProvider, "Process")
}

$mode = if ($RequireHardwareAcceleration) { "hardware" } else { "portable CI" }
Write-Host "Meeting helper GPU and keyer smoke tests passed ($mode): $resolvedHelperPath"
