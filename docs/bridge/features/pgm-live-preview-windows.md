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
| Helper-Einstieg | `main.cpp` + `platform/platform_host_mac.mm` (bis D6 `main.mm`) | dasselbe `main.cpp` + `platform/platform_host_win.cpp` | D6 |
| Meeting-Programm | `program_stream.cpp` + `program_frame_converter_vt.mm` (bis D8 `program_stream.mm`) | derselbe `program_stream.cpp` + `program_frame_converter_nv12.cpp`, nur mit Build-Schalter | D8 |
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
| `LIVE_STREAM_WITH_MF=ON` | Build (CMake-Option oder Umgebung, nur `live-stream`) | Baut allein den Media-Foundation-Encoder und seine Tests, ohne WebRTC/OpenSSL. Wird von `BROADIFY_PGM_WINDOWS=1` mit eingeschaltet | aus |
| `LIVE_STREAM_WITH_WEBRTC=ON` | Build (CMake-Option, nur `live-stream`) | Baut unter Windows den WebRTC-Teil (`live_stream`: `publisher.cpp` auf dem Encoder, libdatachannel, statisches OpenSSL) und `webrtc_loopback_test`. Schaltet `LIVE_STREAM_WITH_MF` mit ein. Wird von `BROADIFY_PGM_WINDOWS=1` mit eingeschaltet; auf macOS ist es immer an | aus (Windows) |
| `BRIDGE_PGM_ENCODER_VENDOR=nvidia\|intel\|amd` | Laufzeit (Umgebung des Helpers) | Zieht die Hardware-MFTs dieses Herstellers in der Reihenfolge nach vorn (Gerätetest auf Hybrid-Laptops). Die übrigen bleiben Ausweichkandidaten; welcher Encoder läuft, steht in `EncoderInfo.name` | nicht gesetzt |

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
# Statisches OpenSSL aus dem vcpkg-Manifest (einmalig, einige Minuten; danach überspringt das Skript)
.\scripts\prepare-windows-pgm-deps.ps1

# PGM-Helper: baut pgm-helper.exe neben das Skript und dazu die Tests (D7)
.\apps\bridge\native\pgm-helper\build.ps1
ctest --test-dir apps\bridge\native\pgm-helper\build --build-config Release --timeout 120 --output-on-failure

