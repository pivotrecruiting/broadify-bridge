param(
  # The packaged `resources` folder (installed app or dist\win-unpacked).
  [Parameter(Mandatory = $true)]
  [string]$ResourcesDir
)

# Smoke test for the packaged pgm-helper.exe (live program preview on Windows,
# ADR-0009). The helper ships only behind the build switch
# BROADIFY_PGM_WINDOWS=1. Whether this build has one, and where, comes from the
# Node single source of truth (scripts/lib/windows-pgm-helper.cjs); without
# the switch the list is empty and this script does nothing.
#
# With the switch: the file must exist, and `--probe` must answer. The probe
# loads the executable with every DLL it imports, starts COM and Media
# Foundation, lists the capture devices and prints one JSON line. It opens no
# device and starts no encoder, so it passes on a runner without a camera or
# GPU. A VC runtime missing next to the exe shows up here as a loader exit
# code (0xC0000135) instead of the probe line.

$ErrorActionPreference = "Stop"

$pgmHelperListScript = Join-Path $PSScriptRoot "list-windows-pgm-helper-paths.cjs"
$pgmHelperPaths = @(
  & node $pgmHelperListScript | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($LASTEXITCODE -ne 0) {
  throw "Unable to resolve the packaged PGM helper path from $pgmHelperListScript."
}
if ($pgmHelperPaths.Count -eq 0) {
  # Build without the switch: no helper in the package, nothing to check.
  return
}

$resolvedResourcesDir = (Resolve-Path -LiteralPath $ResourcesDir).Path
foreach ($relativePath in $pgmHelperPaths) {
  $helperPath = Join-Path $resolvedResourcesDir ($relativePath -replace '/', '\')
  if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "Packaged PGM helper is missing: $helperPath (this build was made with BROADIFY_PGM_WINDOWS=1)"
  }
  if ((Get-Item -LiteralPath $helperPath).Length -le 0) {
    throw "Packaged PGM helper is empty: $helperPath"
  }

  $outputLines = @(& $helperPath --probe)
  $exitCode = $LASTEXITCODE
  $output = ($outputLines -join [Environment]::NewLine).Trim()
  if ($exitCode -ne 0) {
    throw "PGM helper probe failed with exit code $exitCode. Output: $output"
  }

  $probeLine = $outputLines | Where-Object { $_ -match '^\{"type":"probe"' } | Select-Object -First 1
  if (-not $probeLine) {
    throw "PGM helper probe printed no probe line. Output: $output"
  }
  try {
    $payload = $probeLine | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "PGM helper probe returned invalid JSON: $probeLine"
  }
  if (
    $payload.type -ne "probe" -or
    $payload.encoder -ne "mediafoundation" -or
    $null -eq $payload.inputs -or
    [string]::IsNullOrWhiteSpace($payload.inputs.camera_permission)
  ) {
    throw "PGM helper probe returned an unexpected payload: $probeLine"
  }

  Write-Host "[PgmHelper] Probe passed ($(@($payload.inputs.inputs).Count) input(s), camera_permission=$($payload.inputs.camera_permission)): $helperPath"
}
