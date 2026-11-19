# Live-PGM-Vorschau unter Windows (Vorbereitung)

Status: Vorbereitung. Alles liegt hinter zwei Schaltern, die standardmäßig aus sind. Nichts hiervon ist auf
Windows-Hardware geprüft; die CI kompiliert und fährt ctest auf einem GPU-losen Runner. Entscheidungen: ADR-0009
(`docs/bridge/architecture/adr/0009-live-pgm-windows-media-foundation.md`), Grundlage ADR-0002/0004/0005/0006.
macOS-Fassung und Verträge: `docs/bridge/features/pgm-live-preview.md`.

Dieses Dokument wächst mit der Umsetzung (Einheiten D1–D10). Wo ein Abschnitt etwas beschreibt, das eine spätere
Einheit erst liefert, steht die Einheit dabei; Dateinamen dort sind geplant und können sich noch ändern.

## Ziel
Dasselbe Live-Programm wie auf macOS: Mischer-PGM im Studio (`pgm-helper.exe`: UVC + Ton → H.264/Opus → WebRTC) und
Meeting-Programm (`meeting-helper.exe`: `ProgramStream` aus dem Compositor), beide über `live-stream`
(`broadify::live`) und denselben Viewer der Web-App. Verträge, Befehle, Fehlercodes und RPC bleiben die der
macOS-Fassung; unter Windows kommt nur `recording_unsupported` dazu.

## Architektur

| Baustein | macOS (heute) | Windows (vorbereitet) | Einheit |
|---|---|---|---|
| H.264-Encoder | VideoToolbox (`live-stream/src/vt_encoder.mm`) | Hardware-MFT über `MFTEnumEx(MFT_ENUM_FLAG_HARDWARE)` (`mf_encoder.cpp`), sonst `encoder_unavailable` | D2, D4 |
| Encoder-Eingabe | `CVPixelBuffer` (NV12/BGRA), VT skaliert | NV12 im Systemspeicher, kein D3D-Manager; Umwandlung und Skalierung auf der CPU | D2, D3 |
| Pixel-Module | nicht nötig | RGBA→NV12, YUY2/UYVY→NV12, NV12-Skalierung (rein, in `live_stream_core`) | D3 |
| WebRTC | libdatachannel v0.22.6, OpenSSL statisch (Homebrew) | libdatachannel v0.22.6, OpenSSL statisch (vcpkg `x64-windows-static-md`) | D5 |
| UVC-Capture | AVFoundation, NV12 | Media Foundation Source Reader; NV12/YUY2/UYVY nativ, MJPG-Dekodierung nur wenn der höchste Modus sonst fehlt | D7 |
| Ton | AVFoundation, Paarung über Modellname | WASAPI Shared Mode, Paarung über Container-ID, ersatzweise Name | D7 |
| Standbild | ImageIO | portabler JPEG-Pfad | D7 |
| Aufnahme | zweiter VT-Encoder + AVAssetWriter (ADR-0006) | Stub, `recording_unsupported` | D7, D9 |
| Helper-Einstieg | `main.mm` | `main.cpp` + Plattform-Host | D6 |
| Meeting-Programm | `program_stream.mm` | gemeinsamer `program_stream.cpp` + Konverter je Plattform | D8 |
| Bridge-Gate | `platform === "darwin"` | `isPgmPlatformSupported()` mit `BRIDGE_PGM_WINDOWS`, `windowsHide` beim Start | D9 |
| Packaging | signierte Helper-App | `pgm-helper.exe` in Packaging-, Signier-, VC-Runtime- und Artefaktlisten, nur mit Build-Schalter | D10 |

Regeln, die unter Windows genauso gelten:
- Nur Hardware-Encoder. Der Microsoft-Software-MFT läuft ausschließlich in Tests.
- PGM-Medien nie über den Relay; Signalisierung über den signierten Befehlsweg.
- Ohne Zuschauer wird nichts kodiert; die Frame-Pipeline des Meeting-Helpers wartet nie auf den Encoder.

