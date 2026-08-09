param(
  # Must match the vendored deps/onnxruntime VERSION_NUMBER (1.26.0). NOTE:
  # NuGet's Microsoft.ML.OnnxRuntime.DirectML currently tops out at 1.24.4 —
  # the vendored 1.26.0 tree did not come from NuGet, so a fresh download of
  # the default version is expected to fail. The vendored tree in git is the
  # source of truth; this script short-circuits when it is already present.
  [string]$OnnxRuntimeVersion = "1.26.0",
  [string]$DirectMLVersion = "1.15.4",
  [string]$Destination
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $repoRoot "apps\bridge\native\meeting-helper\deps\onnxruntime\windows-x64"
}

# Short-circuit: the deps are vendored in git since v0.23. Re-downloading on
# every CI run is wasteful and breaks outright when the requested version is
# not on NuGet (BlobNotFound for 1.26.0). Skip when the vendored tree already
# matches the requested version and is complete.
$vendoredVersionFile = Join-Path $Destination "VERSION_NUMBER"
if (Test-Path -LiteralPath $vendoredVersionFile -PathType Leaf) {
  $vendoredVersion = (Get-Content -LiteralPath $vendoredVersionFile -Raw).Trim()
  # NOTE: include\DirectML.h is deliberately NOT in this list - the vendored
  # git tree never carried it and the helper build does not need it (the DML
  # EP is reached via dml_provider_factory.h + DirectML.dll). The download
  # path below still provisions it for completeness.
  $vendoredRequiredFiles = @(
    (Join-Path $Destination "include\onnxruntime_cxx_api.h"),
    (Join-Path $Destination "lib\onnxruntime.lib"),
    (Join-Path $Destination "lib\onnxruntime.dll"),
    (Join-Path $Destination "lib\onnxruntime_providers_shared.dll"),
    (Join-Path $Destination "lib\DirectML.dll")
  )
  $missingVendoredFiles = @($vendoredRequiredFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
  if ($vendoredVersion -eq $OnnxRuntimeVersion) {
    if ($missingVendoredFiles.Count -eq 0) {
      Write-Host "ONNX Runtime $OnnxRuntimeVersion already vendored at $Destination - skipping download."
      exit 0
    }
    # Version matches but files are gone: NuGet cannot repair this - the
    # vendored version is not published there, so the download below would
    # die with a misleading BlobNotFound. Fail fast with the real problem.
    throw ("vendored ONNX Runtime tree at $Destination is incomplete (missing: " +
      ($missingVendoredFiles -join ", ") +
      "); restore it from git - version $OnnxRuntimeVersion is not available on NuGet.")
  }
  # Version mismatch: a genuinely different version may exist on NuGet, so
  # keep the re-provisioning fall-through.
  Write-Host "Vendored ONNX Runtime '$vendoredVersion' != '$OnnxRuntimeVersion' - re-provisioning from NuGet."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("broadify-onnxruntime-" + [guid]::NewGuid().ToString("N"))
$onnxPackageId = "microsoft.ml.onnxruntime.directml"
$directMlPackageId = "microsoft.ai.directml"
$onnxPackage = "$onnxPackageId.$OnnxRuntimeVersion"
$directMlPackage = "$directMlPackageId.$DirectMLVersion"
$onnxArchive = Join-Path $tempRoot "$onnxPackage.zip"
$directMlArchive = Join-Path $tempRoot "$directMlPackage.zip"
$onnxRoot = Join-Path $tempRoot $onnxPackage
$directMlRoot = Join-Path $tempRoot $directMlPackage

function Invoke-VerifiedNugetDownload {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath
  )

  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $ArchivePath
  & dotnet nuget verify $ArchivePath --all
  if ($LASTEXITCODE -ne 0) {
    throw "NuGet signature verification failed: $Url"
  }
}

try {
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  Invoke-VerifiedNugetDownload `
    -Url "https://api.nuget.org/v3-flatcontainer/$onnxPackageId/$OnnxRuntimeVersion/$onnxPackage.nupkg" `
    -ArchivePath $onnxArchive
  Invoke-VerifiedNugetDownload `
    -Url "https://api.nuget.org/v3-flatcontainer/$directMlPackageId/$DirectMLVersion/$directMlPackage.nupkg" `
    -ArchivePath $directMlArchive

  Expand-Archive -Path $onnxArchive -DestinationPath $onnxRoot -Force
  Expand-Archive -Path $directMlArchive -DestinationPath $directMlRoot -Force

  if (Test-Path $Destination) {
    Remove-Item -Recurse -Force $Destination
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination "include") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination "lib") | Out-Null

  Copy-Item -Recurse -Force (Join-Path $onnxRoot "build\native\include\*") (Join-Path $Destination "include")
  Copy-Item -Force (Join-Path $onnxRoot "runtimes\win-x64\native\*") (Join-Path $Destination "lib")
  Copy-Item -Force (Join-Path $directMlRoot "include\DirectML.h") (Join-Path $Destination "include\DirectML.h")
  Copy-Item -Force (Join-Path $directMlRoot "bin\x64-win\DirectML.dll") (Join-Path $Destination "lib\DirectML.dll")
  Set-Content -Path (Join-Path $Destination "VERSION_NUMBER") -Value $OnnxRuntimeVersion -NoNewline

  $requiredFiles = @(
    (Join-Path $Destination "include\onnxruntime_cxx_api.h"),
    (Join-Path $Destination "include\DirectML.h"),
    (Join-Path $Destination "lib\onnxruntime.lib"),
    (Join-Path $Destination "lib\onnxruntime.dll"),
    (Join-Path $Destination "lib\onnxruntime_providers_shared.dll"),
    (Join-Path $Destination "lib\DirectML.dll")
  )
  foreach ($path in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Windows meeting-helper dependency is missing: $path"
    }
  }

  Write-Host "Prepared ONNX Runtime DirectML $OnnxRuntimeVersion with DirectML $DirectMLVersion at $Destination"
} finally {
  if (Test-Path $tempRoot) {
    Remove-Item -Recurse -Force $tempRoot
  }
}
