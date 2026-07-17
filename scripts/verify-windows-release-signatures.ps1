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
  (Join-Path $resolvedDistPath "win-unpacked\resources\native\meeting-helper\onnxruntime.dll")
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
