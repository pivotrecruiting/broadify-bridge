# Virtuelle Kamera auf Windows („Broadify Camera")

Endnutzer- und Support-Dokumentation für die Windows-Virtual-Camera. Der
Meeting-Helper erzeugt die Kamera zur Laufzeit über `MFCreateVirtualCamera`
(Windows 11); die Media-Source-DLL `broadify-vcam.dll` muss dafür im
System-COM-Registry registriert sein.

## Frame-Pfad und Transport-Auswahl

Default ab WP4 ist Shared Memory: der Meeting-Helper legt beim Armieren von
`output.vcam.raw.start` eine globale Ring-Mapping an
(`Global\BroadifyVcam-<pid>-<tick>`) und publiziert den aktuellen Namen in
`Global\BroadifyVcamControl`. Die ACL erlaubt dem Windows Frame Server
(`NT AUTHORITY\LOCAL SERVICE`) Lesezugriff. Die DLL oeffnet diese Control-
Mapping ohne Sleep in `MediaSource::Initialize`, uebernimmt die Geometrie
falls vorhanden und faellt sonst sofort auf **1920x1080@30** zurueck. Es gibt
keine TCP-Geometrie-Probe mehr; Kamera-Enumeration in Teams blockiert nicht
auf einen nicht erreichbaren Helper.

Transport-Auswahl:

- `BROADIFY_MEETING_VCAM_TRANSPORT=shm` oder unset: SHM ist Default auf
  Windows.
- `BROADIFY_MEETING_VCAM_TRANSPORT=tcp`: alter Raw-TCP-Pfad
  (`127.0.0.1:18787`) bleibt fuer eine Release als Rollback erhalten.
- Kann der Helper keine globale Mapping mit ACL erstellen, schaltet er
  automatisch auf TCP und loggt
  `meeting_vcam_raw event=vcam_transport_selected transport=tcp`.
- `output.vcam.status` enthaelt `transport: "shm"|"tcp"`.

Der SHM-Ring hat drei Slots. Jeder Slot nutzt eine Sequenznummer als seqlock:
ungerade bedeutet "Writer schreibt gerade", Leser kopieren nur den neuesten
geraden Slot und pruefen die Sequenz nach dem Copy erneut. WP4 schreibt
BGRA8; das Layout enthaelt bereits `format=NV12` fuer den spaeteren
Compositor-Ausgang. Die DLL bietet NV12 zuerst an, danach RGB32 und YUY2.

Die DLL startet den SHM-Reader erst in `MediaStream::Start`. TCP verbindet sie
nur, wenn die SHM-Mapping fehlt oder der Heartbeat laenger als ca. 3 s steht;
danach prueft sie periodisch wieder auf SHM. Bei gesunder SHM-Verbindung gibt
es keinen TCP-Client und damit keine per-Connection-Worker-Churn im Helper.
Direkt nach Stream-Start liefert `RequestSample` bis zum ersten Frame den
dunklen Splash. Sobald einmal ein gueltiger Frame angekommen ist, wird nie
wieder auf den Splash umgeschaltet: bei Staleness, statischem Programm oder
Groessenabweichung bleibt der letzte gute Frame sichtbar.

### TCP-Fallback und Geometrie-Handshake

Der Raw-Frame-Server des Helpers (`raw_frame_server.cpp`) bleibt fuer
Rollback/Fallback erhalten. Er sendet in den
HTTP-Antwort-Headern vor dem ersten BFRG-Record die konfigurierte
Programmgeometrie:

```
X-Broadify-Frame-Width: 1920
X-Broadify-Frame-Height: 1080
X-Broadify-Frame-Fps: 30
```

Die Werte entsprechen `--width/--height/--fps` bzw. `MEETING_FRAME_*` des
Helpers (`buildRawFrameStreamHeader`, Unit-Test
`raw_frame_stream_header_test`). Die macOS-Extension
(`RawFrameStreamReader.swift`) liest nur `200 OK` und die Leerzeile und
ignoriert die Zusatz-Header. Auf Windows ist die Geometrie im Normalfall aus
der SHM-Control-Mapping bekannt; der TCP-Handshake ist nur noch Fallback.

