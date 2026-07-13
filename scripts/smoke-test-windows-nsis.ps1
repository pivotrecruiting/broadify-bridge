param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"

$resolvedInstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$productName = if ($env:BROADIFY_UPDATER_CHANNEL -eq "rc") {
  "Broadify Bridge RC"
} else {
  "Broadify Bridge"
}
$installDir = Join-Path (Join-Path $env:LOCALAPPDATA "Programs") $productName
$selfTestScript = Join-Path $PSScriptRoot "test-windows-display-helper.ps1"

if (Test-Path -LiteralPath $installDir) {
  throw "NSIS smoke target already exists and will not be overwritten: $installDir"
}

$installed = $false
try {
  $install = Start-Process -FilePath $resolvedInstallerPath -ArgumentList "/S" -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "NSIS smoke install failed with exit code $($install.ExitCode)."
  }
  $installed = $true

  $helperPath = Join-Path $installDir "resources\native\display-helper\display-helper.exe"
  $sdlPath = Join-Path $installDir "resources\native\display-helper\SDL2.dll"
  if (-not (Test-Path -LiteralPath $sdlPath)) {
    throw "NSIS smoke install is missing SDL2.dll: $sdlPath"
  }
  & $selfTestScript -HelperPath $helperPath -Attempts 3

  Write-Host "NSIS display-helper smoke test passed in $installDir"
} finally {
  if ($installed -and (Test-Path -LiteralPath $installDir)) {
    $uninstaller = Get-ChildItem -Path $installDir -File -Filter "Uninstall*.exe" |
      Select-Object -First 1
    if (-not $uninstaller) {
      throw "NSIS smoke install did not create an uninstaller in $installDir"
    }
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) {
      throw "NSIS smoke uninstall failed with exit code $($uninstall.ExitCode)."
    }
  }
}
