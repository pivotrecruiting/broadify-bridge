param(
  [string]$DistPath = "dist"
)

$ErrorActionPreference = "Stop"

$resolvedDistPath = (Resolve-Path -LiteralPath $DistPath).Path
$signtool = Get-Command signtool -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Source

if (-not $signtool) {
  $candidates = @()
  $candidates += Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue
  $candidates += Get-ChildItem "$env:LOCALAPPDATA\TrustedSigning\Microsoft.Windows.SDK.BuildTools" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue
  $signtool = $candidates |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $signtool) {
  throw "signtool.exe not found on runner (PATH/Windows SDK/TrustedSigning cache)."
}

$files = @(Get-ChildItem -Path $resolvedDistPath -Recurse -Include *.exe,*.msi -File)
$requiredDllPaths = @(
  (Join-Path $resolvedDistPath "win-unpacked\resources\native\display-helper\SDL2.dll"),
  (Join-Path $resolvedDistPath "win-unpacked\resources\native\meeting-helper\onnxruntime.dll"),
  (Join-Path $resolvedDistPath "win-unpacked\resources\native\meeting-helper\onnxruntime_providers_shared.dll"),
  (Join-Path $resolvedDistPath "win-unpacked\resources\native\meeting-helper\DirectML.dll")
)

foreach ($dllPath in $requiredDllPaths) {
  if (-not (Test-Path -LiteralPath $dllPath)) {
    throw "Required signed Windows DLL is missing: $dllPath"
  }
  $files += Get-Item -LiteralPath $dllPath
}

$files = @($files | Sort-Object FullName -Unique)
if ($files.Count -eq 0) {
  throw "No Windows artifacts found in $resolvedDistPath for signature verification."
}

Write-Host "Using signtool: $signtool"
foreach ($file in $files) {
  Write-Host "Verifying signature: $($file.FullName)"
  & $signtool verify /pa /v $file.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Signature verification failed for $($file.FullName) with exit code $LASTEXITCODE."
  }
}

# Microsoft Visual C++ runtime DLLs packaged next to the helpers
# (scripts/lib/windows-vc-runtime.cjs). They ship with Microsoft's Authenticode
# signature and are intentionally NOT in the Broadify re-signing set
# (scripts/sign-windows-native-resources.cjs): each must exist, carry a valid
# signature, and that signature must be Microsoft's.
$vcRuntimeListScript = Join-Path $PSScriptRoot "list-windows-vc-runtime-paths.cjs"
$vcRuntimePaths = @(& node $vcRuntimeListScript)
if ($LASTEXITCODE -ne 0 -or $vcRuntimePaths.Count -eq 0) {
  throw "Unable to resolve the packaged MSVC runtime DLL list from $vcRuntimeListScript."
}
$unpackedResourcesDir = Join-Path $resolvedDistPath "win-unpacked\resources"
foreach ($relativePath in $vcRuntimePaths) {
  $dllPath = Join-Path $unpackedResourcesDir ($relativePath -replace '/', '\')
  if (-not (Test-Path -LiteralPath $dllPath -PathType Leaf)) {
    throw "Required MSVC runtime DLL is missing: $dllPath"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $dllPath
  if ($signature.Status -ne 'Valid') {
    throw "MSVC runtime DLL has no valid Authenticode signature ($($signature.Status)): $dllPath"
  }
  $signerSubject = $signature.SignerCertificate.Subject
  if ($signerSubject -notmatch 'CN=Microsoft Corporation') {
    throw "MSVC runtime DLL is not signed by Microsoft (signer: $signerSubject): $dllPath. The CRT must keep Microsoft's signature and must not be re-signed."
  }
  Write-Host "Verified Microsoft signature: $dllPath"
}
