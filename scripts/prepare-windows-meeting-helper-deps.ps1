param(
  [string]$OnnxRuntimeVersion = "1.24.4",
  [string]$DirectMLVersion = "1.15.4",
  [string]$Destination
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $repoRoot "apps\bridge\native\meeting-helper\deps\onnxruntime\windows-x64"
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
