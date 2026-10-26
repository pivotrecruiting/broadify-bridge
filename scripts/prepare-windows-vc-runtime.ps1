param(
  # Visual Studio redistributable root, e.g.
  # C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Redist\MSVC\14.44.35112\
  # Defaults to $env:VCToolsRedistDir (set by vcvars / ilammy/msvc-dev-cmd),
  # then to the newest redist folder of the latest Visual Studio via vswhere.
  [string]$RedistDir,
  # Staging folder consumed by electron-builder.config.cjs (gitignored).
  [string]$Destination
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $repoRoot "build\windows-vc-runtime"
}

# DLL set from the Node single source of truth (scripts/lib/windows-vc-runtime.cjs).
$listScript = Join-Path $PSScriptRoot "list-windows-vc-runtime-paths.cjs"
$dlls = @(& node $listScript --dlls)
if ($LASTEXITCODE -ne 0 -or $dlls.Count -eq 0) {
  throw "Unable to resolve the MSVC runtime DLL list from $listScript."
}

function Resolve-VcRedistDir {
  param([string]$Explicit)

  if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
    return $Explicit
  }
  if (-not [string]::IsNullOrWhiteSpace($env:VCToolsRedistDir)) {
    return $env:VCToolsRedistDir
  }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "VCToolsRedistDir is not set and vswhere.exe was not found at $vswhere. Run from a Visual Studio developer prompt or pass -RedistDir."
  }
  $installationPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installationPath)) {
    throw "vswhere did not find a Visual Studio installation with the x64 C++ toolset."
  }

  $redistRoot = Join-Path $installationPath "VC\Redist\MSVC"
  $candidates = @(
    Get-ChildItem -LiteralPath $redistRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^\d+(\.\d+)+$' } |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "x64\Microsoft.VC143.CRT") -PathType Container } |
      Sort-Object { [version]$_.Name } -Descending
  )
  if ($candidates.Count -eq 0) {
    throw "No redistributable folder with x64\Microsoft.VC143.CRT found under $redistRoot."
  }
  return $candidates[0].FullName
}

$resolvedRedistDir = Resolve-VcRedistDir -Explicit $RedistDir
$crtDir = Join-Path $resolvedRedistDir "x64\Microsoft.VC143.CRT"
if (-not (Test-Path -LiteralPath $crtDir -PathType Container)) {
  throw "MSVC runtime folder not found: $crtDir (set VCToolsRedistDir or pass -RedistDir)."
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
# Only the current set may be staged: electron-builder copies the folder
# filtered by this list, and the release artifact check requires every file.
Get-ChildItem -LiteralPath $Destination -File | Remove-Item -Force

# Fail closed: a missing runtime file would otherwise surface as
# STATUS_DLL_NOT_FOUND (0xC0000135) on customer PCs instead of here.
foreach ($dll in $dlls) {
  $sourcePath = Join-Path $crtDir $dll
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "MSVC runtime file not found: $sourcePath (expected in the Microsoft.VC143.CRT redistributable folder)."
  }
  $targetPath = Join-Path $Destination $dll
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
  if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf) -or (Get-Item -LiteralPath $targetPath).Length -le 0) {
    throw "Failed to stage a non-empty MSVC runtime file at $targetPath."
  }
}

Write-Host "[VcRuntime] Staged $($dlls.Count) MSVC runtime DLLs from $crtDir -> $Destination"