## Schalter

| Schalter | Wo | Wirkung | Standard |
|---|---|---|---|
| `BROADIFY_PGM_WINDOWS=1` | Build (Umgebung beim Windows-Build) | Windows-Targets (Encoder, WebRTC mit vcpkg-OpenSSL, `pgm-helper.exe`, Meeting-`ProgramStream`) werden gebaut und `pgm-helper.exe` in die Packaging-/Signierlisten aufgenommen | aus |
| `BRIDGE_PGM_WINDOWS=1` | Laufzeit (Umgebung der Bridge) | Bridge meldet unter Windows `capabilities.live_program.supported = true` und startet den Helper | aus |

- Ohne Build-Schalter bleibt das Windows-Release bytegleich. Neue Windows-Targets sind opt-in, weil
  `npm run test:meeting-helper-native` in `dist:win` alle Targets des Build-Verzeichnisses baut.
- Ohne Laufzeit-Schalter antwortet auch eine mit Build-Schalter gebaute Bridge wie heute
  (`pgm_unsupported_bridge`, Meeting: `program_stream_unavailable`).
- Die bestehenden Schalter gelten weiter: `BRIDGE_PGM_PREVIEW=0` (Notaus), `BRIDGE_PGM_MAX_VIEWERS`,
  `BRIDGE_PGM_SYNTHETIC_SOURCE=1920x1080@60`, `BRIDGE_LOG_PERF=1`, `BRIDGE_PGM_HELPER_PATH`.
- Freischalten (Standard ändern) ist eine eigene Entscheidung nach der Sitzung am Gerät.

## Build

Voraussetzungen auf dem Windows-Rechner: Visual Studio 2022 Build Tools (MSVC x64, Windows-SDK), CMake, Git, Node wie
für die Bridge, vcpkg (`VCPKG_ROOT` gesetzt), Netz für FetchContent (libdatachannel, libopus).

```powershell
# x64 Native Tools Prompt bzw. nach vcvars64.bat
$env:BROADIFY_PGM_WINDOWS = "1"
& "$env:VCPKG_ROOT\vcpkg.exe" install openssl:x64-windows-static-md

# PGM-Helper (Skript kommt mit D7; baut pgm-helper.exe und die Tests)
.\apps\bridge\native\pgm-helper\build.ps1
ctest --test-dir apps\bridge\native\pgm-helper\build --build-config Release --timeout 120 --output-on-failure

# Meeting-Helper mit ProgramStream (D8)
npm run build:meeting-helper
npm run test:meeting-helper-native
```

CI: Workflow `pgm-windows-native.yml` (D1; `windows-2022`, Push auf `feature/pgm-win-*` und manuell) kompiliert und
fährt ctest. Der Encoder-Smoke-Test überspringt dort mangels Hardware-MFT. Grün im CI heißt: es kompiliert und die
Media-Foundation-Verdrahtung hält gegen den Software-MFT. Es heißt nicht: auf Hardware geprüft.

Start aus einem Dev-Build:

```powershell
$env:BRIDGE_PGM_WINDOWS = "1"
$env:BRIDGE_LOG_PERF = "1"
$env:BRIDGE_PGM_HELPER_PATH = "<repo>\apps\bridge\native\pgm-helper\pgm-helper.exe"
```

## Runbook: gemeinsame Sitzung am Windows-Gerät

Ziel der Sitzung: Abschnitt für Abschnitt ein Ergebnis (ok / Fehler / nicht geprüft) in die Tabelle unten, am Ende
die Entscheidungen unter „Ausstieg“. Bei jedem Fehler: Fehlercode, Helper-Ereignislog und `--probe`-Ausgabe sichern,
bevor weiterprobiert wird.

### 0. Was mitbringen
- [ ] Windows-11-Rechner mit Administratorrechten; ideal je einer mit NVIDIA-, Intel- und AMD-Grafik, dazu ein
      Hybrid-Laptop (iGPU + dGPU). Mindestens: der Rechner, auf dem die Bridge produktiv laufen soll.
