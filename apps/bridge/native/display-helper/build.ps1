param(
  [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $rootDir "src"
$framebusInclude = Join-Path (Join-Path $rootDir "..") "framebus\include"
$sourceFile = Join-Path $srcDir "display-helper.cpp"
$outFile = Join-Path $rootDir "display-helper.exe"

if (-not (Test-Path $framebusInclude)) {
  throw "FrameBus include not found at $framebusInclude"
}

function Resolve-Sdl2Paths {
  $candidates = @()

  if ($env:SDL2_DIR) {
    $candidates += $env:SDL2_DIR
  }

  if ($env:VCPKG_ROOT) {
    $vcpkgBase = Join-Path $env:VCPKG_ROOT "installed"
    if ($Arch -eq "x64") {
      $candidates += Join-Path $vcpkgBase "x64-windows"
      $candidates += Join-Path $vcpkgBase "x64-windows-static"
    }
  }

  $candidates += "C:\SDL2"

  foreach ($base in $candidates) {
    if (-not $base -or -not (Test-Path $base)) {
      continue
    }

    $includeCandidates = @(
      (Join-Path $base "include"),
      (Join-Path $base "Include")
    )
    $libCandidates = @(
      (Join-Path $base "lib\x64"),
      (Join-Path $base "lib"),
      (Join-Path $base "Lib\x64"),
      (Join-Path $base "Lib")
    )
    $dllCandidates = @(
      (Join-Path $base "bin\SDL2.dll"),
      (Join-Path $base "lib\x64\SDL2.dll"),
      (Join-Path $base "SDL2.dll")
    )

    $includeDir = $includeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    $libDir = $libCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $includeDir -or -not $libDir) {
      continue
    }

    $sdlLib = Join-Path $libDir "SDL2.lib"
    if (-not (Test-Path $sdlLib)) {
      continue
    }

    $dllPath = $dllCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

    $headerIncludeCandidates = @(
      $includeDir,
      (Join-Path $includeDir "SDL2")
    )
    $headerIncludeDir = $headerIncludeCandidates |
      Where-Object { Test-Path (Join-Path $_ "SDL.h") } |
      Select-Object -First 1
    if (-not $headerIncludeDir) {
      continue
    }

    return [PSCustomObject]@{
      BaseDir = $base
      IncludeDir = $includeDir
      HeaderIncludeDir = $headerIncludeDir
      LibDir = $libDir
      Sdl2Lib = $sdlLib
      Sdl2Dll = $dllPath
    }
  }

  return $null
}

$sdl = Resolve-Sdl2Paths
if (-not $sdl) {
  throw "SDL2 not found. Set SDL2_DIR or VCPKG_ROOT so include/lib paths can be resolved."
}

$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $cl) {
  throw "cl.exe not found in PATH. Run from a Visual Studio Developer Command Prompt / PowerShell."
}

$compileArgs = @(
  "/nologo",
  "/std:c++17",
  "/EHsc",
  "/O2",
  "/MD",
  "/I$framebusInclude",
  "/I$($sdl.HeaderIncludeDir)",
  $sourceFile,
  "/link",
  "/OUT:$outFile",
  "/LIBPATH:$($sdl.LibDir)",
  "SDL2.lib",
  "User32.lib",
  "Gdi32.lib",
  "Shell32.lib",
  "Winmm.lib",
  "Imm32.lib",
  "Ole32.lib",
  "OleAut32.lib",
  "Version.lib",
  "Setupapi.lib"
)

Write-Host "[DisplayHelper] Building Windows helper with SDL2 from $($sdl.BaseDir)"
& cl.exe @compileArgs
if ($LASTEXITCODE -ne 0) {
  throw "cl.exe build failed with exit code $LASTEXITCODE"
}

if ($sdl.Sdl2Dll) {
  Copy-Item -Force $sdl.Sdl2Dll (Join-Path $rootDir "SDL2.dll")
  Write-Host "[DisplayHelper] Copied SDL2 runtime DLL to $(Join-Path $rootDir 'SDL2.dll')"
} else {
  Write-Warning "SDL2.dll not found. Helper may fail at runtime unless SDL2 runtime is available via PATH."
}

Write-Host "[DisplayHelper] Built $outFile"
