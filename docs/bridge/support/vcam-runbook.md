# Support-Runbook: Virtuelle Kamera („Broadify Camera")

Für Support und Kunden-IT. Stand: VCam-Härtungsprogramm (W1/W2/M1/M2).
Ab diesen Versionen startet die virtuelle Kamera **automatisch mit der
Meeting-Engine** — ein separater „Live test"-Klick ist nicht mehr nötig —
und Fehler erscheinen als verständliche Meldungen mit Fehlercode.

## Windows

### Symptom-Schnellübersicht

| Meldung / Code | Ursache | Lösung |
|---|---|---|
| `vcam_not_registered` (0x80040154) | VCam-Komponente nicht registriert; die automatische Reparatur (Admin-Abfrage) wurde abgelehnt oder blockiert | Bridge neu installieren **oder** VCam-Start erneut auslösen und die Administrator-Abfrage bestätigen |
| `vcam_access_denied` (0x80070005) | Windows verweigert das Anlegen der Kamera | 1) Einstellungen → Datenschutz und Sicherheit → Kamera: „Kamerazugriff" **und** „Desktop-Apps den Zugriff erlauben" einschalten. 2) Auf **Firmengeräten**: Geräteinstallations-Richtlinie — IT-Freigabetext unten verwenden. 3) Geister-Geräte entfernen: Geräte-Manager → ausgeblendete Geräte anzeigen → alte „Broadify Camera"-Einträge deinstallieren → Neustart |
| `vcam_windows11_required` | Windows 10 | Nicht unterstützt — die MF-Virtual-Camera existiert erst ab Windows 11 |
| `vcam_raw_bind_failed` (Port 18787) | Anderer Prozess belegt den Frame-Port | Zweite Bridge-Instanz/Portbelegung beenden, Engine neu starten |
| „Broadify Camera" sichtbar, aber **schwarz** | Normal, solange die Engine kein Programmbild liefert | Engine/Kamera in der Webapp starten; Teams/Zoom nach Kamera-Neuanlage einmal neu starten |

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
# Registrierung vorhanden?
reg query "HKLM\SOFTWARE\Classes\CLSID\{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}" /s
# Frame-Server-Dienste startbar?
sc query FrameServer; sc query FrameServerMonitor
# Blockierte Geräteinstallation? Ereignisanzeige → System → Kernel-PnP/DeviceSetupManager
```

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
