param(
  [Parameter(Mandatory = $true)]
  [string]$HelperPath,
  [ValidateRange(1, 10)]
  [int]$Attempts = 3
)

$ErrorActionPreference = "Stop"

$resolvedHelperPath = (Resolve-Path -LiteralPath $HelperPath).Path
if ((Get-Item -LiteralPath $resolvedHelperPath).Length -le 0) {
  throw "Display helper is empty: $resolvedHelperPath"
}

for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
  $outputLines = @(& $resolvedHelperPath --self-test)
  $exitCode = $LASTEXITCODE
  $output = ($outputLines -join [Environment]::NewLine).Trim()

  if ($exitCode -ne 0) {
    throw "Display helper self-test attempt $attempt/$Attempts failed with exit code $exitCode."
  }

  try {
    $payload = $output | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Display helper self-test attempt $attempt/$Attempts returned invalid JSON: $output"
  }

  if (
    $payload.type -ne "self_test" -or
    $payload.version -ne 1 -or
    $payload.status -ne "ok"
  ) {
    throw "Display helper self-test attempt $attempt/$Attempts returned an unexpected payload: $output"
  }

  Write-Host "[DisplayHelper] Self-test attempt $attempt/$Attempts passed: $output"
}
