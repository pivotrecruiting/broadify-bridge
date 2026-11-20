# Live-PGM-Vorschau unter Windows (Vorbereitung)

Status: Vorbereitung. Alles liegt hinter zwei Schaltern, die standardmäßig aus sind. Nichts hiervon ist auf
Windows-Hardware geprüft; die CI kompiliert und fährt ctest auf einem GPU-losen Runner. Entscheidungen: ADR-0009
(`docs/bridge/architecture/adr/0009-live-pgm-windows-media-foundation.md`), Grundlage ADR-0002/0004/0005/0006.
macOS-Fassung und Verträge: `docs/bridge/features/pgm-live-preview.md`.

Die Abschnitte folgen den Einheiten der Umsetzung (D0–D10); die Einheit steht jeweils dabei. Was davon wie weit
geprüft ist, steht gleich unten unter „Stand der Prüfung“. Wie man zu einem Build für die Sitzung am Gerät kommt,
steht unter „Opt-in-Build für die Sitzung am Gerät“.

## Stand der Prüfung

Vier Stufen. „macOS“ heißt: auf dem Entwicklungsrechner gebaut und getestet (ctest, jest). „Windows-CI“ heißt: im
Workflow `pgm-windows-native.yml` auf einem `windows-2022`-Runner, der weder GPU noch Kamera noch Audiogerät hat;
dort ist zu unterscheiden, was auch ausgeführt und was nur kompiliert wird. „Offen“ kann erst die Sitzung am Gerät
klären (Runbook unten). Grün im CI heißt nie „auf Hardware geprüft“.

| Baustein (Einheit) | Auf macOS geprüft | Windows-CI: ausgeführt | Windows-CI: nur kompiliert | Offen bis zur Sitzung am Gerät |
|---|---|---|---|---|
| Typen und Schnittstelle: `CapturedFrame`, `createHardwareEncoder()` (D2) | ctest; der VideoToolbox-Weg ist unverändert (`vt_encoder_smoke_test`) | Job `core` | | |
| Pixel-Module RGBA/YUY2/UYVY → NV12, NV12-Skalierung (D3) | ctest mit Referenzwerten | Job `core`: dieselben Tests unter MSVC | | Farben und Range im echten Bild (Runbook 3) |
| Encoder `mf_encoder.cpp` (D4) | nur die reinen Module (`mf_encoder_policy_test`, `frame_to_nv12_test`); die Datei selbst baut nur unter Windows | Job `encoder`: gegen einen asynchronen Test-MFT und, über die Test-Naht, gegen Microsofts Software-MFT | der Weg zum Hardware-MFT: `mf_encoder_smoke_test` überspringt, der Runner hat keinen | jeder Hardware-MFT (NVIDIA, Intel, AMD, Hybrid-Laptop), ICodecAPI je Treiber, zwei Sessions zugleich, Geräteverlust (Runbook 3, 4) |
| WebRTC-Build: libdatachannel, OpenSSL statisch (D5) | `webrtc_loopback_test` mit demselben `publisher.cpp` | Job `full`: Build, Loopback-Test, kein Import einer OpenSSL-DLL (`dumpbin`) | | Firewall-Abfrage, ICE-Kandidaten, TURN (Runbook 7) |
| Portabler Helper: `main.cpp`, Plattform-Host (D6) | ctest; einmal von Hand ein Lauf des Helpers mit der synthetischen Quelle | Job `full`: Start, Steuer-Pipe und `control.shutdown` als Teil von `pgm-helper.exe` | | Konsolenfenster, Wächter auf den Elternprozess, verwaiste Prozesse (Runbook 11) |
| Windows-Quellen des Helpers: UVC, WASAPI, Standbild, Recorder-Stub (D7) | die reinen Module (`uvc_format_select_test`, `audio_pairing_test`, `snapshot_portable_test`, `portable_sources_test`) | Job `full`: `--probe`; der Lauf mit der synthetischen Quelle endet in `encoder_unavailable` (kein Software-Weg); Status, Standbild, `recording_unsupported` | `uvc_mediafoundation.cpp` und `audio_capture_wasapi.cpp`: nie gelaufen | der ganze UVC- und WASAPI-Weg: Aushandlung, Hot-Plug, Paarung, Lippensynchronität, Kamera-Datenschutz (Runbook 5, 6) |
| **Meeting-Programm (D8): Platzhalter. Diese Zeile trägt die Einheit D8 nach.** | | | | |
| Bridge-Gate: `BRIDGE_PGM_WINDOWS`, `windowsHide`, Fähigkeit `recording` (D9) | jest mit eingesetzter Plattform und Umgebung | Job `bridge-tests`: die ganze jest-Suite. **Erster Lauf steht aus.** | | Schalter und Helper-Start in der paketierten Bridge (Runbook 1, 11) |
| Paketierung hinter dem Build-Schalter (D10) | Vertragstest: ohne Schalter nichts vom Helper in den Listen, mit Schalter alle zusammen; die Artefaktprüfung läuft darin mit einem vorgetäuschten Windows-Host. Dass die Listen ohne Schalter die bisherigen sind, ist durch Auswerten vor und nach der Änderung gezeigt, nicht durch den Test (siehe unten) | Job `bridge-tests`: die Vertragstests mit und ohne Schalter, `npm run build:pgm-helper` überspringt ohne Schalter, das Smoke-Skript des Helpers in beiden Zuständen. Job `full`: Artefaktliste, Smoke-Skript (`--probe`) und Abhängigkeitsprüfung gegen die gebaute Exe im Paket-Layout; das Smoke-Skript lehnt zwei kaputte Stellvertreter ab. **Erster Lauf steht aus.** | die Installer-Smoke-Tests: von den PowerShell-Skripten wird nur die Syntax geprüft | alles, was erst ein Build mit Schalter durchläuft: `dist:win` als Ganzes, der Schritt in den Release-Workflows, electron-builder mit der Exe, ihre Signatur, NSIS- und MSI-Smoke-Test, Smart App Control (Runbook 10) |
| Aufnahme unter Windows | | | Stub (`recording_unsupported`) | nicht umgesetzt (ADR-0009, Punkt 7) |