- [ ] ATEM Mini (USB-C-Webcam-Ausgang), RØDECaster Video, je ein USB-Kabel; eine gewöhnliche Webcam als Gegenprobe.
- [ ] Zweites Gerät als Zuschauer im selben Netz (Mac oder Tablet), eines außerhalb (Mobilfunk-Hotspot) für TURN.
- [ ] Stoppuhr-/Timecode-Quelle für die Latenzmessung (Uhr mit Millisekunden auf einem Bildschirm, Kamera darauf).
- [ ] Klappe oder Klatschen für Lippensynchronität.
- [ ] Branch-Stand: alle D-Einheiten gemergt oder ein Sammel-Branch; Commit-Hash notieren.

### 1. Einrichtung
- [ ] Grafiktreiber aktuell; Version notieren (`dxdiag` → Anzeige, oder Geräte-Manager).
- [ ] Build wie oben mit `BROADIFY_PGM_WINDOWS=1`; ctest-Ergebnis notieren (übersprungene Tests ausdrücklich).
- [ ] Der Encoder-Smoke-Test läuft auf diesem Rechner **nicht** als „übersprungen“, sondern gegen den Hardware-MFT.
- [ ] Gegenprobe Schalter aus: Bridge ohne `BRIDGE_PGM_WINDOWS` starten → `get_status.capabilities.live_program.supported`
      ist `false`, Web-App zeigt das Fenster nicht bzw. den bekannten Hinweis; kein `pgm-helper.exe` im Task-Manager.
- [ ] Bridge mit `BRIDGE_PGM_WINDOWS=1` starten → `supported: true`, `recording` aus.

### 2. `--probe`
```powershell
.\apps\bridge\native\pgm-helper\pgm-helper.exe --probe
```
- [ ] Ausgabe ist eine JSON-Zeile `{"type":"probe","inputs":[…],"encoder":…}`; Encoder-Name ist ein Hardware-MFT
      (z. B. NVIDIA-, Intel-Quick-Sync- oder AMD-MFT), nicht der Microsoft-Software-Encoder.
- [ ] Angeschlossene UVC-Geräte erscheinen mit stabilen Schlüsseln; zweimal ausführen, Schlüssel bleiben gleich.
- [ ] Ohne angeschlossenes Gerät: leere Liste, Exit-Code 0, kein Absturz.
- [ ] Exit-Code und Laufzeit notieren (soll unter wenigen Sekunden bleiben).

### 3. Hardware-Matrix Encoder
Je Rechner mit `BRIDGE_PGM_SYNTHETIC_SOURCE=1920x1080@60` (kein Gerät nötig) und einem Zuschauer:

| GPU | Treiber | MFT-Name | 1080p60 ok | Low-Latency ok | Keyframe auf PLI | CPU Helper % | Bemerkung |
|---|---|---|---|---|---|---|---|
| NVIDIA |  |  |  |  |  |  |  |
| Intel (Quick Sync) |  |  |  |  |  |  |  |
| AMD |  |  |  |  |  |  |  |
| Hybrid-Laptop (iGPU aktiv) |  |  |  |  |  |  |  |
| Hybrid-Laptop (dGPU erzwungen) |  |  |  |  |  |  |  |

- [ ] `pgm_encoder_configured` nennt Encoder, Auflösung, Bitrate; `pgm_perf` (`BRIDGE_LOG_PERF=1`) zeigt
      Kodier-fps = Quell-fps, keine wachsenden Drops.
- [ ] Keine B-Frames: Bild im Browser läuft ohne Sprünge; `chrome://webrtc-internals` zeigt gleichmäßige
      `framesDecoded`, keine wachsenden `framesDropped`.
