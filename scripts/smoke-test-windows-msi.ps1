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
    (Join-Path $installDir "resources\native\meeting-helper\openvino.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\openvino_auto_batch_plugin.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\openvino_auto_plugin.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\openvino_hetero_plugin.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\openvino_intel_cpu_plugin.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\openvino_intel_gpu_plugin.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\openvino_intel_npu_plugin.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\openvino_ir_frontend.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\openvino_onnx_frontend.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\cache.json"),
    (Join-Path $installDir "resources\native\meeting-helper\tbb12.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\tbbbind_2_5.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\tbbmalloc.dll"),
    (Join-Path $installDir "resources\native\meeting-helper\models\modnet.onnx"),
    (Join-Path $installDir "resources\native\vcam-helper\broadify-vcam.dll"),
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

  # Virtual-camera COM registration: the elevated runner registers the
  # packaged DLL, asserts the CLSID (must match
  # native/vcam-helper/windows/vcam_guid.h) landed under HKLM, then cleans up.
  $vcamDllPath = Join-Path $installDir "resources\native\vcam-helper\broadify-vcam.dll"
  $vcamClsidKey = "HKLM:\Software\Classes\CLSID\{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}"
  $vcamRegister = Start-Process regsvr32.exe -ArgumentList @("/s", "`"$vcamDllPath`"") -Wait -PassThru
  if ($vcamRegister.ExitCode -ne 0) {
    throw "regsvr32 /s failed for $vcamDllPath with exit code $($vcamRegister.ExitCode)"
  }
  try {
    if (-not (Test-Path -LiteralPath $vcamClsidKey)) {
      throw "VCam CLSID key missing after regsvr32: $vcamClsidKey"
    }
  } finally {
    $vcamUnregister = Start-Process regsvr32.exe -ArgumentList @("/u", "/s", "`"$vcamDllPath`"") -Wait -PassThru
    if ($vcamUnregister.ExitCode -ne 0) {
      throw "regsvr32 /u /s failed for $vcamDllPath with exit code $($vcamUnregister.ExitCode)"
    }
  }

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