# Meeting-Helper mit ProgramStream (D8)
npm run build:meeting-helper
npm run test:meeting-helper-native
```

`build.ps1` konfiguriert mit `-DLIVE_STREAM_WITH_WEBRTC=ON`; es selbst auszuführen ist also schon das Einschalten.
Der Weg über npm (`npm run build:pgm-helper` → `scripts/build-pgm-helper.sh`) ruft es unter Windows nur mit
`BROADIFY_PGM_WINDOWS=1` auf und überspringt sonst wie bisher. `PGM_HELPER_BUILD_TESTS=0` baut nur den Helper,
`PGM_HELPER_CMAKE_EXTRA_ARGS` reicht weitere Konfigurationsargumente durch (z. B. `-DFETCHCONTENT_SOURCE_DIR_OPUS=…`).

CI: Workflow `pgm-windows-native.yml` (D1; `windows-2022`, Push auf `feature/pgm-win-*` und manuell) kompiliert und
fährt ctest: Job `core` ohne jeden Schalter (das, was ein Windows-Release heute kompiliert), Job `encoder` mit
`LIVE_STREAM_WITH_MF=ON`, Job `full` mit `LIVE_STREAM_WITH_WEBRTC=ON` (vcpkg-OpenSSL, libdatachannel und opus im
Cache; `webrtc_loopback_test` mit einer Wiederholung; `dumpbin` prüft, dass keine OpenSSL-DLL importiert wird). Der
Encoder-Smoke-Test überspringt dort mangels Hardware-MFT. Seit D7 baut `full` außerdem den Helper so, wie der
Build-Schalter ihn baut, und prüft ihn (siehe „Windows-Quellen des Helpers (D7)“). Grün im CI heißt: es kompiliert,
die Media-Foundation-Verdrahtung hält gegen den Software-MFT, der Publisher verbindet sich über Loopback und der
Helper startet, lässt sich steuern und meldet ohne Hardware-Encoder `encoder_unavailable`. Es heißt nicht: auf
Hardware geprüft. UVC-Capture und WASAPI laufen im CI nie (kein Gerät am Runner); sie sind dort nur kompiliert.

Start aus einem Dev-Build:

```powershell
$env:BRIDGE_PGM_WINDOWS = "1"
$env:BRIDGE_LOG_PERF = "1"
$env:BRIDGE_PGM_HELPER_PATH = "<repo>\apps\bridge\native\pgm-helper\pgm-helper.exe"
```

## Meeting-Programm (D8)

`ProgramStream` des Meeting-Helpers ist in einen portablen Worker und einen Bildkonverter je Plattform geteilt. Auf
macOS verhält er sich wie vorher, mit einer Ausnahme: Das Ereignis `encoder_configured` nennt zusätzlich
`"backend":"videotoolbox","hardware":true`; `program.stream.status` hatte beide Schlüssel schon und ist unverändert.
Unter Windows entsteht der Stream nur mit dem Build-Schalter; ohne ihn linkt der Helper wie bisher den Stub und
antwortet `program_stream_unavailable`. Auf Windows-Hardware gelaufen ist davon nichts.

| Datei (`meeting-helper/src/live/`) | Inhalt | Gebaut |
|---|---|---|
| `program_stream.cpp` (vorher `program_stream.mm`) | Worker-Thread, Zuschauer, Encoder-Einrichtung aus der Bildgeometrie, Status-JSON. Keine Plattform-API | macOS; Windows mit Schalter |
| `program_frame_converter.h` | Naht zum Plattformteil: `prepare(Breite, Höhe)`, `convert(PreviewFrame, CapturedFrame)`, `release`, `reset`, dazu zwei Angaben für den Worker (Tabelle unten) | – |
| `program_frame_converter_vt.mm` (vorher `program_stream_frame_copy.mm`) | macOS: Puffer-Pool und begrenzte RGBA→BGRA-Kopie, unverändert, und der Konverter darum | macOS |
| `program_frame_converter_nv12.cpp` | Windows: RGBA → NV12 in Bildgröße (BT.709, Video-Range) mit `rgba_to_nv12` in einen wiederverwendeten Puffer. Reines C++, kein Media-Foundation-Aufruf | Windows mit Schalter; als Test auch macOS |
| `program_stream_stub.cpp` | unverändert | Windows ohne Schalter, übrige Plattformen |

Weg eines Bildes unter Windows:
1. Der Worker kopiert das Programmbild aus dem `PreviewFrameStore` (`copyLatestIfNew`). Nur für diese Kopie hält er die
   Sperre des Stores; `publish()` der Frame-Pipeline wartet also nie auf Umwandlung, Skalierung oder einen
   Media-Foundation-Aufruf.
2. Der Konverter wandelt nach NV12 in der Größe des Bildes. Die Geometrie kommt aus jedem Bild: Ändert sie sich
   (z. B. auf 1080×1920), legt er den Puffer neu an. Ein Bild, das nicht zur vorbereiteten Größe passt oder zu kurz
   ist, wird verworfen und gezählt (`dropped_frames`), nie abgeschnitten.
3. Das Encoder-Ziel ist `selectEncodeTarget(Bildgröße, Profil des ersten Zuschauers)`. Ändert es sich, wird der
   Encoder neu eingerichtet.
4. `encode()`: Die Eingangsstufe des Media-Foundation-Encoders kopiert die NV12-Ebenen in ein eigenes `IMFSample`
   aus ihrem Vorrat und skaliert dabei mit `nv12_scale`, wenn das Ziel kleiner ist als das Bild (Profil `remote`:
   1920×1080 → 1280×720, 1080×1920 → 720×1280). Der Konverter selbst skaliert nicht und hält kein
   Media-Foundation-Objekt.

Was der Konverter dem Worker vorgibt:

| | macOS (VideoToolbox) | Windows (Media Foundation) |
|---|---|---|
| Übergabe (`runsUnderStoreLock`) | Umwandlung und `encode()` unter der Store-Sperre, direkt aus dem Bild des Stores (wie bisher) | erst die Kopie aus dem Store, alles Weitere ohne Sperre |
| Pause nach gescheiterter Encoder-Einrichtung (`pacesEncoderRetries`) | keine: jedes Bild versucht es neu (wie bisher) | die Regel des PGM-Helpers, aus derselben Datei (`pgm-helper/src/common/encoder_retry_backoff.h`): 3 s für dasselbe Ziel; ein Ziel anderer Größe wird sofort versucht, und eine gelungene Einrichtung hebt die Pause auf |

Unabhängig vom Konverter: Ist der Store geleert, während ein Zuschauer bleibt (`camera.stop`,
`output.vcam.raw.stop`), gibt es eine neue Sequenz, aber kein Bild. Der Worker wartet dann auf das nächste Bild, bei
beiden Übergaben; auf macOS ist das der Fix aus #291.

Ohne Hardware-Encoder meldet `program.stream.status` `encoder: null` und `last_error.code = encoder_unavailable` mit der
Meldung des Encoders (versuchte MFTs mit Schritt und HRESULT). Bilder werden verworfen und gezählt; einen Software-Weg
gibt es nicht.

Welcher Encoder gewählt wurde, steht im Ereignis `meeting_program_stream` / `encoder_configured` und in
`program.stream.status.encoder`, mit den Schlüsseln des PGM-Helpers:

| Schlüssel | Inhalt | macOS (VideoToolbox) |
|---|---|---|
| `backend`, `hardware` | `mediafoundation` bzw. `videotoolbox`, Hardware-Encoder ja/nein | ja |
| `name` | Anzeigename des gewählten Encoder-MFT | – |
| `vendor_id`, `vendor` | z. B. `VEN_10DE`; daraus `nvidia`, `amd`, `intel` oder `unknown` | – |
| `settings` | Objekt mit den Einstellungen, die der Encoder angenommen hat (als Text in `settings_text`, falls es kein JSON-Objekt in einer Zeile ist) | – |

`name`, `vendor_id`, `vendor` und `settings` erscheinen nur, wenn der Encoder sie meldet. Gebaut werden sie vom Modul
des PGM-Helpers (`pgm-helper/src/common/encoder_info_json.cpp`); der Meeting-Helper kompiliert diese Datei von dort
(`program_stream_encoder_info` in `meeting-helper/CMakeLists.txt`, nur wo der echte Stream gebaut wird) und hat keine
eigene Fassung. Die Bridge reicht den Status ohne Schema durch (`meeting_program_status`).

Build:
- `meeting-helper/CMakeLists.txt`: macOS → Worker + VideoToolbox-Konverter. `WIN32 AND TARGET live_stream` → Worker +
  NV12-Konverter + `live_stream`. Sonst der Stub, Zeile für Zeile wie bisher. Das Target `live_stream` gibt es unter
  Windows nur, wenn `live-stream` mit seinem WebRTC-Teil konfiguriert wurde.
- `meeting-helper/build.ps1`: mit `BROADIFY_PGM_WINDOWS=1` zusätzlich `-DLIVE_STREAM_WITH_WEBRTC=ON`;
  `MEETING_HELPER_CMAKE_EXTRA_ARGS` reicht dann weitere Konfigurationsargumente durch. Ohne Schalter derselbe
  Konfigurationsaufruf wie bisher.
- Ein Build-Verzeichnis, das mit Schalter konfiguriert wurde, behält ihn im CMake-Cache. `build.ps1` ohne Schalter
  bricht dann mit einem Hinweis ab, statt den Stream stillschweigend wieder zu bauen: `meeting-helper\build` löschen.
- Voraussetzung mit Schalter: das statische OpenSSL aus `scripts/prepare-windows-pgm-deps.ps1`, wie beim PGM-Helper.
- `scripts/pgm-meeting-stream-contract.test.cjs` (Teil von `test:release-contracts`) prüft das am Quelltext.

Tests:

| Test | Wo | Was |
|---|---|---|
| `program_frame_converter_nv12_test` | macOS; Windows mit Schalter | Der NV12-Konverter: Farbwerte, Lage der Ebenen, 1920×1080, 1080×1920, 3840×2160, ungerade Größe, Wiederverwendung und Neuanlage des Puffers, abgelehnte Bilder. Dazu der Weg durch `frameToNv12` auf die Größe, die der Encoder plant |
| `program_stream_loopback_test` | macOS; Windows mit Schalter | Der echte Worker gegen einen libdatachannel-Zuschauer im selben Prozess, mit Konverter und Hardware-Encoder der Plattform: Anmeldung als Vorschau-Verbraucher, Encoder aus der Bildgeometrie (1920×1080 mit Profil `remote`), Wechsel auf 1080×1920, neues Profil durch einen neuen ersten Zuschauer, Warten bei geleertem Store (CPU-Zeit des Prozesses, höchstens 5 % der Laufzeit) und das nächste Bild danach, Ruhe ohne Zuschauer, Stop und Neustart. Ohne Hardware-Encoder erwartet er `encoder_unavailable` und kein kodiertes Bild |
| `program_stream_nv12_loopback_test` | macOS; Windows mit Schalter | Derselbe Test mit dem NV12-Konverter und einem Encoder, den der Test stellt. Läuft überall ohne Hardware und hält die Windows-Übergabe fest: Bilder kommen als NV12 in Bildgröße mit den richtigen Werten an, kein Encoder-Aufruf unter der Store-Sperre, ein vom Encoder abgelehntes Bild zählt als verworfen, Pause nach gescheiterter Einrichtung (gleiches Ziel erst nach 3 s, anderes Ziel sofort, ein zurückkehrendes Ziel nach einer gelungenen Einrichtung ebenfalls sofort). Das Warten bei geleertem Store prüft er damit für die kopierende Übergabe |
| `program_stream_idle_test` | macOS | Aus #291: der echte Stream mit VideoToolbox und einem Zuschauer, der nie verbindet; CPU-Zeit des Prozesses bei geleertem Store |
| `program_stream_scale_test` | macOS | wie bisher Pool und Kopie, jetzt zusätzlich über die Konverter-Naht |

Die beiden Loopback-Tests signalisieren die ICE-Kandidaten beider Seiten auf 127.0.0.1 (beide Seiten binden ihren
Socket an alle Adressen). Auf der LAN-Adresse des Rechners verwerfen lokale Paketfilter auf manchen Rechnern
Datagramme zwischen zwei Sockets desselben Prozesses; mit dem Stream hat das nichts zu tun.

CI (Job `meeting`), zwei unabhängige Läufe, beide mit den Matting-Backends wie `dist:win` (ONNX Runtime aus dem Repo,
OpenVINO über das Skript des Releases). Bleibt der OpenVINO-Download nach drei Versuchen aus, wird trotzdem gebaut und
getestet, ohne dieses Backend; das ist dann nicht die Release-Konfiguration, die Job-Zusammenfassung sagt es
(„built WITHOUT the OpenVINO backend“), und der letzte Schritt lässt den Lauf rot enden. In den Release-Workflows ist
derselbe Download seit dem 08.08. in 154 von 154 Windows-Builds gelungen (Stand 20.11.).
1. **Standard, ohne Schalter**: genau die beiden Befehle des Releases, `npm run build:meeting-helper` und
   `npm run test:meeting-helper-native`, seriell gebaut wie dort (ohne `CMAKE_BUILD_PARALLEL_LEVEL`, also ohne `/m`).
   Danach die Prüfung, dass nichts vom Live-Programm konfiguriert oder kompiliert wurde (kein `_deps`, kein
   `LIVE_STREAM_*` im CMake-Cache, Stub im Helper). Dieser Lauf braucht nichts, was erst D8 mitbringt; er ist der
   Windows-Compile jeder Änderung unter `meeting-helper`.
2. **Mit `BROADIFY_PGM_WINDOWS=1`**: derselbe Einstieg mit Schalter, Prüfung, dass der Helper `program_stream.cpp` und
   den NV12-Konverter enthält und keine OpenSSL-DLL importiert, ctest, die Loopback-Tests mit einer Wiederholung. Zum
   Schluss muss ein Build ohne Schalter dieses Build-Verzeichnis ablehnen.

Der Pfadfilter des Workflows umfasst seit D8 ganz `meeting-helper` (Quellen, Tests, `CMakeLists.txt`, `build.ps1`).

CI (Job `meeting-macos`, Runner `macos-15`): das Tor des macOS-Releases für den Meeting-Helper. `dist:mac:arm64` baut
den Helper und lässt dann seine nativen Tests laufen; schlägt einer fehl, gibt es kein Release. Dazu gehören seit
#291 und D8 `program_stream_idle_test` und die beiden Loopback-Tests, die nach CPU-Zeit und Zeitgrenzen urteilen und
einen Zuschauer über lokales ICE verbinden. Der Job führt die beiden Befehle des Releases in dessen Reihenfolge aus
(`npm run build:meeting-helper`, `npm run test:meeting-helper-native`), seriell gebaut, und danach die drei Tests
zehnmal in Folge.

| | Release (`dist:mac:arm64`) | Job `meeting-macos` |
|---|---|---|
| Runner, Node, Xcode, CMake, Homebrew-`openssl@3` des Runner-Images | ja (kein eigener Installationsschritt für OpenSSL) | gleich; `openssl@3` wird geprüft, nicht installiert |
| Deployment-Target 13.0, MODNet aus, libdatachannel beim Konfigurieren geholt | ja | gleich |
| CoreML-Modell (`prepare:modnet-coreml-model`, Secret-URL) | ja | nein: Paketierungs-Ressource, weder Build noch ctest des Helpers lesen sie |
| übrige Schritte von `dist:mac` (andere Helper, Electron, Prüfskripte), `npm ci` | ja | nein: die beiden Befehle rufen ein Shell-Skript, cmake und ctest |
| Signatur des Helper-Bundles | Developer ID | ad hoc (kein Zertifikat ohne Secrets); die Test-Programme signiert `build.sh` in keinem Fall |

Encoder-Eingabe, Änderung an D4: `mf_encoder.cpp` hat nur noch einen Eingabeweg, die Kopie in ein eigenes Sample. Der
frühere Weg für ein `IMFSample` des Capturers (`CapturedFrame.nativeHandle`) legte ein neues Sample um dessen Puffer,
ohne das Sample des Capturers festzuhalten und ohne zu prüfen, ob der Puffer Systemspeicher mit genau einem NV12-Bild
ist. Der Allokator eines Source Readers verwendet ein Sample wieder, sobald dessen eigener Referenzzähler es freigibt;
die Kamera hätte den Puffer also überschreiben können, während der MFT noch liest. Keine Quelle setzt `nativeHandle`
(UVC lässt es absichtlich leer, das Meeting-Programm übergibt Ebenen), und prüfbar wäre der Weg nur am Gerät gewesen.
Er ist deshalb entfernt statt gehärtet; `mf_encoder_fake_mft_test` und `scripts/pgm-mf-encoder-contract.test.cjs`
halten das fest.

Offen bis zur Sitzung am Gerät:
- Kein Bild des Meeting-Programms ist unter Windows je durch einen Hardware-Encoder gelaufen. Im CI endet der echte
  Weg in `encoder_unavailable`; der Weg mit Bildern läuft dort nur gegen den Encoder des Tests.
- CPU-Kosten je Bild: eine Kopie des RGBA-Bildes (8,3 MB bei 1080p), die skalare Umwandlung nach NV12 und die Kopie
  bzw. Skalierung in das Sample des Encoders. Am Gerät messen (Runbook, Abschnitte 8 und 12).
- Die Encoder-Einrichtung läuft unter dem Mutex des Streams. Solange ein Hardware-MFT aktiviert wird (vom Encoder auf
  15 s begrenzt), warten `program.stream.status` und `program.viewer.offer` auf diesen Mutex. Der Control-Server des
  Helpers arbeitet Befehle nacheinander ab; hinter einem so wartenden Befehl steht deshalb jeder weitere RPC des
  Helpers, bis die Einrichtung fertig ist.
- `dropped_frames` zählt, was der Worker verwirft (kein Encoder, der Konverter oder `encode()` lehnt ab). Ersetzt der
  Media-Foundation-Encoder ein Bild in seinem Postfach („Encoder (D4)“), zählt nur er das (`MfEncoderStats.dropped`,
  lesbar allein über die Test-Naht); in `program.stream.status` steht es nicht. Sichtbar wird es dort nur daran, dass
  `encoded_frames` langsamer wächst als die Bildrate des Programms.
- Meldet der MFT im Betrieb `MEError` (Treiber-Update, GPU-Wechsel), lehnt der Encoder danach jedes Bild ab (siehe
  „Encoder (D4)“). Der Worker zählt diese Bilder nur als verworfen; neu eingerichtet wird der Encoder erst, wenn sich
  Bildgröße oder Profil ändern oder der Helper neu startet. Im PGM-Helper ist es dasselbe.
- Der Helper selbst kennt keinen Laufzeit-Schalter. Ob ein Offer bis zu ihm kommt, entscheidet die Bridge
  (`BRIDGE_PGM_WINDOWS`).

## Windows-Quellen des Helpers (D7)

`pgm-helper.exe` entsteht nur, wenn der WebRTC-Teil von `live-stream` konfiguriert wurde (CMake:
`if(PGM_HELPER_BUILD_BINARY AND WIN32 AND TARGET live_stream)`), also hinter `BROADIFY_PGM_WINDOWS=1` bzw.
`-DLIVE_STREAM_WITH_WEBRTC=ON`. Ohne Schalter konfiguriert ein Windows-Build des Verzeichnisses wie bisher nur die
reinen Module und ihre Tests (`scripts/pgm-helper-windows-contract.test.cjs`, Teil von `test:release-contracts`).

| Datei | Inhalt |
|---|---|
| `capture/uvc_format_select` (rein) | Wahl des Gerätemodus: größte Geometrie bis 1080 Zeilen, dann höchste Bildrate, dann NV12 > YUY2 > UYVY > MJPG. Dazu die Zuordnung HRESULT → Fehlercode |
| `capture/uvc_mediafoundation.cpp` | UVC über den Media-Foundation-Source-Reader, asynchron, `MF_LOW_LATENCY`, ohne Videoprozessor |
| `capture/synthetic_source.cpp` | Testbild (Farbbalken, Bildzähler) als NV12 im Systemspeicher; dasselbe Bild wie `synthetic_source.mm` |
| `capture/snapshot_portable` (rein) | Bild → NV12 → RGB (BT.709, Video-Range) → JPEG mit `stb_image_write` (liegt bei `meeting-helper/third_party/stb`) → base64 |
| `capture/frame_holder_portable.cpp` | Hält für Standbilder eine Kopie des letzten Bildes, höchstens alle 200 ms eine neue |
| `audio/audio_pairing` (rein) | Paarung Video ↔ Audio: gleiche Container-ID, sonst die Namensregel von macOS |
| `audio/audio_capture_wasapi.cpp` | WASAPI-Capture im Shared Mode, ereignisgetrieben, 48 kHz Stereo Float über `AUTOCONVERTPCM` |
| `recorder/mp4_recorder_stub.cpp` | Recorder ohne Funktion; `pgm.recording.start` antwortet `recording_unsupported` |
| `build.ps1` | Baut `pgm-helper.exe` neben das Skript, nach dem Muster von `meeting-helper/build.ps1` |

UVC (`uvc_mediafoundation.cpp`):
- **Liste**: `MFEnumDeviceSources` (Video-Capture). `device_id` ist der symbolische Link des Geräts, `stable_key`
  derselbe Link in Kleinbuchstaben (Gerätepfade unterscheiden keine Groß-/Kleinschreibung), `id` = `uvc:<stable_key>`.
  Die virtuelle Broadify-Kamera wird ausgefiltert. `in_use` ist immer `false`: ob ein Gerät belegt ist, zeigt sich
  erst beim Öffnen.
- **Hot-Plug**: `CM_Register_Notification` auf die Geräteklassen Kamera und Video, ohne Fenster und Nachrichtenschleife.
  Die Meldungen werden 300 ms gesammelt, dann kommt genau ein `pgm_inputs_changed`.
- **Moduswahl**: Alle nativen Modi stehen als Ereignis `pgm_uvc_modes` im Log, der gewählte als
  `pgm_uvc_mode_selected`. Lehnt der Reader einen Modus ab (`pgm_uvc_mode_rejected` mit HRESULT), wird der
  nächstbeste versucht.
- **MJPG**: Nur wenn der höchste Modus nicht unkomprimiert angeboten wird. Der Reader bekommt dann NV12 als
  Ausgabetyp (er setzt dafür den MJPEG-Decoder ein), ersatzweise YUY2; den Rest erledigt `frame_to_nv12`. Das Signal
  trägt in diesem Fall `"decode":"mjpg"` (in `pgm_signal` und in `pgm_status.signal`); sonst fehlt das Feld.
- **Bilder**: NV12, YUY2 oder UYVY als Ebenen im Systemspeicher (`CapturedFrame.planes`) mit dem echten Zeilenabstand
  aus `IMF2DBuffer2::Lock2DSize` bzw. `IMF2DBuffer::Lock2D`; der flache `Lock` ist nur der Ausweichweg. Das
  `IMFSample` selbst wird nicht weitergereicht (`nativeHandle` bleibt leer): der Encoder kopiert jedes Bild einmal
  in sein eigenes Sample. Den kopierfreien Weg aus D4 gibt es seit D8 nicht mehr (siehe „Meeting-Programm (D8)“).
- **Zeitstempel**: der Geräte-Zeitstempel des Samples (`MFSampleExtension_DeviceTimestamp`, Performance-Counter),
  wenn er plausibel ist (nicht in der Zukunft, jünger als 1 s), sonst die Ankunftszeit; beides auf der Uhr aus
  `monotonic_clock.h`.
- **Fehlercodes** wie auf macOS: `camera_permission_denied` (Zugriff verweigert), `unsupported_format` (kein
  Medientyp aushandelbar), sonst `device_in_use`. `start` wartet bis zu 750 ms auf das erste Bild oder den ersten
  Fehler, damit ein belegtes Gerät als Antwort auf `pgm.source.select` scheitert. Spätere Fehler (Kabel gezogen)
  kommen als Ereignis `pgm_capture_error` mit Code, HRESULT und Grund; der Status fällt über die Signalmessung auf
  „kein Signal“.
- **Kamera-Datenschutz**: Windows fragt Desktop-Programme nicht. `camera_permission` liest die Einstellung aus der
  Registrierung (`CapabilityAccessManager\ConsentStore\webcam`, dazu `NonPackaged`): `denied` bei „Deny“ für den
  Benutzer, `restricted` bei „Deny“ für das ganze Gerät, sonst `authorized`.

Ton (`audio_capture_wasapi.cpp`):
- Paarung zuerst über die Container-ID: vom symbolischen Link des Videogeräts über die Geräteinstanz zu
  `DEVPKEY_Device_ContainerId`, verglichen mit `PKEY_Device_ContainerId` der aktiven Aufnahme-Endpunkte. Die leere
  Container-ID und die des Rechners selbst (alles Eingebaute teilt sie) zählen nicht. Danach die Namensregel gegen
  Endpunkt- und Gerätenamen. Welche Regel griff, steht im Ereignis `pgm_audio_paired` (`rule`: `container` oder
  `name`). Ohne Treffer: `pgm_audio_unavailable` mit Code `audio_not_paired`, die Vorschau läuft stumm.
- Zeitstempel je Paket aus WASAPI (Performance-Counter), mit derselben Plausibilitätsprüfung wie beim Bild.
- Geht das Gerät im Betrieb verloren (`AUDCLNT_E_DEVICE_INVALIDATED` u. ä.), endet der Capture-Thread mit
  `pgm_audio_unavailable` (Code `audio_device_lost`); das Bild läuft weiter.
- `stop()` wartet nicht auf den Capture-Thread: die Engine stoppt den Ton unter ihrem Mutex, auf den ein laufender
  Callback gerade warten kann. Der Thread hält seinen Zustand selbst und räumt ihn ab.

Standbild und Aufnahme:
- `pgm.snapshot` liefert unter Windows ein JPEG aus dem portablen Weg. Das Bild kann bis zu 200 ms alt sein.
- `pgm.recording.start` antwortet `recording_unsupported`, bevor irgendetwas geprüft wird; `pgm.recording.stop` und
  `pgm.recording.status` antworten wie ohne laufende Aufnahme.

CI (Job `full`), in dieser Reihenfolge:
1. `scripts/build-pgm-helper.sh` ohne Schalter überspringt und hinterlässt weder Build-Verzeichnis noch `pgm-helper.exe`.
2. Derselbe Aufruf mit `BROADIFY_PGM_WINDOWS=1` baut `pgm-helper.exe` und die Tests; ctest läuft im Helper-Verzeichnis.
3. `pgm-helper.exe --probe`: eine JSON-Zeile, Exit-Code 0, leere Geräteliste (der Runner hat keine Kamera).
4. Lauf mit `--synthetic-source 1280x720@30`: Der Runner hat keinen Hardware-Encoder, also muss `pgm_error` mit
   `encoder_unavailable` kommen und darf kein `pgm_encoder_configured` erscheinen (kein stiller Software-Weg). Über
   die Steuer-Pipe werden danach `pgm.status` (`state: error`, kein Encoder), `pgm.snapshot` (JPEG 1280×720),
   `pgm.recording.start` (`recording_unsupported`) und `control.shutdown` (Exit-Code 0, letztes Ereignis `shutdown`
   mit `control_shutdown`) geprüft.
5. `verify-windows-native-dependencies.cjs` auf der wie im Paket abgelegten Datei
   (`resources/native/pgm-helper/` mit der VC-Runtime daneben): nur Windows-eigene DLLs und die VC-Runtime.
6. `pgm-helper.exe` wird unsigniert als Artefakt `pgm-helper-windows-x64-unsigned-<sha>` hochgeladen (14 Tage), für
   die Sitzung am Gerät. Es ist kein Release-Artefakt.

Offen bis zur Sitzung am Gerät (im CI nicht prüfbar, Runbook Abschnitte 5 und 6):
- Der gesamte UVC- und WASAPI-Weg ist nur kompiliert, nie gelaufen: Aushandlung, Zeilenabstände, Lage der
  Chroma-Ebene bei NV12 aus dem MJPEG-Decoder, Hot-Plug, Fehlercodes bei belegtem Gerät.
- Ob die Container-ID bei ATEM Mini und RØDECaster Video für Video und Audio gleich ist (`pgm_audio_paired`).
- Ob die Registrierungswerte der Kamera-Datenschutzeinstellung auf allen Windows-Ständen so heißen; ein falsches
  `denied` würde die Quellenwahl sperren.
- Geht der Ton im Betrieb verloren, meldet `pgm_status.audio` weiter `true` (die Engine erfährt es nur als Ereignis).
- Ohne Hardware-Encoder versucht die Engine die Einrichtung bei jedem Bild neu (wie auf macOS); auf einem Rechner
  ohne Hardware-MFT ist das eine `MFTEnumEx`-Abfrage je Bild.
- `--probe` nennt als Encoder weiter fest `"mediafoundation"`, ohne nach einem Hardware-MFT zu suchen, und keinen
  Gerätemodus (dafür müsste es das Gerät öffnen). Der gewählte Modus steht in `pgm_uvc_mode_selected` und im Signal.

## Portabler Helper (D6)

Der PGM-Helper ist in einen portablen Kern und je eine Plattformschicht geteilt. Das macOS-Verhalten ist dasselbe wie
vorher. Die Windows-Spalte ist seit D7 vollständig.

| Naht | Portable Deklaration | macOS | Windows |
|---|---|---|---|
| Prozess-Host | `src/platform/platform_host.h`: `processArgumentsUtf8`, `installSignalHandlers`, `configureStdoutForEvents`, `initializePlatform`, `startParentWatchdog`, `runPlatformLoop`, `probeEncoderJson` | `platform_host_mac.mm`: SIGINT/SIGTERM, SIGPIPE ignoriert, `NSApplication` als Accessory, Watchdog mit `kill(pid, 0)` alle 2 s, stdout zeilengepuffert | `platform_host_win.cpp`: `SetConsoleCtrlHandler`, COM-MTA + `MFStartup`, Watchdog mit `OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject`, Argumente über `CommandLineToArgvW`, stdout ungepuffert (die UCRT lehnt `_IOLBF` mit Puffergröße 0 ab) |
| Videoquellen | `capture/video_source.h`: `createUvcEnumerator()`, `createSyntheticSource()`, `VideoSource::decode()` | `uvc_avfoundation.mm`, `synthetic_source.mm` | `uvc_mediafoundation.cpp`, `synthetic_source.cpp` |
| Ton | `audio/audio_source.h`: `createPairedAudioSource(Anzeigename, Geräte-ID)` | `audio_capture_avfoundation.mm` (nutzt nur den Namen) | `audio_capture_wasapi.cpp` |
| Standbild | `capture/frame_holder.h`: `retainFrame()` hält das letzte Bild über den Capture-Callback hinaus; `capture/snapshot.h`: `jpegBase64FromFrame()` | `frame_holder_mac.mm` (hält den `CVPixelBuffer`), `snapshot.mm` | `frame_holder_portable.cpp` (Kopie), `snapshot_portable.cpp` |
| Aufnahme | `recorder/mp4_recorder.h`: `supported()`, `appendVideo(const EncodedAccessUnit &)`, `appendAudio(const AudioChunk &)` | `mp4_recorder.mm` reicht an die bisherigen `CMSampleBuffer`-Wege weiter | `mp4_recorder_stub.cpp` |
| Encoder-Sample | `live_stream/video_encoder.h`: `releaseEncodedSample()` | gibt das `CMSampleBuffer` der Einheit frei | nichts zu tun |

- `src/main.cpp` und `src/pgm_engine.cpp` enthalten keine Plattformweichen mehr
  (`scripts/pgm-helper-portable-contract.test.cjs`, Teil von `test:release-contracts`).
- Eine Fabrik darf `nullptr` liefern: ohne UVC-Backend meldet die Engine `input_not_found`, ohne Ton läuft die Vorschau
  stumm. Der Encoder kommt wie bisher aus `createHardwareEncoder()`.
- Die CMake-Option `PGM_HELPER_WINDOWS_COMPILE_CHECK` und der CI-Job `helper` aus D6 (nur Kompilieren) sind mit D7
  entfallen: dieselben Dateien werden jetzt als Teil von `pgm-helper.exe` gebaut.

## WebRTC-Build (D5)

Unter Windows ist `live_stream` der Publisher (`src/publisher.cpp`, derselbe Quelltext wie auf macOS) auf dem
Media-Foundation-Encoder (`live_stream_mf`), dazu libdatachannel v0.22.6 statisch. Der FetchContent-Block ist für
beide Plattformen derselbe; nur die Herkunft von OpenSSL unterscheidet sich.

- **OpenSSL**: `apps/bridge/native/live-stream/vcpkg.json` (Manifest, `builtin-baseline` = vcpkg 2026.10.16, damit
  OpenSSL 3.6.5 wie derzeit unter Homebrew). `scripts/prepare-windows-pgm-deps.ps1` installiert mit Triplet
  `x64-windows-static-md` nach `apps/bridge/native/live-stream/deps/vcpkg_installed/` (gitignoriert) und prüft, dass
  keine OpenSSL-DLL entsteht. vcpkg sucht das Skript in `-VcpkgRoot`, `VCPKG_ROOT`, `VCPKG_INSTALLATION_ROOT`,
  `C:\vcpkg`. Ein Stempel mit dem Hash des Manifests lässt wiederholte Läufe sofort enden.
- **CMake** nutzt keine vcpkg-Toolchain-Datei, nur `OPENSSL_ROOT_DIR` auf diesen Baum (übersteuerbar mit
  `-DOPENSSL_ROOT_DIR=…` oder `LIVE_STREAM_OPENSSL_ROOT`). Fehlt der Baum, bricht die Konfiguration mit dem Hinweis
  auf das Skript ab.
- **Gelinkt** werden `mf mfplat mfuuid mfreadwrite ole32 ws2_32 crypt32 bcrypt iphlpapi`; es kommt keine weitere DLL
  hinzu.
- **Version anheben**: `builtin-baseline` auf einen neueren vcpkg-Commit setzen und den CI-Job `full` laufen lassen.
  Sicherheitsupdates von OpenSSL kommen unter Windows nur auf diesem Weg in den Helper (statisch gelinkt), auf
  macOS über `brew upgrade openssl@3` auf dem Build-Rechner.
- Ohne Schalter konfiguriert ein Windows-Build nichts davon: kein FetchContent, kein OpenSSL, kein neues Target
  (`scripts/pgm-windows-webrtc-contract.test.cjs`).

Offen bis zur Sitzung am Gerät: Firewall-Abfrage beim ersten ICE-Start und Kandidatenwahl auf Rechnern mit mehreren
Netzwerkkarten (Runbook, Abschnitt 7). Der Loopback-Test im CI sagt dazu nichts.

## Encoder (D4)

`live-stream/src/mf_encoder.cpp` ist das Windows-Gegenstück zu `vt_encoder.mm` hinter derselben Schnittstelle
(`VideoEncoder`, `createHardwareEncoder()`). Gebaut wird es nur mit `LIVE_STREAM_WITH_MF` (Ziel `live_stream_mf`);
ohne den Schalter enthält ein Windows-Build nichts davon. Die Entscheidungen liegen in reinen Modulen von
`live_stream_core`, die auf jeder Plattform getestet werden:

| Datei | Inhalt |
|---|---|
| `mf_encoder_policy` | Reihenfolge der Kandidaten, Ratensteuerung, Attribute je `EncodeTarget`, Text für `encoder_unavailable`, Zuordnung Ausgabe → Capture-Zeitstempel |
| `frame_to_nv12` | Bringt ein Bild im Systemspeicher (NV12, YUY2, UYVY, BGRA, RGBA) auf NV12 in Zielgröße; der MFT wandelt und skaliert nicht selbst |
| `mf_encoder.cpp` | Führt die Pläne gegen den MFT aus (nur Windows) |

Ablauf und Regeln:
- **Suche**: genau ein `MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
  NV12 → H264)`. Reihenfolge: NVIDIA, AMD, Intel, unbekannt; innerhalb eines Herstellers die Reihenfolge der
  Aufzählung. Ein MFT, der nicht asynchron ist, wird abgelehnt (`async_required`), bevor er angefasst wird.
- **Kein Kandidat nutzbar**: `configure` scheitert mit `encoder_unavailable`; die Meldung nennt jeden versuchten
  Encoder mit Schritt und HRESULT, z. B. `tried NVIDIA H.264 Encoder MFT: output_type 0xC00D36B4`. Es gibt keinen
  Software-Weg in der Datei; `scripts/pgm-mf-encoder-contract.test.cjs` (Teil von `test:release-contracts`) prüft das
  am Quelltext.
- **Einrichtung je Kandidat**: `MF_TRANSFORM_ASYNC_UNLOCK`, `MF_LOW_LATENCY`, ICodecAPI-Einstellungen, Ausgabetyp
  (H.264, Profil Main bzw. High, mittlere Bitrate), dann Eingabetyp (NV12, BT.709, 16–235; lehnt der Treiber die
  Farbattribute ab, ohne sie), ICodecAPI-Einstellungen ein zweites Mal (Treiber unterscheiden sich darin, wann sie
  sie annehmen), `NOTIFY_BEGIN_STREAMING`, `NOTIFY_START_OF_STREAM`.
- **ICodecAPI**, jede Einstellung nur nach `IsSupported`: Ratensteuerung (Vorschau: Peak-VBR mit Mittel, Maximum und
  1-s-Puffer, sonst CBR; Aufnahme: VBR ohne Deckel, sonst Peak-VBR, sonst CBR), Low-Latency, GOP = fps × 2 s,
  keine B-Frames, CABAC, Qualität gegen Geschwindigkeit. Was gegriffen hat, steht als JSON in
  `EncoderInfo.settings`, z. B. `{"codec_api":true,"rate_control":"peak_vbr","low_latency":true,"gop_frames":120,
  "b_frames_off":true,"cabac":true,"quality_vs_speed":true,"force_keyframe":true,"color_signalled":true}`.
- **Keyframe auf Anforderung**: `CODECAPI_AVEncVideoForceKeyFrame` unmittelbar vor dem `ProcessInput` des Bildes.
  Kann der MFT das nicht, wird er trotzdem genommen, mit 1 s GOP und `"force_keyframe":false` im Bericht.
- **Threads**: ein Encoder-Thread je Encoder besitzt den MFT (COM-MTA, `MFStartup` gezählt). Ereignisse des MFT
  reicht ein kleiner `IMFAsyncCallback` in dessen Warteschlange. `encode()` läuft auf dem Capture-Thread und wartet
  nie auf den Encoder: Bild nach NV12 bringen, in ein Postfach mit einem Platz legen. Liegt dort noch ein Bild, wird
  es ersetzt und als verworfen gezählt; ein angeforderter Keyframe wandert auf das ersetzende Bild.
- **Eingabe**: Jedes Bild wird aus seinen Ebenen im Systemspeicher (`CapturedFrame.planes`) in ein Sample aus einem
  kleinen Vorrat (6 Stück) umgewandelt und dabei auf die Zielgröße gebracht. Ein Sample des Capturers
  (`CapturedFrame.nativeHandle`) wird seit D8 nicht mehr weitergereicht (Grund: „Meeting-Programm (D8)“). Ungerade
  Zielgrößen werden auf gerade gekürzt.
- **Ausgabe**: Annex B; SPS/PPS aus `MF_MT_MPEG_SEQUENCE_HEADER` vor jedem Keyframe, sofern der MFT sie nicht selbst
  mitliefert. `MFT_OUTPUT_STREAM_PROVIDES_SAMPLES` und `MF_E_TRANSFORM_STREAM_CHANGE` werden behandelt. Der
  Zeitstempel jedes Bildes ist wieder der Capture-Zeitstempel in Nanosekunden.
- **`flush()`**: `MFT_MESSAGE_COMMAND_DRAIN`, wartet höchstens 2 s auf `METransformDrainComplete`, startet den Strom
  neu; das nächste Bild ist ein Keyframe.
- **Abbau**: begrenzt auf 3 s (Einrichtung: 15 s). Kehrt ein Treiberaufruf nicht zurück, wird der Encoder-Thread
  zurückgelassen statt den Helper zu blockieren (`mf_encoder_error`, `stage: teardown_timeout`).

Tests:

| Test | Wo | Was |
|---|---|---|
| `mf_encoder_policy_test`, `frame_to_nv12_test` | alle Plattformen | die reinen Module |
| `mf_encoder_fake_mft_test` | Windows mit `LIVE_STREAM_WITH_MF` | Encoder gegen einen asynchronen MFT im Test: Reihenfolge der Einrichtung, Ereignisschleife, Postfach, erzwungener Keyframe, Formatwechsel, Drain, Ausweichen auf den nächsten Kandidaten, Abbau |
| `mf_encoder_software_seam_test` | wie oben | Microsofts Software-H.264-MFT, in den Test-MFT eingewickelt und nur über die Test-Naht (`src/mf_encoder_internal.h`) erreichbar: echte H.264-Daten durch die Media-Foundation-Verdrahtung. Überspringt (77), wenn der MFT fehlt |
| `mf_encoder_smoke_test` | wie oben | echter Hardware-MFT über `createHardwareEncoder()`, 60 NV12-Bilder 720p30. Überspringt (77) ohne Hardware-MFT, also auf dem CI-Runner |
| `pgm_options_test` | alle Plattformen | Kommandozeile des PGM-Helpers: die UTF-8-Argumentliste des Plattform-Hosts ergibt dasselbe wie `argc`/`argv` |
| `uvc_format_select_test` | alle Plattformen | Moduswahl (Geometrie, Rate, Subtyp, 1080-Zeilen-Grenze, ohne MJPG-Decoder) und HRESULT → Fehlercode |
| `audio_pairing_test` | alle Plattformen | Container-ID vor Name, zwei gleiche Geräte, Rechner-Container zählt nicht, Namensregel, nie ein fremdes Mikrofon |
| `snapshot_portable_test` | alle Plattformen | NV12 (mit Zeilenauffüllung) und YUY2 → JPEG → base64; das JPEG wird mit `stb_image` wieder dekodiert und auf Größe und Farben geprüft |
| `portable_sources_test` | alle Plattformen | die Windows-Bausteine in reinem C++: synthetische Quelle (Form, Takt, Bildzähler), kopierender Bildhalter mit Standbild, Recorder-Stub |
| `webrtc_loopback_test` | macOS; Windows mit `LIVE_STREAM_WITH_WEBRTC` | Publisher gegen einen libdatachannel-„Browser“ im selben Prozess: Answer, ICE über Loopback, RTP für eine synthetische IDR-Einheit |

Offen bis zur Sitzung am Gerät (im CI nicht prüfbar):
- Einheit von `CODECAPI_AVEncCommonBufferSize`: gesetzt wird die Spitzenrate über 1 s in Bit (verbreitete Praxis);
  die Dokumentation nennt an einer Stelle Byte. Am Gerät prüfen, ob die Spitzen im Rahmen bleiben (Abschnitt 3).
- Reihenfolge NVIDIA/AMD vor Intel ist eine Annahme nach Hersteller, nicht nach tatsächlicher Leistung oder danach,
  an welcher GPU ein Bildschirm hängt. Auf Hybrid-Laptops mit `BRIDGE_PGM_ENCODER_VENDOR` gegenprüfen.
- Ob jeder Treiber die ICodecAPI-Einstellungen vor oder nach den Medientypen annimmt, zeigt `EncoderInfo.settings`.
- Verhalten bei Geräteverlust (Treiber-Update, GPU-Wechsel): der MFT meldet `MEError`, der Encoder nimmt danach
  keine Bilder mehr an (`encode()` gibt `false` zurück). Den Neuaufbau muss der Aufrufer anstoßen.

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
      Aufnahme bleibt ruckelfrei (Datei danach prüfen). `program.stream.status` zweimal im Abstand von 10 s abfragen:
      `dropped_frames` wächst nicht, und `encoded_frames` wächst um etwa 10 × Bildrate des Programms. Erst der zweite
      Wert zeigt Verluste im Postfach des Media-Foundation-Encoders; dessen eigener Zähler steht noch in keinem Status.
- [ ] `encoder` aus `program.stream.status` notieren (`name`, `vendor_id`, `vendor`, `settings`): welchen Hardware-MFT
      das Meeting-Programm gewählt hat. Mit dem des PGM-Helpers (`pgm_encoder_configured`) vergleichen.
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