- [ ] Neuer Zuschauer bekommt sofort ein Bild (Keyframe bei Beitritt); Tab neu laden → Bild in unter 1 s.
- [ ] Profil `remote` (720p) wählen → Skalierung stimmt (kein Versatz, keine grünen Ränder, Farben wie in 1080p).
- [ ] Farben gegen macOS vergleichen (Farbbalken): kein sichtbarer Range-/Matrix-Fehler (BT.709, Video-Range).
- [ ] Hybrid-Laptop: welcher MFT wird gewählt, wenn das interne Display an der iGPU hängt? Auf Akku wiederholen.
- [ ] Rechner ohne Hardware-H.264 (falls vorhanden: VM oder RDP-Sitzung): sauberes `encoder_unavailable`, kein Bild,
      kein Software-Fallback, Helper bleibt bedienbar.

### 4. Zwei parallele Encoder-Sessions
Hintergrund: Meeting-Aufnahme (Media Foundation) und Programm-Stream laufen gleichzeitig; später kommt die
PGM-Aufnahme als zweiter Encoder im PGM-Helper dazu (ADR-0006).
- [ ] Meeting-Engine starten, Aufnahme starten, dann Zuschauer auf das Meeting-Programm: beide laufen, die
      Aufnahme bleibt ruckelfrei (Datei danach prüfen), `program.stream.status` ohne wachsende `dropped_frames`.
- [ ] Zusätzlich im Studio-Modus PGM-Vorschau mit Zuschauer (zweiter Prozess, zweite Session).
- [ ] NVIDIA-Consumer-Karten begrenzen parallele Sessions treiberseitig: Zahl gleichzeitig möglicher Sessions
      notieren, Fehlerbild der überzähligen Session notieren (soll `encoder_unavailable` sein, kein Hänger).
- [ ] Parallel OBS oder Teams mit Hardware-Kodierung laufen lassen: Verhalten notieren.

### 5. UVC-Aushandlung
Je Gerät (ATEM Mini, RØDECaster Video, Webcam):

| Gerät | Angebotene Modi (Format, Auflösung, fps) | Gewählter Modus | MJPG nötig? | Signal im Status | Bemerkung |
|---|---|---|---|---|---|
| ATEM Mini |  |  |  |  |  |
| RØDECaster Video |  |  |  |  |  |
| Webcam |  |  |  |  |  |

- [ ] Modus-Liste des Geräts sichern (aus dem Helper-Log; Gegenprobe mit der Windows-Kamera-App oder OBS).
- [ ] Gewählt wird der höchste Modus bis 1080p; unkomprimiert (NV12/YUY2/UYVY) vor MJPG bei gleicher Auflösung und
      Rate. MJPG nur, wenn der höchste Modus sonst nicht erreichbar ist; CPU-Last der Dekodierung notieren.
- [ ] `pgm_signal` meldet die gemessene Rate (Snap auf 25/29,97/30/50/59,94/60) passend zum Mischer-Format.
- [ ] Mischer-Format umstellen (z. B. 1080p50 → 1080p60): Status folgt, Stream läuft nach Keyframe weiter.
- [ ] Hot-Plug: Kabel im Betrieb ziehen → `pgm_inputs_changed`, Status ohne Signal, kein Absturz, kein Hänger;
      wieder stecken → Quelle kommt zurück (gleicher stabiler Schlüssel), Bild ohne Neustart der Bridge.
- [ ] Anderer USB-Port: stabiler Schlüssel bleibt gleich oder Verhalten notieren.
- [ ] Gerät belegt (Kamera-App oder OBS hält es offen): Fehlercode notieren (`device_in_use`), danach freigeben
      und erneut wählen.
- [ ] Meeting-Helper und PGM-Helper wollen dasselbe Gerät: Bridge-Arbitrierung greift (`device_in_use`).
- [ ] Datenschutz: Einstellungen → Datenschutz & Sicherheit → Kamera → „Desktop-Apps den Zugriff erlauben“ aus:
      Fehlercode und Text notieren (soll verständlich sein, nicht „kein Gerät“). Wieder an. Dasselbe für Mikrofon.
