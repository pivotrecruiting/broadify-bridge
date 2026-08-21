# Support-Runbook: Virtuelle Kamera („Broadify Camera")

Für Support und Kunden-IT. Stand: VCam-Härtungsprogramm (W1/W2/M1/M2) plus
Installer-Fix (per-machine). Ab diesen Versionen startet die virtuelle Kamera
**automatisch mit der Meeting-Engine** — ein separater „Live test"-Klick ist
nicht mehr nötig — und Fehler erscheinen als verständliche Meldungen mit
Fehlercode. Hintergrund/Architektur: `docs/bridge/features/virtual-camera-windows.md`.

## Windows

### Symptom-Schnellübersicht

| Meldung / Code | Ursache | Lösung |
|---|---|---|
| `vcam_not_registered` (0x80040154) | CLSID `{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}` ist nicht in HKLM (64-Bit-View) registriert — **häufigster Fall: Per-User-Installation** (siehe Ursache 1) oder MSI-Installation | Mit dem aktuellen Installer **neu installieren** (fragt einmal nach Adminrechten) **oder** VCam-Start erneut auslösen und die Administrator-Abfrage bestätigen |
| `vcam_access_denied` (0x80070005) | Kamera-Datenschutz für Desktop-Apps aus, **oder** App läuft „als Administrator" bei Per-User-Install, **oder** der registrierte DLL-Pfad liegt im Benutzerprofil, das der Frame-Server (LOCAL SERVICE) nicht lesen darf, **oder** Firmen-Richtlinie | Siehe Ursache 3; auf **Firmengeräten** IT-Freigabetext unten verwenden |
| `vcam_windows11_required` | Windows 10 | Nicht unterstützt — die MF-Virtual-Camera existiert erst ab Windows 11 |
| `vcam_raw_bind_failed` (Port 18787) | Anderer Prozess belegt den Frame-Port | Zweite Bridge-Instanz/Portbelegung beenden, Engine neu starten |
| `helper_not_reachable` / `helper_control_channel_lost` | Steuerkanal zum Meeting-Helper nicht erreichbar; die Bridge startet den Helper nach wiederholtem Ausfall selbst neu | Engine neu starten; bleibt es, Bridge-Log mit `control_pipe_*`-Zeilen beilegen |
| „Broadify Camera" sichtbar, aber **schwarz** | Normal, solange die Engine kein Programmbild liefert | Engine/Kamera in der Webapp starten; Teams/Zoom nach Kamera-Neuanlage einmal neu starten |

### Ursache 1 (häufigster Kundenfall): Per-User-Installation

Installer vor `nsis.perMachine: true` boten „Nur für mich" an. Diese
Installation lief **ohne Elevation**, `regsvr32` nach HKLM scheiterte still,
der Installer meldete trotzdem Erfolg. Erkennung (Admin-PowerShell):

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
`C:\Program Files\BroadifyBridge`). Auto-Update migriert eine Per-User-
Installation **nicht**.

### Ursache 2: Registrierung fehlt oder ist veraltet

```powershell
reg query "HKLM\SOFTWARE\Classes\CLSID\{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}\InprocServer32" /ve /reg:64
```

- Kein Schlüssel → nicht registriert (MSI-Installation, alte Per-User-Installation).
- Schlüssel zeigt auf eine nicht existierende Datei → veraltet (Pfad gewechselt,
  Reste einer alten Installation).

Die Bridge prüft die Registrierung selbst (sprachunabhängig: Typ-Token
`REG_SZ`/`REG_EXPAND_SZ` + Exit-Code, nicht das lokalisierte `(Standard)`)
und versucht beides **höchstens einmal pro Installation** zu heilen
(UAC-Prompt) – und zwar **nur** beim expliziten Kamera-Start durch den
Operator, **nie** beim automatischen Arm mit dem Engine-Start. Der Versuch
wird in `<userDataDir>\vcam-self-heal.json` festgehalten; solange ein
fehlgeschlagener Versuch für dieselbe Version/DLL dort steht, erscheint kein
weiterer Prompt (Datei löschen oder App-Update = ein neuer Versuch). Wird der
Prompt abgelehnt oder bleibt die Registrierung danach leer, steht im Log die
Diagnose `vcam_not_registered`, die rohe `reg.exe`-Ausgabe und das manuelle
Kommando:

```powershell
# Admin-PowerShell
regsvr32 "C:\Program Files\BroadifyBridge\resources\native\vcam-helper\broadify-vcam.dll"
```

### Setup-Protokoll lesen („Details"-Bereich)

Im Setup-Fenster „Details anzeigen" (oder das Installer-Log bei `/S`):

```
Registering Broadify virtual camera (broadify-vcam.dll)
regsvr32 exit code: 0
```

`regsvr32 exit code: 3` = DLL nicht ladbar (fehlende Datei/Abhängigkeit,
falsche Bitness), `5` = `DllRegisterServer` fehlgeschlagen (keine Elevation).
Der Installer setzt dann Error-Level 3 und zeigt eine Meldung, installiert
die App aber vollständig.

