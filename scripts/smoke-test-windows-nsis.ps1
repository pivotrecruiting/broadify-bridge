param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"

$resolvedInstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$installDirectoryResolver = Join-Path $PSScriptRoot "resolve-windows-install-directory-name.cjs"
$installDirectoryName = (& node $installDirectoryResolver | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installDirectoryName)) {
  throw "Unable to resolve the NSIS installation directory name from electron-builder config."
}
$userProgramsDir = Join-Path $env:LOCALAPPDATA "Programs"
$installDir = Join-Path $userProgramsDir $installDirectoryName
$displayHelperTestScript = Join-Path $PSScriptRoot "test-windows-display-helper.ps1"
$meetingHelperTestScript = Join-Path $PSScriptRoot "test-windows-meeting-helper.ps1"

if (Test-Path -LiteralPath $installDir) {
  throw "NSIS smoke target already exists and will not be overwritten: $installDir"
}

Write-Host "NSIS smoke expected installation directory: $installDir"

$installed = $false
try {
  $install = Start-Process -FilePath $resolvedInstallerPath -ArgumentList "/S" -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "NSIS smoke install failed with exit code $($install.ExitCode)."
  }
  $installed = $true

  if (-not (Test-Path -LiteralPath $installDir -PathType Container)) {
    $candidateDirectories = @(
      Get-ChildItem -LiteralPath $userProgramsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*Bridge*" } |
        Select-Object -ExpandProperty FullName
    )
    $candidateSummary = if ($candidateDirectories.Count -gt 0) {
      $candidateDirectories -join "; "
    } else {
      "none"
    }
    throw "NSIS smoke installation directory was not created: $installDir. Bridge-like candidates: $candidateSummary"
  }

  $helperPath = Join-Path $installDir "resources\native\display-helper\display-helper.exe"
  $sdlPath = Join-Path $installDir "resources\native\display-helper\SDL2.dll"
  if (-not (Test-Path -LiteralPath $sdlPath)) {
    throw "NSIS smoke install is missing SDL2.dll: $sdlPath"
  }
  & $displayHelperTestScript -HelperPath $helperPath -Attempts 3

  $meetingHelperPath = Join-Path $installDir "resources\native\meeting-helper\meeting-helper.exe"
  $meetingModelsDir = Join-Path $installDir "resources\native\meeting-helper\models"
  & $meetingHelperTestScript -HelperPath $meetingHelperPath -ModelsDir $meetingModelsDir

  Write-Host "NSIS native helper smoke tests passed in $installDir"
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