- [ ] Bridge-Neustart: persistierte Quelle (`<userData>/pgm/pgm-source.json`) wird wieder gewählt.

### 6. Ton: Paarung und Lippensynchronität
- [ ] ATEM Mini und RØDECaster: Der Helper wählt das Audio-Gerät desselben USB-Geräts (Container-ID). Im Log
      steht, ob über Container-ID oder Name gepaart wurde.
- [ ] Zwei gleiche Geräte (falls vorhanden) oder Webcam mit eigenem Mikrofon zusätzlich angeschlossen: keine
      Verwechslung.
- [ ] Standard-Aufnahmegerät in Windows auf ein anderes Mikrofon stellen: Der Helper nimmt trotzdem den Mischer-Ton.
- [ ] Gerät ohne Audio-Funktion: Vorschau läuft ohne Ton, Ereignis `pgm_audio_unavailable`, kein Standard-Mikrofon.
- [ ] Mix-Format ungleich 48 kHz (Gerät in den Sound-Einstellungen auf 44,1 kHz stellen): Ton sauber, keine
      Tonhöhenverschiebung, kein Knacken.
- [ ] Lippensynchronität mit Klappe: Versatz im Browser schätzen (Ziel unter ±40 ms); nach 10 Minuten wiederholen
      (Drift).
- [ ] Ton in einer anderen App gleichzeitig nutzbar (Shared Mode): z. B. OBS nimmt dasselbe Gerät auf.
- [ ] Audio-Gerät im Betrieb deaktivieren (Sound-Einstellungen): Bild läuft weiter, Ton-Ereignis kommt, kein Absturz.

### 7. Firewall und ICE
- [ ] Erster Start mit Zuschauer: Erscheint die Windows-Firewall-Abfrage für `pgm-helper.exe` bzw.
      `meeting-helper.exe`? Für welches Profil (privat/öffentlich)? Screenshot.
- [ ] Abfrage **ablehnen**: Kommt trotzdem ein Bild (ausgehend/relay)? Kandidatenpaar notieren.
- [ ] Abfrage erlauben: Kandidatenpaar im selben Netz ist `host`↔`host` (in `chrome://webrtc-internals` →
      ausgewähltes Kandidatenpaar; im Helper-Log der gewählte Typ).
- [ ] Zuschauer außerhalb (Hotspot): `srflx` oder `relay` (TURN); Bild kommt, Bitrate folgt dem Profil `remote`.
- [ ] Firmennetz/VPN-Adapter aktiv: keine falsche Schnittstelle bevorzugt, Verbindungsaufbau unter 5 s.
- [ ] Installer-Frage klären: Firewall-Regel bei der Installation setzen (NSIS/MSI) oder Abfrage akzeptieren?

### 8. Latenz Glas zu Glas
- [ ] Kamera am Mischer filmt eine Millisekunden-Uhr; Foto, das Uhr und Browserfenster zugleich zeigt. Je
      Konfiguration fünf Fotos, Mittelwert.

| Konfiguration | Latenz ms (Mittel) | Bemerkung |
|---|---|---|
| UVC 1080p60, LAN, Chrome |  |  |
| UVC 1080p50, LAN, Chrome |  |  |
| UVC 1080p60, LAN, Safari/Edge |  |  |
| UVC, remote (TURN) |  |  |
| Synthetische Quelle 1080p60 (Bildzähler) |  |  |
| Meeting-Programm 1080p30, LAN |  |  |
| macOS-Vergleich, gleiche Quelle |  |  |

- [ ] Ziel: nicht mehr als etwa 50 ms über dem macOS-Wert derselben Quelle. Größere Abweichung → Low-Latency-
      Einstellung des MFT und asynchrone Bedienung prüfen.