- Ohne den Build-Schalter enthält ein Windows-Release nichts vom Helper: nicht im Paket, nicht in der Signierliste,
  nicht in den VC-Runtime-Ordnern, nicht in der Artefakt- und Abhängigkeitsprüfung. Das hält
  `scripts/pgm-helper-windows-release-contract.test.cjs` fest; die Einzelheiten stehen unter „Paketierung (D10)“.
  Der Test enthält keine Soll-Liste der übrigen Einträge. Dass die Listen ohne Schalter dieselben sind wie vor der
  Einheit, ist durch Auswerten gezeigt: alle Listen und die ganze electron-builder-Konfiguration vor und nach der
  Änderung verglichen, einmal bei der Umsetzung und einmal unabhängig bei der Prüfung.
- Der Job `bridge-tests` probt das Tor eines Windows-Release: `dist:win` ruft `npm run build` auf, und das beginnt
  mit `npm run test` (jest und die Vertragstests). Jeder dieser Tests läuft also im Release-Build unter Windows; einer,
  der vom Rechner abhängt, bricht das Release. Der Job fährt dasselbe vor dem Merge, mit den Installationsschritten
  aus `release.yml` und ohne Secrets. Nicht nachgestellt ist der Lauf der Tests innerhalb von `dist:win` selbst, also
  nach den nativen Builds und mit der Signier-Umgebung.

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
| `LIVE_STREAM_WITH_MF=ON` | Build (CMake-Option oder Umgebung, nur `live-stream`) | Baut allein den Media-Foundation-Encoder und seine Tests, ohne WebRTC/OpenSSL. Wird von `BROADIFY_PGM_WINDOWS=1` mit eingeschaltet | aus |
| `LIVE_STREAM_WITH_WEBRTC=ON` | Build (CMake-Option, nur `live-stream`) | Baut unter Windows den WebRTC-Teil (`live_stream`: `publisher.cpp` auf dem Encoder, libdatachannel, statisches OpenSSL) und `webrtc_loopback_test`. Schaltet `LIVE_STREAM_WITH_MF` mit ein. Wird von `BROADIFY_PGM_WINDOWS=1` mit eingeschaltet; auf macOS ist es immer an | aus (Windows) |
| `BRIDGE_PGM_ENCODER_VENDOR=nvidia\|intel\|amd` | Laufzeit (Umgebung des Helpers) | Zieht die Hardware-MFTs dieses Herstellers in der Reihenfolge nach vorn (Gerätetest auf Hybrid-Laptops). Die übrigen bleiben Ausweichkandidaten. Die Reihenfolge zeigt `--probe` (`encoder_candidates`); welcher Encoder läuft, steht in `pgm_encoder_configured` und im Status (`name`, `vendor`) | nicht gesetzt |

- Ohne Build-Schalter kommt nichts vom Live-Programm in Paket, Signatur und Prüfungen eines Windows-Release (siehe
  „Paketierung (D10)“). Gebaut werden zusätzlich nur die reinen Module von `live_stream_core` und ihre Tests, die
  auf jeder Plattform laufen. Windows-eigene Targets (Encoder, WebRTC, `pgm-helper.exe`, Meeting-`ProgramStream`)
  sind opt-in, weil `npm run test:meeting-helper-native` in `dist:win` alle Targets des Build-Verzeichnisses baut.
- Der Build-Schalter gilt nur mit dem Wert `1`; jeder andere Wert zählt als aus (Build-Skript, CMake und
  Paketlisten prüfen gleich).
- Ohne Laufzeit-Schalter antwortet auch eine mit Build-Schalter gebaute Bridge wie heute
  (`pgm_unsupported_bridge`, Meeting: `program_stream_unavailable`).
- Die bestehenden Schalter gelten weiter: `BRIDGE_PGM_PREVIEW=0` (Notaus), `BRIDGE_PGM_MAX_VIEWERS`,
  `BRIDGE_PGM_SYNTHETIC_SOURCE=1920x1080@60`, `BRIDGE_LOG_PERF=1`, `BRIDGE_PGM_HELPER_PATH`. Die synthetische Quelle
  gibt es unter Windows seit D7 (`capture/synthetic_source.cpp`); sie braucht kein Gerät, aber wie jede Quelle einen
  Hardware-Encoder.
- Freischalten (Standard ändern) ist eine eigene Entscheidung nach der Sitzung am Gerät.

## Bridge-Gate (D9)

