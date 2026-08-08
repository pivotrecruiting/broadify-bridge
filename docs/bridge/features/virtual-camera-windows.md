# Virtuelle Kamera auf Windows („Broadify Camera")

Endnutzer- und Support-Dokumentation für die Windows-Virtual-Camera. Der
Meeting-Helper erzeugt die Kamera zur Laufzeit über `MFCreateVirtualCamera`
(Windows 11); die Media-Source-DLL `broadify-vcam.dll` muss dafür im
System-COM-Registry registriert sein.

## Registrierung bei der Installation

- **NSIS-Installer (Standard):** registriert `broadify-vcam.dll` bei jeder
  Installation/jedem Update per `regsvr32 /s` (siehe
  `build/windows-installer.nsh`) und deregistriert bei der Deinstallation.
  Voraussetzung ist eine Per-Machine-Installation („alle Benutzer"), weil
  `regsvr32` nach HKLM schreibt.
- **MSI-Paket:** registriert **nichts** – electron-builder führt die
  NSIS-Custom-Macros im MSI-Target nicht aus. Nach einer MSI-Installation
  (oder einer Per-User-/gehärteten Installation ohne Elevation) schlägt
  `output.vcam.start` mit `REGDB_E_CLASSNOTREG` (`0x80040154`) fehl.

## Self-Heal in der Bridge (einmal pro Session)

Scheitert `output.vcam.start` mit `0x80040154`, versucht die Bridge genau
einmal pro Bridge-Session eine Selbstheilung
(`apps/bridge/src/services/meeting/vcam-registration-self-heal.ts`):

1. Elevierter `regsvr32 /s <resources>\native\vcam-helper\broadify-vcam.dll`
   über `Start-Process -Verb RunAs` → ein UAC-Prompt für den Operator.
2. Ein einziger Retry von `output.vcam.start`.

Wird die Elevation abgelehnt oder schlägt sie fehl, loggt die Bridge das
manuelle Admin-Kommando und liefert den ursprünglichen Fehler aus. Es gibt
keine Wiederholungsschleife.

## Manueller Fallback (Admin-Konsole)

```powershell
regsvr32 /s "C:\Program Files\Broadify Bridge\resources\native\vcam-helper\broadify-vcam.dll"
```

Danach die virtuelle Kamera in der Bridge erneut starten. Prüfung, ob die
CLSID registriert ist (GUID aus `native/vcam-helper/windows/vcam_guid.h`):

```powershell
Test-Path "HKLM:\Software\Classes\CLSID\{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}"
```

Der MSI-Smoke-Test (`scripts/smoke-test-windows-msi.ps1`) verifiziert die
Registrierbarkeit der paketierten DLL genau über diesen Weg.
