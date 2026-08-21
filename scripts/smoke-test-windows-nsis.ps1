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
# The installer is built per-machine (electron-builder.json nsis.perMachine):
# it installs under Program Files and registers the virtual-camera CLSID in
# HKLM. This script therefore has to run elevated (the CI runner is).
$programFilesDir = $env:ProgramFiles
$installDir = Join-Path $programFilesDir $installDirectoryName
# Must match apps/bridge/native/vcam-helper/windows/vcam_guid.h and
# build/windows-installer.nsh.
$vcamClsid = "{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}"
$vcamInprocServerKey = "HKLM:\SOFTWARE\Classes\CLSID\$vcamClsid\InprocServer32"
$vcamClsidKey = "HKLM:\SOFTWARE\Classes\CLSID\$vcamClsid"
$displayHelperTestScript = Join-Path $PSScriptRoot "test-windows-display-helper.ps1"
$meetingHelperTestScript = Join-Path $PSScriptRoot "test-windows-meeting-helper.ps1"

if (Test-Path -LiteralPath $installDir) {
  throw "NSIS smoke target already exists and will not be overwritten: $installDir"
}
if (Test-Path -LiteralPath $vcamClsidKey) {
  throw "VCam CLSID is already registered ($vcamClsidKey); the smoke test cannot prove the installer registered it."
}

Write-Host "NSIS smoke expected installation directory: $installDir"

$installed = $false
try {
  # /allusers is implied by perMachine but stated explicitly so the intent
  # survives a config change; a non-zero exit (e.g. 3 = vcam registration
  # failed, see build/windows-installer.nsh) fails the smoke test.
  $install = Start-Process -FilePath $resolvedInstallerPath -ArgumentList @("/S", "/allusers") -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "NSIS smoke install failed with exit code $($install.ExitCode)."
  }
  $installed = $true

  if (-not (Test-Path -LiteralPath $installDir -PathType Container)) {
    $candidateDirectories = @(
      Get-ChildItem -LiteralPath $programFilesDir -Directory -ErrorAction SilentlyContinue |
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

  # The INSTALLER (not this script) must have registered the virtual camera:
  # the 64-bit HKLM CLSID must exist and point at the installed DLL.
  $vcamDllPath = Join-Path $installDir "resources\native\vcam-helper\broadify-vcam.dll"
  if (-not (Test-Path -LiteralPath $vcamDllPath)) {
    throw "NSIS smoke install is missing broadify-vcam.dll: $vcamDllPath"
  }
  if (-not (Test-Path -LiteralPath $vcamInprocServerKey)) {
    throw "NSIS installer did not register the VCam CLSID: $vcamInprocServerKey is missing (regsvr32 exit code in the installer log)."
  }
  $registeredDllPath = (Get-ItemProperty -LiteralPath $vcamInprocServerKey).'(default)'
  if ([string]::IsNullOrWhiteSpace($registeredDllPath)) {
    throw "VCam CLSID InprocServer32 has no default value: $vcamInprocServerKey"
  }
  $normalizedInstallDir = $installDir.TrimEnd('\') + '\'
  if (-not $registeredDllPath.StartsWith($normalizedInstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "VCam CLSID points outside the install directory: $registeredDllPath (expected under $installDir)"
  }
  if (-not (Test-Path -LiteralPath $registeredDllPath)) {
    throw "VCam CLSID points at a missing file: $registeredDllPath"
  }
  Write-Host "NSIS installer registered the VCam CLSID -> $registeredDllPath"

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
    # customUnInstall removes the CLSID key directly (the DLL is already gone
    # at that point); an orphaned key would be the next stale-path failure.
    if (Test-Path -LiteralPath $vcamClsidKey) {
      throw "NSIS uninstall left the VCam CLSID registered: $vcamClsidKey"
    }
  }
}