### 9. Mehrere Zuschauer
- [ ] Zwei, dann vier Zuschauer (Standardgrenze `BRIDGE_PGM_MAX_VIEWERS=4`): ein Encoder, je Zuschauer eine
      PeerConnection; CPU steigt kaum.
- [ ] Fünfter Zuschauer: `pgm_viewer_limit`.
- [ ] Zuschauer-Tab mehrfach neu laden: Plätze werden frei (kein Aussperren nach einigen Reloads).
- [ ] Zuschauer-Rechner in den Ruhezustand: Platz ist nach spätestens ~15 s frei.
- [ ] Letzter Zuschauer geht: Encoder stoppt (`pgm_perf` ohne Kodier-fps), CPU fällt.

### 10. Signatur und Smart App Control
- [ ] Installer aus einem Build mit `BROADIFY_PGM_WINDOWS=1` (signiert über die normale Pipeline, **kein**
      Release): `Get-AuthenticodeSignature` für `pgm-helper.exe` und `meeting-helper.exe` → `Valid`, Aussteller wie
      die übrigen Helper.
- [ ] `scripts/verify-windows-release-signatures.ps1` und `scripts/verify-windows-native-dependencies.cjs` laufen
      durch; `pgm-helper.exe` importiert nur erlaubte DLLs (keine OpenSSL-DLL, VC-Runtime wie die anderen Helper).
- [ ] Rechner mit Smart App Control im Modus „Ein“ (frische Windows-11-Installation): Helper startet, kein Block.
      Falls geblockt: Ereignisanzeige → CodeIntegrity sichern.
- [ ] SmartScreen/Defender: keine Warnung beim ersten Start des Helpers.
- [ ] Gegenprobe: Installer **ohne** Build-Schalter enthält kein `pgm-helper.exe`.

### 11. Konsolenfenster und verwaiste Prozesse
- [ ] Beim Start des Helpers aus der paketierten Bridge blitzt kein Konsolenfenster auf (`windowsHide`).
- [ ] Bridge normal beenden: `pgm-helper.exe` endet innerhalb weniger Sekunden.
- [ ] Bridge im Task-Manager hart beenden: Helper endet von selbst (`--parent-pid`-Wächter); nach 10 s prüfen
      (`Get-Process pgm-helper`).
- [ ] Helper hart beenden: Bridge startet ihn neu (Neustart-Policy), Quelle wird wieder gewählt, Zuschauer
      verbinden sich neu.
- [ ] Bridge-Update/Neuinstallation bei laufendem Helper: Installer scheitert nicht an der gesperrten Datei.
- [ ] Kamera-LED bzw. Gerät ist nach Bridge-Ende frei (Kamera-App kann es öffnen).
- [ ] Benannte Pipes `\\.\pipe\broadify-pgm-*` bleiben nicht zurück.

### 12. Hochformat 1080×1920
Nur wenn die Hochformat-Einheiten (ADR-0007, `meeting.program_portrait`) gemergt sind; unter Windows ist die
Fähigkeit zunächst `false` und muss für den Test bewusst eingeschaltet werden.
- [ ] Meeting-Engine 1080×1920: Hardware-MFT nimmt die Auflösung an (manche MFTs verlangen gerade Maße oder
      begrenzen die Höhe; Fehlerbild notieren).
- [ ] Bild im Viewer hochkant, nicht gedreht, nicht verzerrt; Profil `remote` skaliert auf die kurze Kante.
- [ ] Aufnahme (Meeting-Recorder) 1080×1920: Datei prüfen (`ffprobe`).
- [ ] Virtuelle Kamera bleibt 1920×1080 mit Balken.
- [ ] Zurück auf Querformat: alles wie vorher.

### 13. Dauerlauf 60 Minuten
- [ ] Echte Quelle (ATEM Mini 1080p50 oder 1080p60) mit Ton, ein Zuschauer im LAN, `BRIDGE_LOG_PERF=1`.
- [ ] Zu Beginn, nach 30 und nach 60 Minuten notieren: Arbeitsspeicher und Handle-Zahl des Helpers (Task-Manager →
      Details, Spalten „Arbeitsspeicher (privat)“ und „Handles“), CPU %, GPU-Encoder-Auslastung („Video Encode“).

