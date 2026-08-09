param(
  # OpenVINO release folder on storage.openvinotoolkit.org and the full build
  # id embedded in the archive name. 2025.4 is the current LTS line; 2025.4.2
  # is its latest patch release. Listing of all releases:
  # https://storage.openvinotoolkit.org/repositories/openvino/packages/
  [string]$OpenVinoVersion = "2025.4.2",
  [string]$OpenVinoBuild = "2025.4.2.20430.85e49f27be1",
  # SHA256 of the pinned archive. The upstream value is published next to the
  # archive as openvino_toolkit_windows_<build>_x86_64.zip.sha256; this pin
  # was verified against an independent download on 2026-08-08. Bumping the
  # version REQUIRES updating this hash from the matching .sha256 file.
  [string]$OpenVinoSha256 = "466cee7781f744cead50925f5bfc14847bdad09897735725590d419677970968",
  [string]$Destination
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OpenVinoSha256)) {
  throw "OpenVinoSha256 must not be empty: an unverifiable OpenVINO archive must never be vendored."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $repoRoot "apps\bridge\native\meeting-helper\deps\openvino\windows-x64"
}

$archiveName = "openvino_toolkit_windows_${OpenVinoBuild}_x86_64.zip"
$archiveUrl = "https://storage.openvinotoolkit.org/repositories/openvino/packages/$OpenVinoVersion/windows/$archiveName"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("broadify-openvino-" + [guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $tempRoot $archiveName
$extractRoot = Join-Path $tempRoot "extracted"
# The archive nests everything under a folder named after the build id.
$runtimeRoot = Join-Path (Join-Path $extractRoot "openvino_toolkit_windows_${OpenVinoBuild}_x86_64") "runtime"

# Runtime file set the helper needs, shipped next to meeting-helper.exe (keep
# in sync with build.ps1, electron-builder.config.cjs,
# scripts/sign-windows-native-resources.cjs and the smoke tests):
# - openvino.dll: the runtime core (the only DLL the helper links against).
# - openvino_onnx_frontend.dll / openvino_ir_frontend.dll: read modnet.onnx
#   respectively the optional INT8 IR (modnet-ov-int8.xml/.bin).
# - openvino_intel_{cpu,gpu,npu}_plugin.dll + openvino_auto_plugin.dll (and
#   its hetero/auto-batch companions): device plugins, discovered by name
#   next to openvino.dll (modern OpenVINO has no plugins.xml anymore).
# - cache.json: plugin configuration shipped alongside the plugins.
# - tbb12/tbbmalloc/tbbbind_2_5: the TBB threading runtime OpenVINO links.
$binFiles = @(
  "openvino.dll",
  "openvino_auto_batch_plugin.dll",
  "openvino_auto_plugin.dll",
  "openvino_hetero_plugin.dll",
  "openvino_intel_cpu_plugin.dll",
  "openvino_intel_gpu_plugin.dll",
  "openvino_intel_npu_plugin.dll",
  "openvino_ir_frontend.dll",
  "openvino_onnx_frontend.dll",
  "cache.json"
)
$tbbFiles = @(
  "tbb12.dll",
  "tbbbind_2_5.dll",
  "tbbmalloc.dll"
)

try {
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

  Write-Host "Downloading $archiveUrl"
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath

  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
  if ($actualHash -ne $OpenVinoSha256.ToLowerInvariant()) {
    throw "OpenVINO archive SHA256 mismatch for ${archiveName}: expected $OpenVinoSha256, got $actualHash"
  }
  Write-Host "OpenVINO archive SHA256 verified -> $actualHash"

  Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force

  if (Test-Path $Destination) {
    Remove-Item -Recurse -Force $Destination
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination "include") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination "lib") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination "bin") | Out-Null

  Copy-Item -Recurse -Force (Join-Path $runtimeRoot "include\*") (Join-Path $Destination "include")
  Copy-Item -Force (Join-Path $runtimeRoot "lib\intel64\Release\openvino.lib") (Join-Path $Destination "lib\openvino.lib")
  foreach ($file in $binFiles) {
    Copy-Item -Force (Join-Path $runtimeRoot "bin\intel64\Release\$file") (Join-Path $Destination "bin\$file")
  }
  foreach ($file in $tbbFiles) {
    Copy-Item -Force (Join-Path $runtimeRoot "3rdparty\tbb\bin\$file") (Join-Path $Destination "bin\$file")
  }
  Set-Content -Path (Join-Path $Destination "VERSION_NUMBER") -Value $OpenVinoVersion -NoNewline

  $requiredFiles = @(
    (Join-Path $Destination "include\openvino\openvino.hpp"),
    (Join-Path $Destination "lib\openvino.lib")
  )
  foreach ($file in ($binFiles + $tbbFiles)) {
    $requiredFiles += (Join-Path $Destination "bin\$file")
  }
  foreach ($path in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Windows meeting-helper OpenVINO dependency is missing: $path"
    }
  }

  Write-Host "Prepared OpenVINO $OpenVinoVersion ($OpenVinoBuild) at $Destination"
} finally {
  if (Test-Path $tempRoot) {
    Remove-Item -Recurse -Force $tempRoot
  }
}
