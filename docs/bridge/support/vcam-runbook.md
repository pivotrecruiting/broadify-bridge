# Runbook: „Broadify Camera" fehlt / startet nicht (Windows)

Support-Ablauf für Kundenmeldungen rund um die Windows-Virtual-Camera.
Hintergrund und Architektur: `docs/bridge/features/virtual-camera-windows.md`.

## Symptome und Fehlercodes

| Fehlertext im Bridge-Log | Bedeutung |
|---|---|
| `IMFVirtualCamera::Start failed 0x80040154` / `REGDB_E_CLASSNOTREG` | CLSID `{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}` ist nicht in HKLM (64-Bit-View) registriert. |
| `... 0x80070005` (E_ACCESSDENIED) | Kamera-Datenschutz für Desktop-Apps aus, **oder** App läuft erhöht bei Per-User-Install, **oder** der registrierte DLL-Pfad liegt in einem Benutzerprofil, das der Frame-Server (LOCAL SERVICE) nicht lesen darf. |
| `MFCreateVirtualCamera is not available` | Windows 10 – nicht unterstützt. |

## Ursache 1 (häufigster Kundenfall): Per-User-Installation

Installer vor `nsis.perMachine: true` boten „Nur für mich" an. Diese
Installation läuft **ohne Elevation**, `regsvr32` nach HKLM scheiterte
still, der Installer meldete Erfolg. Erkennung:

```powershell
# Per-User-Install vorhanden? (Installationspfad unter %LOCALAPPDATA%)
reg query HKCU\Software\com.broadify.bridge
reg query HKCU\Software\com.broadify.bridge.rc   # RC-Kanal

# Per-Machine-Install vorhanden?
reg query HKLM\Software\com.broadify.bridge
```

Zeigt `HKCU` einen `InstallLocation` unter `C:\Users\<name>\AppData\Local\Programs\...`,
ist es eine Per-User-Installation. **Abhilfe:** deinstallieren und mit dem
aktuellen Installer neu installieren (fragt einmal nach Adminrechten, Ziel
`C:\Program Files\BroadifyBridge`).

## Ursache 2: Registrierung fehlt oder ist veraltet

```powershell
reg query "HKLM\SOFTWARE\Classes\CLSID\{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}\InprocServer32" /ve /reg:64
```

- Kein Schlüssel → nicht registriert (MSI-Installation, alte Per-User-Installation).
- Schlüssel zeigt auf eine nicht existierende Datei → veraltet (Pfad gewechselt,
  Reste einer alten Installation).

Die Bridge versucht beides **einmal pro Session** selbst zu heilen (UAC-Prompt).
Wird der Prompt abgelehnt, steht im Log das manuelle Kommando:

```powershell
# Admin-PowerShell
regsvr32 "C:\Program Files\BroadifyBridge\resources\native\vcam-helper\broadify-vcam.dll"
```

## Setup-Protokoll lesen („Details"-Bereich)

Im Setup-Fenster „Details anzeigen" (oder das Installer-Log bei `/S`):

```
Registering Broadify virtual camera (broadify-vcam.dll)
regsvr32 exit code: 0
```

`regsvr32 exit code: 3` = DLL nicht ladbar (fehlende Datei/Abhängigkeit,
falsche Bitness), `5` = `DllRegisterServer` fehlgeschlagen (keine Elevation).
Der Installer setzt dann Error-Level 3, installiert die App aber vollständig.

## Ursache 3: 0x80070005 trotz korrekter Registrierung

1. Windows-Einstellungen → Datenschutz → Kamera → „Desktop-Apps den Zugriff
   auf die Kamera erlauben" einschalten.
2. Bridge **nicht** „als Administrator" starten.
3. Registrierter Pfad (siehe Ursache 2) muss unter `C:\Program Files\...`
   liegen – nicht unter `C:\Users\...`.

## Checkliste vor Eskalation

- Windows 11? (`winver`)
- `reg query HKCU\Software\com.broadify.bridge` leer, `HKLM` gesetzt?
- InprocServer32-Pfad existiert und liegt unter Program Files?
- Bridge-Log: Zeilen mit `[Meeting] VCam` (Probe-Ergebnis, regsvr32-Exit-Code).