Was die Bridge mit `BRIDGE_PGM_WINDOWS` macht. Es entscheidet eine Stelle: `isPgmPlatformSupported(platform, env)` in
`apps/bridge/src/services/pgm/pgm-env.ts`. macOS ist immer an, Windows nur mit `1`, `true` oder `on` (Groß-/Kleinschreibung
und Leerzeichen egal), jede andere Plattform nie. Der Notaus `BRIDGE_PGM_PREVIEW=0` ist davon getrennt und geht vor.

| | macOS | Windows ohne Schalter (Standard) | Windows mit `BRIDGE_PGM_WINDOWS=1` |
|---|---|---|---|
| `live_program.supported`, `audio`, `meeting_preview` | `true` | `false` | `true` |
| `live_program.recording` (neu) | `true` | `false` | `false` |
| `live_program.recording_profile` | `"high"` | fehlt | fehlt |
| `pgm_*` mit Nebenwirkung | wie bisher | `pgm_unsupported_bridge` („Windows preview not enabled on this bridge.“) | an den Helper |
| `pgm_recording_pick_path`, `_start`, `_stop` | wie bisher | `pgm_unsupported_bridge` | `recording_unsupported`, von der Bridge selbst: kein Speicherdialog, kein Helper-Aufruf |
| `meeting_program_offer` | wie bisher | `program_stream_unavailable` mit der Meldung des Stubs; der Meeting-Helper wird nicht gefragt | an den Meeting-Helper |
| `meeting_program_status.supported` | vom Helper | `false` | vom Helper |
| Start des PGM-Helpers | Launch Services, Codesign-Prüfung | nie, auch nicht für eine gespeicherte Quelle beim Bridge-Start (`restoreOnBoot`) | direkt per `spawn` mit `windowsHide: true`, ohne Codesign-Prüfung, Ereignisse über stdout |

- `pgm_get_status` und `pgm_session_list` antworten auf jeder Plattform wie bisher.
- Reihenfolge der Ablehnungen: `pgm_disabled` vor `pgm_unsupported_bridge` vor `recording_unsupported`; beim
  Meeting-Programm `pgm_disabled`, dann `meeting_engine_not_running`, dann `program_stream_unavailable`.
- Was sich am Standard ändert: Der Fähigkeitsblock hat auf beiden Plattformen das Feld `recording`, und unter Windows
  lautet die Meldung zu `pgm_unsupported_bridge` „Windows preview not enabled on this bridge.“ statt „Live program
  preview ships for macOS bridges first; Windows follows.“. Fehlercodes, die übrigen Felder und das Verhalten bleiben
  gleich.
- `windowsHide`: `services/helpers/helper-launch.ts` benutzt nur der PGM-Helper-Manager. Meeting-, Display-, DeckLink-
  und die übrigen Helper starten über eigenen Code, ihr Start unter Windows ändert sich nicht; auf macOS ignoriert Node
  die Option. `helper-launch.test.ts` hält fest, dass nur `pgm-helper-manager.ts` die Datei importiert: Wer einen
  weiteren Helper darauf umzieht, entscheidet dabei über `windowsHide` für diesen Helper.
- Tests: `pgm-env.test.ts`, `pgm-command-handler.test.ts` (Standard auf macOS und Windows, Schalter, Notaus),
  `pgm-helper-manager.win32.test.ts` (Startweg unter Windows), `helper-launch.test.ts`, `meeting-program-stream.test.ts`.
  Alle laufen auch im Windows-Release-Build (`dist:win` ruft `npm run test` auf) und hängen nicht von der Plattform des
  Rechners ab.

### Folgearbeit in der Web-App (eigenes Repo)
- `capabilities.live_program.recording` lesen: Bei `false` die Aufnahme-Knöpfe der Signalcheck-Karte ausblenden
  (`components/live-program/live-program-source-card.tsx`; heute erscheinen sie, sobald eine Quelle gewählt ist). Fehlt
  das Feld (ältere Bridges, die es nur für macOS gab), gilt `supported`. Den Typ `LiveProgramCapabilitiesT` in
  `types/bridge-types.ts` um `recording?: boolean` ergänzen.
- `recording_unsupported` als eigenen Fehlertext abbilden; bis dahin zeigt die Karte die englische Meldung der Bridge.
- Der offene Web-PR #331 (`fix-live-program-windows-message`) zeigt bei `supported: false` auf einer Windows-Bridge „Das
  Live-Programm ist auf diesem Betriebssystem noch nicht verfügbar.“ statt der Bitte, die Bridge zu aktualisieren. Mit
  dem Schalter meldet die Windows-Bridge `supported: true` und bekommt die normale Kachel; Ablehnungen zur Laufzeit
  (`pgm_unsupported_bridge`, `program_stream_unavailable`) zeigen dort weiter den Plattform-Hinweis. Das passt zu diesem
  Gate; der PR braucht dafür keine Änderung.
- Bis die Web-App `recording` liest, sieht ein Windows-Nutzer **mit** Schalter die Aufnahme-Knöpfe und bekommt beim
  Klick `recording_unsupported`. Ohne Schalter (jedes Release) ändert sich in der Web-App nichts.

## Paketierung (D10)