Weicht die Groesse eines Frames trotzdem vom
ausgehandelten Media Type ab, zeigt `MediaStream::RequestSample` **kein**
graues Splash-Bild mehr, sondern skaliert den Frame per Nearest-Neighbour
(einfaches Strecken, kein Letterbox) in den Sample-Puffer. Der Mismatch wird
einmal pro Groessenwechsel geloggt
(`MediaStream: source WxH differs from media type WxH, scaling`). Staleness
loggt nach ca. 2 s und 10 s ohne neuen Frame, liefert aber weiter den letzten
guten Sample-Puffer. Das dunkle Splash bleibt nur fuer „noch nie ein Frame auf
dieser Verbindung empfangen"; fehlerhafte Payloads (Groesse passt nicht zu
Breite x Hoehe x 4) werden verworfen, ohne den letzten guten Frame zu ersetzen.

Symptom vor WP4: „Broadify Camera" in Teams waehlbar, aber dauerhaft grau
oder sehr langsame Teams-Kameraauswahl — der TCP-Pfad war nicht erreichbar
und die DLL blockierte in der Aktivierung auf ihre Probe.

Der Helper-FrameBus (`output.framebus.*`) ist davon entkoppelt: er wird nur
noch vom Conference-Display-Output gestartet, nicht mehr vom VCam-Start. Der
Raw-Frame-Stream wird ueber `output.vcam.raw.start/stop` armiert, das die
Bridge in `virtualCameraStart()`/`virtualCameraStop()` aufruft. Ohne
streamende App sieht der Helper keinen VCam-Client; Keyer-Qualitaet und
Luefter entsprechen dann dem Zustand „VCam-Output gestoppt".

Log-Zeilen (`VcamLog`): `build git=... time=...` steht am Anfang jeder
Log-Datei. `MediaSource::Initialize ... (no activation probe)` bestaetigt den
WP4-Pfad. `vcam_reader_transport tcp reason=...` markiert Fallback,
`vcam_reader_transport shm reason=shm_frame_available` die Rueckkehr.

## Stream-Lifecycle und Timeouts

Die DLL setzt vor `connect()` `SO_RCVTIMEO`, `SO_SNDTIMEO` und `SO_KEEPALIVE`
auf dem Raw-Frame-Socket. Ein nicht abgeschlossener Handshake oder ein
blockierender Frame-Read endet nach ca. 5 s als Disconnect mit
`WSAGetLastError()` im Log; danach verbindet der Client mit Backoff neu.
Jeder COM-Einstieg der Media-Stream-Seite faengt C++-Exceptions ab und gibt
`E_FAIL` zurueck, damit der Windows Frame Server nicht durch eine aus der DLL
entweichende Exception beendet wird.

Der Helper akzeptiert Raw-Frame-Clients nicht mehr inline im Listener, sondern
startet pro Client einen eigenen Worker. Ein langsamer oder geleakter Consumer
kann dadurch weder `accept()` noch andere Consumers blockieren. Auf Windows
bindet der Listener mit `SO_EXCLUSIVEADDRUSE`; ein belegter Port meldet
`vcam_raw_bind_failed`, die Bridge bricht den Engine-Start dann ab statt in
einen unbrauchbaren Running-State zu gehen. Pro Client gilt ein 2-s-Sendtimeout,
und der Worker prueft mit `select`/`recv(MSG_PEEK)`, ob der Peer geschlossen
hat.

Wenn das Programm statisch ist, sendet der Helper den zuletzt gecachten
Raw-Frame mindestens alle ca. 1000 ms erneut und vergibt dafuer eine neue
Sequenznummer. Dadurch bleibt die DLL frisch, auch wenn sich im Bild nichts
aendert.

Seit WP1 nutzt der Raw-Frame-Record `BFRG` Header-Version 2. Version 1
(`32` Byte) bleibt lesbar; Version 2 (`40` Byte) fuegt nach der Sequenznummer
ein `capture_ns`-Feld an. Die DLL setzt `IMFSample::SetSampleTime` aus diesem
Produzenten-Zeitstempel, auf die Media-Foundation-Zeitbasis umgerechnet.
Wird ein duplizierter Frame erneut ausgeliefert, erhaelt er den vorherigen
Sample-Zeitstempel plus eine Frame-Dauer. Das stabilisiert A/V-Sync und
reduziert sichtbare Latenzspruenge in Teams/Meet.