### Ursache 3: 0x80070005 trotz korrekter Registrierung

1. Windows-Einstellungen → Datenschutz und Sicherheit → Kamera: „Kamerazugriff"
   **und** „Desktop-Apps den Zugriff auf die Kamera erlauben" einschalten.
2. Bridge **nicht** „als Administrator" starten.
3. Registrierter Pfad (siehe Ursache 2) muss unter `C:\Program Files\...`
   liegen — nicht unter `C:\Users\...`.
4. Geister-Geräte entfernen: Geräte-Manager → ausgeblendete Geräte anzeigen →
   alte „Broadify Camera"-Einträge deinstallieren → Neustart.
5. Firmengerät: Geräteinstallations-Richtlinie — IT-Freigabetext unten.

### IT-Freigabetext (verwaltete Firmengeräte)

> Unsere Anwendung Broadify Bridge legt eine virtuelle Windows-11-Kamera an
> (Media-Foundation-VCam, `MFCreateVirtualCamera`, Session-Lifetime). Auf dem
> Gerät schlägt die Geräteaktivierung mit `E_ACCESSDENIED (0x80070005)` fehl,
> obwohl Kamerazugriff für Desktop-Apps erlaubt ist und die COM-Komponente
> registriert wurde. Bitte prüft, ob eine Geräteinstallations-Einschränkung
> (GPO „Geräteinstallation einschränken" / Intune Device Control) das Anlegen
> von Software-Geräten (SWD-Bus, Geräteklasse „Kamera") blockiert, und gebt
> diese für unsere Anwendung frei.

### Diagnose-Kommandos (Admin-PowerShell)

```powershell
# Registrierung vorhanden? (64-Bit-View)
reg query "HKLM\SOFTWARE\Classes\CLSID\{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}" /s /reg:64
# Frame-Server-Dienste startbar?
sc query FrameServer; sc query FrameServerMonitor
# Blockierte Geräteinstallation? Ereignisanzeige → System → Kernel-PnP/DeviceSetupManager
```

### Checkliste vor Eskalation (Windows)

- Windows 11? (`winver`)
- `reg query HKCU\Software\com.broadify.bridge` leer, `HKLM` gesetzt?
- InprocServer32-Pfad existiert und liegt unter Program Files?
- Bridge-Log: Zeilen mit `[Meeting] VCam` (Probe-Ergebnis, regsvr32-Exit-Code,
  rohe `reg.exe`-Ausgabe nach einem fehlgeschlagenen Heal).
- `<userDataDir>\vcam-self-heal.json` vorhanden? Dann wurde der eine Prompt
  bereits verbraucht – Inhalt (Version, Pfad, Zeitpunkt) in die Eskalation.

## macOS

### Der normale Ablauf (seit v19)

1. Engine-Start → Bridge startet `BroadifyVCam.app` mit `--activate` — die
   Freigabe-Anfrage wird **automatisch** gestellt.
2. Beim ersten Mal verlangt macOS eine Freigabe: **Systemeinstellungen →
   Allgemein → Anmeldeobjekte & Erweiterungen → Kamera-Erweiterungen →
   „broadify Virtual Camera" aktivieren.** Die Webapp zeigt genau diesen
   Hinweis an, solange die Freigabe fehlt.
3. Nach der Freigabe meldet die Bridge `activation_completed`; bei künftigen
   Updates ersetzt macOS die Erweiterung ohne weitere Klicks.

### Wenn kein Dialog erscheint / Kamera fehlt

| Code / Symptom | Ursache | Lösung |
|---|---|---|
| `user_activation_required` | Freigabe steht aus (der macOS-Dialog erscheint systembedingt nicht immer) | Manuell freigeben: Systemeinstellungen → Allgemein → Anmeldeobjekte & Erweiterungen → Kamera-Erweiterungen |
| `helper_app_not_in_applications` | App läuft nicht aus /Programme (macOS-Pflicht) | BroadifyVCam.app nach /Programme bewegen, von dort starten |
| `helper_app_quarantined` | Gatekeeper-Quarantäne (ältere Installationen) | VCam-Start erneut auslösen — die Bridge repariert das seitdem automatisch |
| `reboot_required` | Alte Deinstallation wartet auf Neustart | Mac neu starten, dann erneut aktivieren |
| Kamera fehlt in Teams/Zoom trotz „aktiv" | App-Kamera-Cache | Die jeweilige App (Teams/Zoom/Browser) neu starten |

### Diagnose-Kommandos (Terminal)

```bash
systemextensionsctl list | grep broadify     # Zustand der Erweiterung
ls /Applications | grep BroadifyVCam         # Genau EINE Kopie erwartet
```

Erwarteter guter Zustand: `[activated enabled]` in der eigenen Zeile.
`[activated waiting for user]` = Freigabe fehlt (siehe oben).

## Eskalation

Wenn keiner der Punkte greift: Bridge-Log beilegen (Hilfe → Logs bzw.
`logs/bridge.log` im Profilordner) — seit dem Härtungsprogramm enthalten
alle VCam-Fehler dort Fehlercode + Original-Systemcode.