Ob `pgm-helper.exe` zu einem Windows-Build gehört, entscheidet eine Stelle: `isWindowsPgmHelperEnabled(env)` in
`scripts/lib/windows-pgm-helper.cjs`. `BROADIFY_PGM_WINDOWS` muss genau `1` sein; so prüfen auch
`scripts/build-pgm-helper.sh` und `live-stream/CMakeLists.txt`. Alle Listen lesen von dort, die Bash- und
PowerShell-Skripte über `scripts/list-windows-pgm-helper-paths.cjs`, das ohne Schalter nichts ausgibt.

| Stelle | Ohne Schalter (jedes Release) | Mit `BROADIFY_PGM_WINDOWS=1` |
|---|---|---|
| `dist:win` → `npm run build:pgm-helper` | überspringt („Skipping PGM helper build on …“) | baut `apps/bridge/native/pgm-helper/pgm-helper.exe` über `build.ps1` |
| `electron-builder.config.cjs`, `win.extraResources` | wie bisher | dazu `pgm-helper.exe` nach `resources/native/pgm-helper/` und die VC-Runtime in denselben Ordner |
| Signierliste (`scripts/sign-windows-native-resources.cjs`) | `WINDOWS_NATIVE_RESOURCES` | dazu `resources/native/pgm-helper/pgm-helper.exe`; fehlt die Datei im Paket, bricht das Signieren ab |
| VC-Runtime-Ordner (`scripts/lib/windows-vc-runtime.cjs`) und Abhängigkeitsprüfung (`scripts/verify-windows-native-dependencies.cjs`) | `native/display-helper`, `native/meeting-helper` | dazu `native/pgm-helper`; fehlt der Ordner im Paket, schlägt die Prüfung fehl |
| `scripts/verify-release-artifacts.sh` | wie bisher | verlangt `pgm-helper.exe`: vorhanden, ausführbar, x64 |
| Installer-Smoke-Tests (NSIS, MSI) | rufen `scripts/test-windows-pgm-helper.ps1` auf; das tut dann nichts | Datei vorhanden, VC-Runtime daneben, `pgm-helper.exe --probe` antwortet |
| `scripts/verify-windows-release-signatures.ps1` | wie bisher | prüft `pgm-helper.exe` wie jede gepackte `.exe`, dazu die VC-Runtime im Helper-Ordner |
| `release.yml`, `test-release.yml` | der Schritt „Install static OpenSSL (Windows, for pgm-helper, opt-in build only)“ wird übersprungen | der Schritt läuft (`scripts/prepare-windows-pgm-deps.ps1`) |

- Die Release-Workflows setzen den Schalter nicht. Neu ist in beiden Dateien nur der eine Schritt mit der Bedingung
  `env.BROADIFY_PGM_WINDOWS == '1'`.
- Der Schalter muss für den ganzen Job gelten, nicht für einzelne Schritte: Build, Abhängigkeitsprüfung,
  Signaturprüfung und Smoke-Tests lesen ihn jeweils selbst.
- Er wirkt auf den ganzen Windows-Build, nicht nur auf den PGM-Helper: Auch im Build-Verzeichnis des Meeting-Helpers
  wird `live-stream` dann mit Encoder und WebRTC-Teil konfiguriert, und `npm run test:meeting-helper-native` baut und
  testet das mit. Deshalb steht der OpenSSL-Schritt in den Workflows vor dem ganzen Build.
- Das macOS-Paket reagiert auf den Schalter nicht.
- Ein Paket mit Helper bleibt aus, bis die Bridge mit `BRIDGE_PGM_WINDOWS=1` läuft (siehe „Bridge-Gate (D9)“).
- `SKIP_PGM_HELPER_BUILD=1` zusammen mit dem Schalter lässt den Build aus; die Artefaktprüfung verlangt die Exe
  trotzdem und bricht ab.
- Vertragstest: `scripts/pgm-helper-windows-release-contract.test.cjs`, Teil von `test:release-contracts` und damit
  von jedem Release-Build. Ohne Schalter enthalten Paket, Signierliste, VC-Runtime-Ordner, Abhängigkeits- und
  Artefaktprüfung nichts vom Helper; mit Schalter kommen sie zusammen. `release.yml` nennt den Schalter nur in der
  Bedingung des einen Schritts. Für `test-release.yml` gilt dasselbe, außer in einem Opt-in-Build (nächster
  Abschnitt).
- In `pgm-helper.exe` sind libdatachannel (mit libjuice, usrsctp, libSRTP und plog), OpenSSL und Opus statisch
  gelinkt; alle stehen in `NOTICES.md`.

## Opt-in-Build für die Sitzung am Gerät

Drei Wege. Keiner ändert `dev`, keiner ist ein Release. Ob der Build-Schalter in einer Shell wirkt, zeigt
`node scripts/list-windows-pgm-helper-paths.cjs`: Die Ausgabe ist `native/pgm-helper/pgm-helper.exe` oder leer.

### A. Nur der Helper aus dem CI (unsigniert, ohne eigenen Build)
Der Job `full` lädt `pgm-helper.exe` als Artefakt `pgm-helper-windows-x64-unsigned-<sha>` hoch (14 Tage).

```powershell
gh run list --workflow pgm-windows-native.yml --branch <branch> --limit 5
gh run download <run-id> --name pgm-helper-windows-x64-unsigned-<sha> --dir C:\broadify-pgm
```