Der Raw-Frame-Server sendet nur, wenn ein VCam-Client verbunden ist. MJPEG
Preview-Encoding laeuft nur fuer verbundene MJPEG-Clients und wird bei aktiver
VCam auf 10 fps begrenzt, damit die Raw-Frame-Ausgabe Vorrang hat.

Seit rc.18 field-fix liest der D3D11-Guided-Refine-Pfad die aktuelle Maske
zurueck; der finale D3D11-Staging-Ring ist nur mit
`BROADIFY_MEETING_STAGING_RING=1` aktiv. Fuer Hybrid-GPU-A/B-Tests gibt es
`BROADIFY_MEETING_GPU_POLICY=split` (Compositor Default-Adapter, DirectML
High-Performance); `auto` bleibt der gemeinsame Adapterpfad.

## Registrierung bei der Installation

- **NSIS-Installer (Standard):** ist seit `nsis.perMachine: true`
  (`electron-builder.json`) eine **Per-Machine-Installation** („alle
  Benutzer", `%ProgramFiles%\BroadifyBridge`). Die Installation fragt deshalb
  **einmal nach Administratorrechten** (UAC). Sie registriert
  `broadify-vcam.dll` bei jeder Installation/jedem Update per
  `regsvr32 /s` (64-Bit-View, siehe `build/windows-installer.nsh`). Der
  Exit-Code von `regsvr32` wird geprüft: bei einem Fehler erscheint im
  „Details"-Bereich des Setups `regsvr32 exit code: N`, der Installer setzt
  Error-Level 3 und zeigt (nicht-silent) eine Meldung mit dem manuellen
  Admin-Kommando. Die App selbst wird trotzdem vollständig installiert.
- **Deinstallation:** entfernt den CLSID-Schlüssel direkt aus HKLM
  (`DeleteRegKey`), weil die DLL zu diesem Zeitpunkt bereits gelöscht ist
  und `regsvr32 /u` daher nicht mehr funktionieren kann.
- **Auto-Update (electron-updater):** eine Per-Machine-Installation wird
  über `elevate.exe` (`packElevateHelper: true`) erhöht aktualisiert, damit
  das stille Update die Registrierung erneuern kann.
- **Frühere Per-User-Installationen** („Nur für mich",
  `%LOCALAPPDATA%\Programs\BroadifyBridge`) konnten nicht nach HKLM
  schreiben; der Installer meldete trotzdem Erfolg. Das war die Ursache der
  Kundenfälle mit `0x80040154` (und teils `0x80070005`, weil der
  Frame-Server als LOCAL SERVICE keine DLL aus einem Benutzerprofil laden
  kann). Abhilfe: mit dem aktuellen Installer neu installieren.
- **MSI-Paket:** registriert **nichts** – electron-builder führt die
  NSIS-Custom-Macros im MSI-Target nicht aus. Nach einer MSI-Installation
  schlägt `output.vcam.start` mit `REGDB_E_CLASSNOTREG` (`0x80040154`) fehl,
  bis die DLL manuell oder per Self-Heal registriert wurde.

## Self-Heal in der Bridge (höchstens ein UAC-Prompt pro Installation)

Scheitert `output.vcam.start` (Windows), prüft die Bridge zuerst die
Registrierung per
`reg query HKLM\SOFTWARE\Classes\CLSID\{8B1E9E3A-…}\InprocServer32 /ve /reg:64`
(`apps/bridge/src/services/meeting/vcam-registration-self-heal.ts`).

### Probe (sprachunabhängig)

`reg.exe` lokalisiert sowohl das Wertelabel (`(Default)` / `(Standard)` /
`(Par défaut)`) als auch den Fehlertext. Die Probe verlässt sich deshalb
**nur** auf den Typ-Token und den Exit-Code:

- Der Pfad ist der Rest der ersten Zeile mit `REG_SZ` bzw. `REG_EXPAND_SZ`
  nach dem Typ-Token; `%VAR%` in `REG_EXPAND_SZ` wird gegen die Umgebung
  expandiert (Groß-/Kleinschreibung egal).
- `reg.exe` Exit-Code 1 ohne jeglichen `REG_`-Token in der Ausgabe →
  **fehlt** (das ist in allen Sprachen „Schlüssel nicht gefunden").
- Jeder andere Fehler und jede erfolgreiche Abfrage, die nicht geparst werden
  kann → **unbekannt** (mit der rohen Ausgabe im Log, auf ~300 Zeichen
  gekürzt). Eine nicht lesbare Ausgabe ist **nie** ein Beweis für „fehlt".
- **registriert** nur, wenn die Datei existiert **und** nach Normalisierung
  (`realpath`, `path.normalize`, case-insensitive) der installierten DLL
  `<resources>\native\vcam-helper\broadify-vcam.dll` entspricht.
- Datei fehlt oder zeigt auf eine andere Installation → **veraltet**
  (beide Pfade stehen im Log).

### Entscheidung

- **registriert** → kein Self-Heal, Fehler wird unverändert gemeldet
  (Ursache liegt nicht an der Registrierung).
- **unbekannt** → Self-Heal nur, wenn der Fehlertext `0x80040154` enthält.
- **fehlt** oder **veraltet**:
  - **Unbeaufsichtigter Pfad** (Auto-Arm beim Engine-Start,
    `virtualCameraStart({ allowElevation: false })`): **nie** ein UAC-Prompt.
    Die Bridge loggt nur die Diagnose `vcam_not_registered` samt Admin-Kommando
    und meldet den Fehler als Meeting-Event.
  - **Expliziter Operator-Start** (`meeting_output_configure`, Target
    `virtual_camera`, Action `start`): genau einmal
    1. Elevierter `regsvr32 /s <resources>\native\vcam-helper\broadify-vcam.dll`
       über `Start-Process -FilePath "%WINDIR%\Sysnative\regsvr32.exe"`
       (falls vorhanden, sonst `System32`) `-Verb RunAs -Wait -PassThru` →
       ein UAC-Prompt; der Exit-Code von `regsvr32` wird durchgereicht (3 =
       DLL nicht ladbar, 5 = `DllRegisterServer` fehlgeschlagen/Zugriff
       verweigert).
    2. Erneute Registry-Prüfung; ist sie nicht **registriert**, landet die rohe
       `reg.exe`-Ausgabe plus installierter Pfad im Log.
    3. Ein einziger Retry von `output.vcam.start`.

### Einmal-Sperre (persistiert)

Vor dem Prompt schreibt die Bridge `<userDataDir>\vcam-self-heal.json`
(`{ app_version, dll_path, attempted_at, outcome }`, zod-validiert). Ein
Marker für dieselbe App-Version und denselben DLL-Pfad verhindert jeden
weiteren Prompt – auch über Neustarts hinweg; im Log steht dann die Diagnose
mit Zeitstempel des Versuchs. Erst eine bestätigte Registrierung plus
erfolgreicher Retry löscht den Marker; ein App-Update (neue Version) erlaubt
einen weiteren Versuch. Zusätzlich gilt eine In-Prozess-Sperre, falls der
Marker nicht geschrieben werden kann.

Wird die Elevation abgelehnt oder schlägt sie fehl, loggt die Bridge das
manuelle Admin-Kommando und liefert den ursprünglichen Fehler aus. Es gibt
keine Wiederholungsschleife.

## Manueller Fallback (Admin-Konsole)

```powershell
regsvr32 /s "C:\Program Files\BroadifyBridge\resources\native\vcam-helper\broadify-vcam.dll"
```

Danach die virtuelle Kamera in der Bridge erneut starten. Prüfung, ob die
CLSID registriert ist (GUID aus `native/vcam-helper/windows/vcam_guid.h`):

```powershell
Test-Path "HKLM:\Software\Classes\CLSID\{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}"
```

Der MSI-Smoke-Test (`scripts/smoke-test-windows-msi.ps1`) verifiziert die
Registrierbarkeit der paketierten DLL genau über diesen Weg; der
NSIS-Smoke-Test (`scripts/smoke-test-windows-nsis.ps1`) prüft, dass der
**Installer selbst** den Schlüssel angelegt hat (Pfad unter dem
Installationsverzeichnis) und die Deinstallation ihn wieder entfernt.

Support-Ablauf bei Kundenfällen: `docs/bridge/support/vcam-runbook.md`.
