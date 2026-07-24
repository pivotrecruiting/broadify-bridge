# Deploys the Broadify virtual-camera media source to a stable location and
# registers it with COM so the Windows Frame Server can load it.
#
# MUST run from an elevated (Administrator) PowerShell: the Frame Server
# resolves the CLSID from HKEY_LOCAL_MACHINE, so registration needs admin.
#
# Register / refresh after a rebuild:
#   .\deploy-vcam.ps1 -SourceDll <path-to-built\broadify-vcam.dll>
# Unregister (clean rollback):
#   .\deploy-vcam.ps1 -Unregister
#
# Re-run the register path on EVERY DLL rebuild. It first unregisters the
# installed copy, then copies the new DLL, then registers it. Skipping this
# leaves the Frame Server bound to the previously registered file (a classic
# "my changes don't show up" trap).
param(
  [string]$SourceDll,
  [switch]$Unregister,
  [string]$InstallDir = "C:\dev\broadify-vcam"
)

$ErrorActionPreference = "Stop"
$target = Join-Path $InstallDir "broadify-vcam.dll"

# Always unregister the currently installed copy first (ignored if absent).
if (Test-Path $target) {
  Start-Process regsvr32 -ArgumentList "/u", "/s", "`"$target`"" -Wait
  Write-Host "Unregistered $target"
}

if ($Unregister) {
  return
}

if (-not $SourceDll -or -not (Test-Path $SourceDll)) {
  throw "Provide -SourceDll <path to the built broadify-vcam.dll>"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $SourceDll $target
Start-Process regsvr32 -ArgumentList "/s", "`"$target`"" -Wait
Write-Host "Registered $target"