| Zeitpunkt | RAM MB | Handles | CPU % | GPU Encode % | Kodier-fps | Drops | Latenz ms | A/V-Versatz |
|---|---|---|---|---|---|---|---|---|
| 0 min |  |  |  |  |  |  |  |  |
| 30 min |  |  |  |  |  |  |  |  |
| 60 min |  |  |  |  |  |  |  |  |

- [ ] Kein stetiger Anstieg von RAM oder Handles; keine wachsenden Drops; Latenz und A/V-Versatz stabil.
- [ ] Währenddessen einmal: Bildschirm sperren und entsperren, Monitor aus/an, Laptop vom Netzteil trennen.
- [ ] Danach: Helper-Ereignislog (`<userData>\pgm-helper-events.log`) und Bridge-Log sichern.

## Ergebnistabelle

| # | Abschnitt | Ergebnis (ok / Fehler / nicht geprüft) | Rechner | Befund / Ticket |
|---|---|---|---|---|
| 1 | Einrichtung, Schalter-Gegenprobe |  |  |  |
| 2 | `--probe` |  |  |  |
| 3 | Hardware-Matrix |  |  |  |
| 4 | Zwei Encoder-Sessions |  |  |  |
| 5 | UVC-Aushandlung, Hot-Plug, Datenschutz |  |  |  |
| 6 | Ton: Paarung, Lippensynchronität |  |  |  |
| 7 | Firewall, ICE |  |  |  |
| 8 | Latenz |  |  |  |
| 9 | Mehrere Zuschauer |  |  |  |
| 10 | Signatur, Smart App Control |  |  |  |
| 11 | Konsolenfenster, verwaiste Prozesse |  |  |  |
| 12 | Hochformat |  |  |  |
| 13 | Dauerlauf |  |  |  |

Datum, Commit, Teilnehmer und Treiberstände gehören über die Tabelle. „Nicht geprüft“ ist ein eigenes Ergebnis und
wird nicht als „ok“ gezählt.

## Ausstieg: Entscheidungen nach der Sitzung
1. **Freischalten?** Schalter-Standard ändern (Build und Laufzeit getrennt entscheidbar), zunächst nur für
   RC-Builds, oder weiter aus. Voraussetzung: Abschnitte 1–7, 10, 11 und 13 ohne offenen Fehler auf mindestens
   einem Rechner je vorhandenem GPU-Hersteller.
2. **D3D11-Eingabe nötig?** Wenn CPU-Last oder Latenz (Abschnitte 3, 8, 13) die Ziele verfehlen: D3D-Pfad als
   nächster Schritt (ADR-0009, Punkt 2).
3. **MJPG-Regel halten?** Falls ATEM Mini oder RØDECaster 1080p nur als MJPG liefern und die Dekodierung zu teuer
   ist: niedrigeren unkomprimierten Modus bevorzugen oder Hardware-Dekodierung prüfen.
4. **Windows-Aufnahme**: Reihenfolge und Zuschnitt (zweiter Hardware-MFT + MP4-Passthrough nach ADR-0006), abhängig
   vom Ergebnis aus Abschnitt 4.
5. **Firewall**: Regel im Installer setzen oder Abfrage beim ersten Zuschauer akzeptieren (Abschnitt 7).
6. **Hochformat unter Windows**: `meeting.program_portrait` für Windows auf `true` (Abschnitt 12).
7. **Hersteller-Ausnahmen**: Falls ein Hardware-MFT unbrauchbar ist (Treiberfehler), wird er gesperrt und der
   Rechner meldet `encoder_unavailable`; ein Software-Fallback bleibt ausgeschlossen (ADR-0002/0009).
8. Jede Abweichung von ADR-0009 bekommt ein Nachfolge-ADR.