- Die Exe braucht die VC-Runtime. Mit Visual Studio oder dem VC++-Redistributable ist sie auf dem Rechner; sonst die
  DLLs aus `scripts/lib/windows-vc-runtime.cjs` daneben legen.
- Die Bridge findet die Exe über `BRIDGE_PGM_HELPER_PATH` (siehe „Laufzeit-Schalter setzen“).
- Reicht für alles, was nur den PGM-Helper betrifft (Runbook-Abschnitte 2, 3, 5 bis 9 und 13). Das Meeting-Programm
  (Abschnitte 4 und 12) braucht einen Meeting-Helper aus einem Build mit Schalter, also Weg B oder C; die Signatur
  (10) und der Start aus dem Paket (11) brauchen Weg C.

### B. Dev-Build auf dem Windows-Rechner
Die Befehle stehen unter „Build“. Nur so läuft ctest gegen den Hardware-MFT (Runbook, Abschnitt 1).

Ein unsignierter Installer entsteht daraus, wenn alles vorbereitet ist, was `dist:win` auch ohne Schalter braucht
(`docs/windows-build-guide.md`; `docs/signing/windows-signing.md`, Abschnitt 4). Dieser Ablauf ist noch nie
gelaufen:

```powershell
# Developer PowerShell for VS 2022, im Repo
$env:BROADIFY_PGM_WINDOWS = "1"
$env:BROADIFY_ALLOW_UNSIGNED_WINDOWS_BUILD = "1"
.\scripts\prepare-windows-pgm-deps.ps1
npm run dist:win
```

### C. Signierter Installer aus der Test-Pipeline
`test-release.yml` baut, signiert und prüft wie ein Release, veröffentlicht aber nichts. Der Schalter wird dort auf
einem Wegwerf-Branch gesetzt, der nie nach `dev` gemergt wird. Der Branch muss `test-release/pgm-windows` heißen
(oder so beginnen): Im CI lässt der Vertragstest den Schalter nur dort gelten.

```bash
git fetch origin
git switch -c test-release/pgm-windows origin/dev   # oder der Stand, der alle D-Einheiten enthält
```

In `.github/workflows/test-release.yml` im Block `env:` des Jobs `build` eine Zeile ergänzen, sechs Leerzeichen
eingerückt wie `GYP_MSVS_VERSION`:

```yaml
      BROADIFY_PGM_WINDOWS: "1"
```

```bash
BROADIFY_PGM_WINDOWS=1 npm run test:release-contracts   # grün
npm run test:release-contracts                           # auf diesem Branch mit Absicht rot
git commit -am "ci(test-release): build with the Windows live program switch (never merge)"
git push origin test-release/pgm-windows
gh run list --workflow test-release.yml --branch test-release/pgm-windows --limit 1
gh run watch <run-id>
gh run download <run-id> --name test-win-x64 --dir dist-pgm-windows
```

- Der Vertragstest erlaubt die Zeile nur in `test-release.yml`, nur für den ganzen Job und nur, wenn er selbst mit
  dem Schalter läuft; in diesem Build ist das so. Ohne Schalter ist er rot, also auch in jedem Release-Build: Die
  Zeile kann nicht unbemerkt auf `dev` liegen. Läuft er in GitHub Actions, verlangt er zusätzlich einen Branch,
  dessen Name mit `test-release/pgm-windows` beginnt: Eine verirrte Zeile auf einem anderen Ref ergibt keinen
  signierten Installer mit Helper. `release.yml` darf den Schalter nie setzen. Der Name wird in jeder Schreibweise
  erkannt, weil Windows Umgebungsvariablen ohne Rücksicht auf Groß- und Kleinschreibung liest.
- Der Lauf baut `pgm-helper.exe`, packt, signiert und prüft sie wie in der Tabelle unter „Paketierung (D10)“. Das
  Ergebnis ist der RC-Installer (NSIS und MSI) mit Helper.
- Der erste Lauf dieser Art ist zugleich der erste Durchlauf von `dist:win` mit Schalter. Schlägt er fehl, ist das
  ein Befund für „Stand der Prüfung“.
- Nach der Sitzung den Branch löschen.

### Laufzeit-Schalter setzen
Auch ein Paket mit Helper bleibt aus, bis die Bridge den Laufzeit-Schalter sieht.

- Installierte Bridge: in `userData\.env` (RC-Kanal: `%APPDATA%\Broadify Bridge RC\.env`, siehe
  `docs/bridge/USERDATA_ON_REINSTALL.md`):

  ```
  BRIDGE_PGM_WINDOWS=1
  BRIDGE_LOG_PERF=1
  BROADIFY_DISABLE_AUTO_UPDATE=1
  ```

  Ohne die letzte Zeile ersetzt das nächste reguläre RC den Test-Build, und das enthält keinen Helper. Für Weg A
  kommt `BRIDGE_PGM_HELPER_PATH=C:\broadify-pgm\pgm-helper.exe` dazu.
