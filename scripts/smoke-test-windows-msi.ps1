param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"

$resolvedInstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$installDir = Join-Path $env:RUNNER_TEMP "broadify-bridge-msi-smoke"
$installLog = Join-Path $env:RUNNER_TEMP "broadify-bridge-msi-smoke-install.log"
$uninstallLog = Join-Path $env:RUNNER_TEMP "broadify-bridge-msi-smoke-uninstall.log"
$installed = $false

if (Test-Path -LiteralPath $installDir) {
  Remove-Item -Recurse -Force $installDir
}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

try {
  $installArgs = @(
    "/i", $resolvedInstallerPath,
    "/qn",
    "/norestart",
    "/L*v", $installLog,
    "APPLICATIONFOLDER=$installDir",
    "ALLUSERS=2",
    "MSIINSTALLPERUSER=1"
  )
  $install = Start-Process msiexec.exe -ArgumentList $installArgs -Wait -PassThru
  if ($install.ExitCode -notin @(0, 3010)) {
    throw "MSI smoke install failed with exit code $($install.ExitCode). See $installLog"
  }
  $installed = $true

  $expectedPaths = @(
    (Join-Path $installDir "resources\native\display-helper\display-helper.exe"),
    (Join-Path $installDir "resources\native\display-helper\SDL2.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\meeting-helper.exe"),
    (Join-Path $installDir "resources\native\meeting-helper\onnxruntime.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\onnxruntime_providers_shared.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\DirectML.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\models\modnet.onnx"),
    (Join-Path $installDir "resources\bridge\native\framebus\build\Release\framebus.node")
  )
  $mainExe = Get-ChildItem -Path $installDir -File -Filter "BroadifyBridge*.exe" |
    Select-Object -First 1
  if (-not $mainExe) {
    throw "MSI smoke install did not create a BroadifyBridge*.exe in $installDir"
  }
  foreach ($path in $expectedPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "MSI smoke install missing expected packaged file: $path"
    }
  }

  $displayHelperPath = Join-Path $installDir "resources\native\display-helper\display-helper.exe"
  & (Join-Path $PSScriptRoot "test-windows-display-helper.ps1") -HelperPath $displayHelperPath -Attempts 3

  $meetingHelperPath = Join-Path $installDir "resources\native\meeting-helper\meeting-helper.exe"
  $meetingModelsDir = Join-Path $installDir "resources\native\meeting-helper\models"
  & (Join-Path $PSScriptRoot "test-windows-meeting-helper.ps1") -HelperPath $meetingHelperPath -ModelsDir $meetingModelsDir

  Write-Host "MSI smoke install verified in $installDir"
} finally {
  if ($installed) {
    $uninstallArgs = @(
      "/x", $resolvedInstallerPath,
      "/qn",
      "/norestart",
      "/L*v", $uninstallLog
    )
    $uninstall = Start-Process msiexec.exe -ArgumentList $uninstallArgs -Wait -PassThru
    if ($uninstall.ExitCode -notin @(0, 3010, 1605)) {
      throw "MSI smoke uninstall failed with exit code $($uninstall.ExitCode). See $uninstallLog"
    }
  }
}