- Dev-Build: die Umgebungsvariablen am Ende von „Build“.
- Kontrolle im installierten Paket (Weg C):

  ```powershell
  $helper = "$env:ProgramFiles\BroadifyBridgeRC\resources\native\pgm-helper\pgm-helper.exe"
  Test-Path $helper
  & $helper --probe
  Get-AuthenticodeSignature $helper | Format-List Status, SignerCertificate
  ```

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
| `common/encoder_info_json` (rein) | Was der gewählte Encoder über sich meldet, als JSON-Felder für Ereignis und Status; dazu die Kandidatenliste für `--probe` |
| `common/encoder_retry_backoff.h` (rein) | Takt der Einrichtungsversuche des Encoders nach einem Fehlschlag: dasselbe Ziel alle 3 s, ein anderes sofort |
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
  in sein eigenes Sample. Der kopierfreie Weg aus D4 ist damit vorhanden, aber nicht in Benutzung.
- **Zeitstempel**: der Geräte-Zeitstempel des Samples (`MFSampleExtension_DeviceTimestamp`, Performance-Counter),
  wenn er plausibel ist (nicht in der Zukunft, jünger als 1 s), sonst die Ankunftszeit; beides auf der Uhr aus
  `monotonic_clock.h`.
- **Fehlercodes** wie auf macOS: `camera_permission_denied` (Zugriff verweigert), `unsupported_format` (kein
  Medientyp aushandelbar), sonst `device_in_use`. `start` wartet bis zu 750 ms auf das erste Bild oder den ersten
  Fehler, damit ein belegtes Gerät als Antwort auf `pgm.source.select` scheitert. Spätere Fehler (Kabel gezogen,
  oder ein erstes Lesen, das erst nach diesen 750 ms scheitert) kommen als Ereignis `pgm_capture_error` mit Code,
  HRESULT und Grund; der Status fällt über die Signalmessung auf „kein Signal“.
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
- `stop()` beendet die Zustellung, bevor es zurückkehrt: Es wartet auf einen laufenden Aufruf der Senke, danach
  kommt keiner mehr. Die Engine ruft es deshalb außerhalb ihres Mutex auf, den dieser Aufruf braucht. Auf den
  Capture-Thread selbst wartet es nicht; der hält seinen Zustand und räumt ihn ab.

Standbild und Aufnahme:
- `pgm.snapshot` liefert unter Windows ein JPEG aus dem portablen Weg. Das Bild kann bis zu 200 ms alt sein.
- `pgm.recording.start` antwortet `recording_unsupported`, bevor irgendetwas geprüft wird; `pgm.recording.stop` und
  `pgm.recording.status` antworten wie ohne laufende Aufnahme.

Encoder (`pgm_engine.cpp`, `common/encoder_info_json`):
- **Welcher Encoder läuft**, steht im Ereignis `pgm_encoder_configured` und im Status unter `encoder` (Ereignis
  `pgm_status`, Antwort auf `pgm.status`). Immer dabei sind `backend` (`mediafoundation`, auf macOS `videotoolbox`)
  und `hardware`. Unter Windows kommen dazu, soweit der Encoder sie meldet: `name` (Anzeigename des MFT),
  `vendor_id` (z. B. `VEN_10DE`), `vendor` (`nvidia`, `amd`, `intel` oder `unknown`) und `settings`, die
  Einstellungen, die gegriffen haben (`codec_api`, `rate_control` mit `peak_vbr`, `cbr`, `vbr` oder `default`,
  `low_latency`, `gop_frames`, `b_frames_off`, `cabac`, `quality_vs_speed`, `force_keyframe`, `color_signalled`).
  Ist der Bericht des Encoders kein einzeiliges JSON-Objekt, steht er als Text unter `settings_text`.
- **`--probe`** listet unter `encoder_candidates` die Hardware-MFTs des Rechners in der Reihenfolge, in der der
  Encoder sie versucht (`BRIDGE_PGM_ENCODER_VENDOR` eingerechnet), je mit `name`, `vendor_id` und `vendor`. Es ist
  die Aufzählung des Encoders und nur eine Aufzählung: Kein MFT wird aktiviert, kein Gerät geöffnet. `[]` heißt
  „kein Hardware-MFT“, `null` „Aufzählung gescheitert“. `encoder` bleibt der Name des Backends. Auf macOS fehlt das
  Feld.
- **Einrichtungsversuche**: Scheitert die Einrichtung, wird sie für dasselbe Ziel alle 3 s wiederholt, nicht bei
  jedem Bild; ändert sich das Signal oder das Ziel, sofort.
- **Ohne Kamera**: Ein Lauf mit `--synthetic-source 1280x720@30` richtet den Encoder ein. So lässt sich die
  Hardware-Matrix ohne Gerät aufnehmen (Runbook, Abschnitt 3).

CI (Job `full`), in dieser Reihenfolge:
1. `scripts/build-pgm-helper.sh` ohne Schalter überspringt und hinterlässt weder Build-Verzeichnis noch `pgm-helper.exe`.
2. Derselbe Aufruf mit `BROADIFY_PGM_WINDOWS=1` baut `pgm-helper.exe` und die Tests; ctest läuft im Helper-Verzeichnis.
3. `pgm-helper.exe --probe`: eine JSON-Zeile, Exit-Code 0, leere Geräteliste (der Runner hat keine Kamera). Geprüft
   werden Exit-Code, `encoder` und `camera_permission`; die ganze Zeile mit `encoder_candidates` steht im Log.
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
- Die Felder `name`, `vendor_id`, `vendor` und `settings` und die Liste `encoder_candidates` hat noch kein
  Hardware-MFT gefüllt: Der CI-Runner hat keinen, dort endet der Lauf in `encoder_unavailable`.
- `--probe` nennt keinen Gerätemodus (dafür müsste es das Gerät öffnen). Der gewählte Modus steht in
  `pgm_uvc_mode_selected` und im Signal.

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
- **Eingabe**: NV12-`IMFSample` in Zielgröße (`CapturedFrame.nativeHandle`) wird ohne Kopie weitergereicht, und zwar
  als neues Sample um dieselben Puffer, damit das Sample des Capturers seine Zeitstempel behält. Alles andere wird
  in ein Sample aus einem kleinen Vorrat (6 Stück) umgewandelt. Ungerade Zielgrößen werden auf gerade gekürzt.
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
| `encoder_info_json_test` | alle Plattformen | Encoder-Identität als JSON: nur gemeldete Felder, Einordnung des Herstellers, `settings` als Objekt oder als `settings_text`, Kandidatenliste in der Reihenfolge des Encoders; die Zeile bleibt in jedem Fall ein JSON-Objekt |
| `encoder_retry_backoff_test` | alle Plattformen | Takt nach einem Fehlschlag: dasselbe Ziel erst nach 3 s wieder, ein anderes Ziel und ein Zurücksetzen sofort |
| `webrtc_loopback_test` | macOS; Windows mit `LIVE_STREAM_WITH_WEBRTC` | Publisher gegen einen libdatachannel-„Browser“ im selben Prozess: Answer, ICE über Loopback, RTP für eine synthetische IDR-Einheit |

Offen bis zur Sitzung am Gerät (im CI nicht prüfbar):
- Einheit von `CODECAPI_AVEncCommonBufferSize`: gesetzt wird die Spitzenrate über 1 s in Bit (verbreitete Praxis);
  die Dokumentation nennt an einer Stelle Byte. Am Gerät prüfen, ob die Spitzen im Rahmen bleiben (Abschnitt 3).
- Reihenfolge NVIDIA/AMD vor Intel ist eine Annahme nach Hersteller, nicht nach tatsächlicher Leistung oder danach,
  an welcher GPU ein Bildschirm hängt. Auf Hybrid-Laptops mit `BRIDGE_PGM_ENCODER_VENDOR` gegenprüfen.
- Ob jeder Treiber die ICodecAPI-Einstellungen vor oder nach den Medientypen annimmt, zeigt `settings` im Ereignis
  `pgm_encoder_configured` (aus `EncoderInfo.settings`).
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
- [ ] Build nach „Opt-in-Build für die Sitzung am Gerät“: Weg B auf dem Rechner, für die Abschnitte 10 und 11
      zusätzlich der Installer aus Weg C.

### 1. Einrichtung
- [ ] Grafiktreiber aktuell; Version notieren (`dxdiag` → Anzeige, oder Geräte-Manager).
- [ ] Build wie oben mit `BROADIFY_PGM_WINDOWS=1`; ctest-Ergebnis notieren (übersprungene Tests ausdrücklich).
- [ ] Der Encoder-Smoke-Test läuft auf diesem Rechner **nicht** als „übersprungen“, sondern gegen den Hardware-MFT.
      Seine Ausgabe (`mf_encoder_smoke_test encoder: <Name> (<Hersteller-ID>) settings {…}`) sichern mit
      `ctest --test-dir apps\bridge\native\pgm-helper\build --build-config Release -R mf_encoder_smoke_test --verbose`.
      Sie ist die Gegenprobe zu dem, was der Helper in Abschnitt 3 meldet: Name und Einstellungen müssen gleich sein.
- [ ] Gegenprobe Schalter aus: Bridge ohne `BRIDGE_PGM_WINDOWS` starten → `get_status.capabilities.live_program.supported`
      ist `false`, Web-App zeigt das Fenster nicht bzw. den bekannten Hinweis; kein `pgm-helper.exe` im Task-Manager.
- [ ] Bridge mit `BRIDGE_PGM_WINDOWS=1` starten → `supported: true`, `recording` aus.

### 2. `--probe`
```powershell
.\apps\bridge\native\pgm-helper\pgm-helper.exe --probe
```
- [ ] Ausgabe ist eine JSON-Zeile
      `{"type":"probe","inputs":{"inputs":[…],"camera_permission":"…"},"encoder":"mediafoundation","encoder_candidates":[…]}`.
      `encoder` nennt das Backend und steht fest.
- [ ] `encoder_candidates` nennt mindestens einen Hardware-MFT (`name`, `vendor_id`, `vendor`), keinen
      Software-Encoder. Der erste Eintrag ist der, den der Encoder zuerst versucht. `[]` heißt: Dieser Rechner hat
      keinen Hardware-H.264-MFT, Abschnitt 3 endet dann in `encoder_unavailable`. `null` heißt: Die Aufzählung ist
      gescheitert; notieren.
- [ ] Mit `$env:BRIDGE_PGM_ENCODER_VENDOR = "intel"` (bzw. `nvidia`, `amd`) rückt dieser Hersteller in der Liste nach
      vorn; ohne die Variable gilt NVIDIA, AMD, Intel, unbekannt.
- [ ] `--probe` öffnet kein Gerät und aktiviert keinen MFT. Der gewählte UVC-Modus steht deshalb nicht hier, sondern
      in `pgm_uvc_mode_selected` (Abschnitt 5), der gewählte Encoder in `pgm_encoder_configured` (Abschnitt 3).
- [ ] `camera_permission` passt zur Datenschutzeinstellung des Rechners (`authorized`, sonst `denied` oder
      `restricted`).
- [ ] Angeschlossene UVC-Geräte erscheinen mit stabilen Schlüsseln; zweimal ausführen, Schlüssel bleiben gleich.
- [ ] Ohne angeschlossenes Gerät: leere Liste, Exit-Code 0, kein Absturz.
- [ ] Exit-Code und Laufzeit notieren (soll unter wenigen Sekunden bleiben).

### 3. Hardware-Matrix Encoder
Die synthetische Quelle braucht kein Gerät; unter Windows liefert sie NV12 im Systemspeicher (seit D7). Der Helper
richtet den Encoder ein, sobald das Signal gemessen ist, auch ohne Zuschauer. Welcher MFT es geworden ist, steht dann
in einer Zeile auf stdout:

```powershell
# optional: $env:BRIDGE_PGM_ENCODER_VENDOR = "intel"
.\apps\bridge\native\pgm-helper\pgm-helper.exe --run --control-socket \\.\pipe\broadify-pgm-matrix --synthetic-source 1920x1080@60
# ... {"type":"pgm_encoder_configured","width":1920,"height":1080,…,"backend":"mediafoundation","hardware":true,
#      "name":"…","vendor_id":"VEN_…","vendor":"…","settings":{…}}      Ende mit Strg+C
```

- [ ] Je Rechner die Zeile `pgm_encoder_configured` sichern: `name` und `vendor` für die Spalte „MFT-Name“,
      `settings` für „Low-Latency ok“ (`low_latency`, `rate_control`, `b_frames_off`, `force_keyframe`). `hardware`
      ist `true`. Dasselbe zeigt `pgm.status` unter `encoder`.
- [ ] Kommt stattdessen `pgm_error` mit `encoder_unavailable`: Meldung sichern (sie nennt jeden versuchten MFT mit
      Schritt und HRESULT). Der Helper versucht es alle 3 s erneut, nicht bei jedem Bild.

Die übrigen Spalten mit der Bridge, `BRIDGE_PGM_SYNTHETIC_SOURCE=1920x1080@60` und einem Zuschauer:

| GPU | Treiber | MFT-Name | 1080p60 ok | Low-Latency ok | Keyframe auf PLI | CPU Helper % | Bemerkung |
|---|---|---|---|---|---|---|---|
| NVIDIA |  |  |  |  |  |  |  |
| Intel (Quick Sync) |  |  |  |  |  |  |  |
| AMD |  |  |  |  |  |  |  |
| Hybrid-Laptop (iGPU aktiv) |  |  |  |  |  |  |  |
| Hybrid-Laptop (dGPU erzwungen) |  |  |  |  |  |  |  |

- [ ] `pgm_encoder_configured` (im Helper-Ereignislog) nennt denselben Encoder wie oben, dazu Auflösung, Bildrate
      und Bitrate. `pgm_perf` (`BRIDGE_LOG_PERF=1`) zeigt Kodier-fps = Quell-fps, keine wachsenden Drops.
- [ ] Keine B-Frames: Bild im Browser läuft ohne Sprünge; `chrome://webrtc-internals` zeigt gleichmäßige
      `framesDecoded`, keine wachsenden `framesDropped`.
- [ ] Neuer Zuschauer bekommt sofort ein Bild (Keyframe bei Beitritt); Tab neu laden → Bild in unter 1 s.
- [ ] Profil `remote` (720p) wählen → Skalierung stimmt (kein Versatz, keine grünen Ränder, Farben wie in 1080p).
- [ ] Farben gegen macOS vergleichen (Farbbalken): kein sichtbarer Range-/Matrix-Fehler (BT.709, Video-Range).
- [ ] Hybrid-Laptop: welcher MFT wird gewählt, wenn das interne Display an der iGPU hängt? Auf Akku wiederholen.
- [ ] Rechner ohne Hardware-H.264 (falls vorhanden: VM oder RDP-Sitzung): `--probe` zeigt `encoder_candidates: []`,
      der Lauf endet in einem sauberen `encoder_unavailable`, kein Bild, kein Software-Fallback, Helper bleibt
      bedienbar, CPU-Last des Helpers unauffällig (Wiederholung alle 3 s).

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
- [ ] Installer aus einem Build mit `BROADIFY_PGM_WINDOWS=1` (signiert über die Test-Pipeline, **kein** Release;
      Weg C unter „Opt-in-Build für die Sitzung am Gerät“): `Get-AuthenticodeSignature` für `pgm-helper.exe` und
      `meeting-helper.exe` → `Valid`, Aussteller wie die übrigen Helper.
- [ ] Im Lauf der Test-Pipeline sind die Schritte „Verify Windows native helper dependencies (dumpbin)“, „Verify
      Windows signatures“ und beide Smoke-Tests grün. Im Log stehen `Verifying signature: …\pgm-helper.exe`, die
      VC-Runtime unter `native\pgm-helper` (`Verified Microsoft signature: …`) und je Smoke-Test
      `[PgmHelper] Probe passed …`. `pgm-helper.exe` importiert damit nur erlaubte DLLs (keine OpenSSL-DLL,
      VC-Runtime wie die anderen Helper).
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
