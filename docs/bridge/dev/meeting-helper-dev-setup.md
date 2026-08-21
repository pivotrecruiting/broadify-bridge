# Meeting Helper Dev Setup

Der Meeting-Pfad verwendet keinen Python-Sidecar mehr. Die Bridge startet den
nativen C++ `meeting-helper`; Frames laufen über FrameBus, Steuerung über
JSON-RPC auf einem lokalen Control-Socket.

## Build

MODNet ist im nativen Helper der Hauptpfad. macOS baut CoreML und Apple Vision
ohne ONNX Runtime. Windows erwartet ONNX Runtime DirectML und `modnet.onnx`.

```bash
npm run build:meeting-helper
```

Direkt:

```bash
bash apps/bridge/native/meeting-helper/build.sh
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps\bridge\native\meeting-helper\build.ps1
```

### OpenVINO-Backend (Windows, optional)

Das OpenVINO-Matting-Backend (MODNet auf Intel GPU/NPU, siehe
`docs/bridge/architecture/meeting-keyer-auto-degradation.md`, Abschnitt
"Matting Backends") ist ein Build-Opt-in; `dist:win` aktiviert es immer.

```powershell
# 1. Vendored Runtime holen (gepinnte Version + SHA256-Verifikation):
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-windows-openvino-deps.ps1

# 2. Helper mit OpenVINO bauen (kopiert die Runtime-DLLs neben die exe):
$env:MEETING_HELPER_ENABLE_OPENVINO = "1"
powershell -NoProfile -ExecutionPolicy Bypass -File apps\bridge\native\meeting-helper\build.ps1
```

A/B-Benchmark DirectML vs. OpenVINO in einem Kommando (der Self-Test
benchmarkt bei einkompiliertem OpenVINO BEIDE Backends, Felder `backend` +
`provider` unterscheiden die Sektionen):

```powershell
apps\bridge\native\meeting-helper\meeting-helper.exe --keyer-self-test --models-dir apps\bridge\native\meeting-helper\models
# oder: npm run test:meeting-helper-keyer-hardware
```

INT8-IR (optional, offline): `scripts/quantize-modnet-openvino.md`.

## Runtime-Vertrag

Die Bridge spawnt:

```bash
apps/bridge/native/meeting-helper/meeting-helper \
  --run \
  --parent-pid <bridge-pid> \
  --preview-port <port> \
  --control-socket <path> \
  --framebus-name broadify-meeting-framebus \
  --models-dir <path> \
  --width 1280 \
  --height 720 \
  --fps 30
```

Wichtige Env-Fallbacks:

| Variable | Zweck |
| --- | --- |
| `BRIDGE_MEETING_HELPER_PATH` | Bridge-Override für das Helper-Binary |
| `BRIDGE_MEETING_CONTROL_SOCKET` | Bridge-Override für den Control-Socket |
| `BRIDGE_MEETING_FRAMEBUS_NAME` | FrameBus-Segmentname |
| `BRIDGE_MEETING_MODELS_DIR` | Bridge-Override für das Modellverzeichnis |
| `MEETING_MODELS_DIR` | Modellverzeichnis im Helper |
| `BROADIFY_MEETING_GPU_COMPOSITOR=0` | Metal-Compositor deaktivieren |
| `BROADIFY_MEETING_GPU_COMPOSITOR_D3D11=0` | D3D11-Compositor deaktivieren |
| `BROADIFY_MEETING_GPU_PIPELINE=0` | Fused CoreML-Pipeline deaktivieren |
| `BROADIFY_MEETING_GPU_REFINE=0` | MPS-Maskenverfeinerung deaktivieren |
| `BROADIFY_MEETING_GPU_GUIDED=0` | D3D11 Guided Refine deaktivieren |
| `BROADIFY_MEETING_GUIDED_REFINE=0` | Guided Live Snap deaktivieren |
| `BROADIFY_MEETING_GPU_RADIUS` | Radius des MPS Guided Filters |
| `BROADIFY_MEETING_GPU_EPSILON` | Epsilon des MPS Guided Filters |
| `BROADIFY_MEETING_GPU_REFINE_WIDTH` | Zielbreite der MPS-Maske |
| `BROADIFY_MEETING_GPU_EMA` | EMA-Staerke der MPS-Koeffizienten |
| `BROADIFY_MEETING_COREML_UNITS` | CoreML Compute Units waehlen |
| `BROADIFY_MEETING_GUIDED_RADIUS` | Radius des portablen Guided Filters |
| `BROADIFY_MEETING_GUIDED_EPSILON` | Epsilon des portablen Guided Filters |
| `BROADIFY_MEETING_KEYER_DML_LEGACY=1` | DirectML Device 0 erzwingen |
| `BROADIFY_MEETING_AUTO_DEGRADE=0` | Auto-Degradation-Governor (Windows fused) deaktivieren |
| `BROADIFY_MEETING_KEYER_CADENCE` | Inferenz-Kadenz: `auto`/`0`/`N` (siehe `meeting-keyer-auto-degradation.md`) |
| `BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS` | Test-Override fuer die Step-Down-Schwelle des Governors |
| `BROADIFY_MEETING_KEYER_BACKEND` | `modnet`/`openvino_modnet` erzwingt das Matting-Backend (Windows-Factory) |
| `BROADIFY_MEETING_KEYER_OPENVINO=0` | OpenVINO-Kill-Switch: immer ONNX Runtime/DirectML |
| `BROADIFY_MEETING_OPENVINO_DEVICE` | `AUTO` (Default, expandiert zu `AUTO:NPU,GPU,CPU`)/`NPU`/`GPU`/`CPU` |

Beim Start des macOS-App-Bundles reicht die Bridge ausschließlich diese
dokumentierten `BROADIFY_MEETING_*`-Variablen als validierte `--env`-Argumente
weiter. Die Werte werden in Lifecycle-Logs nicht ausgegeben. `--parent-pid`
aktiviert den Orphan-Watchdog, damit der Helper nach einem Bridge-Absturz Kamera
und VCam nicht weiter belegt.

Der macOS-VCam-Reader verwendet denselben Standardnamen:
`broadify-meeting-framebus`. Wenn `BRIDGE_MEETING_FRAMEBUS_NAME` gesetzt wird,
muss die Camera Extension entsprechend gebaut bzw. angepasst werden.

FrameBus-Namen werden plattformspezifisch normalisiert. macOS/Linux verwenden
POSIX Shared Memory mit fuehrendem `/`. Windows verwendet native File Mappings
im `Local\` Namespace und entfernt `/` sowie `\` aus dem Segmentnamen. Der
native Meeting Helper nutzt dieselbe Normalisierung wie das FrameBus N-API
Addon, damit Renderer-, Meeting- und VCam-Pfade dieselben Segmente oeffnen.

## Kamera-Freigabe macOS

Auf macOS laeuft der Kamera-Capture in `Broadify Bridge Meeting Helper.app`.
Die Bridge startet dieses Bundle ueber LaunchServices, nicht direkt ueber das
Executable, damit macOS TCC den Prozess als App-Bundle mit Kamera-Usage-String
bewerten kann. Die TCC-Identitaet bleibt
`com.broadify.bridge.meeting-helper`; der sichtbare Name in System Settings >
Datenschutz & Sicherheit > Kamera ist `Broadify Meeting`.

Nach `meeting_engine_start` ruft die Bridge den Helper-RPC
`camera.permission.request` fire-and-forget auf. Wenn der Status noch
`not_determined` ist, zeigt macOS den Kamera-Freigabe-Dialog. Der Meeting-Start
blockiert nicht auf die Nutzerentscheidung. `camera.list` und `camera.start`
bleiben permission-gated und liefern bei fehlender oder eingeschraenkter
Freigabe den stabilen Fehlercode `camera_permission_denied`.

## Virtuelle Kamera macOS

Die virtuelle Kamera ist eine CoreMediaIO Camera Extension unter
`apps/bridge/native/vcam-helper`. Sie stellt `broadify Camera` fuer Zoom, Meet
und Teams bereit. Wegen macOS-SystemExtension-Sandboxing konsumiert die
Extension den fertigen Program-Frame ueber den lokalen Raw-Frame-Stream des
Meeting-Helpers (TCP 18787), nicht ueber den FrameBus.

Der Helper kennt deshalb zwei voneinander unabhaengige Program-Outputs:

| Output | RPC | Leser |
| --- | --- | --- |
| FrameBus (Shared Memory) | `output.framebus.start/stop/status` | Conference-Display-Output (`conference_display_start` startet/stoppt ihn mit) |
| Raw-Frame-Stream (TCP) | `output.vcam.raw.start/stop` | macOS-Extension, Windows-Media-Source-DLL |

`virtualCameraStart()` armiert nur den Raw-Frame-Stream und liefert den
FrameBus-Status read-only als `framebus_output` mit; es startet den FrameBus
nicht mehr (das kopierte sonst jeden 1080p-Frame, ~250 MB/s, in ein Segment
ohne Leser). `virtualCameraStop()` stoppt entsprechend nur den Raw-Frame-Stream
und laesst einen laufenden FrameBus unangetastet.

```bash
npm run build:vcam-helper
```

Danach:

1. `apps/bridge/native/vcam-helper/build/Release/BroadifyVCam.app` nach
   `/Applications` kopieren.
2. `meeting_engine_start` ausloesen. Die Bridge armiert die virtuelle Kamera
   automatisch mit (Auto-Arm); alternativ manuell
   `meeting_output_configure` mit `target: "virtual_camera"`,
   `action: "start"` senden. Die Bridge oeffnet die App. Ein FrameBus-Start
   ist dafuer nicht noetig.
3. macOS-Freigabe in System Settings bestaetigen und in der Meeting-App
   `broadify Camera` auswaehlen.

`npm run dev` installiert die VCam-System-Extension nicht automatisch. Der Dev-
Start prueft nur mit `verify:vcam-helper`, ob die bereits aktivierte Extension
zur installierten App passt und ob AVFoundation `broadify Camera` listet.

Wenn `/Applications/BroadifyVCam.app` fehlt oder der VCam-Helper bewusst neu
installiert werden soll, fuehre zuerst aus:

```bash
npm run setup:vcam-helper
```

Wenn `BroadifyVCam.app` zwar startet, aber kein Kamera-Device erscheint, pruefe
danach:

- `npm run verify:vcam-helper`
- `systemextensionsctl list | grep broadify`
- `log show --last 2h --predicate 'eventMessage CONTAINS[c] "com.apple.developer.system-extension.install" OR eventMessage CONTAINS[c] "com.broadify.vcam"'`

Wenn die aktivierte System-Extension-Version nicht zur installierten App passt
oder AVFoundation `broadify Camera` nicht listet, bricht `npm run dev` ab,
statt mit einer kaputten VCam-Annahme weiterzulaufen.

Ein typischer Fehlfall ist ein Provisioning-/Signing-Problem der Container-App.
Dann erscheint im Log `Unsatisfied entitlements: com.apple.developer.system-extension.install`
und die Extension wird von macOS nicht aktiviert.

## IPC

JSON-RPC Requests sind newline-delimited:

```json
{"id":"req-1","method":"control.ping","params":{}}
```

Responses:

```json
{"id":"req-1","ok":true,"result":{"pong":true}}
```

Der Helper schreibt Async-Events auf stdout:

```json
{"type":"ready","framebus":"broadify-meeting-framebus","preview_port":9123}
{"type":"metrics","fps":30,"keyer":"passthrough","inference_ms":null,"drops":0}
{"type":"error","code":"model_missing","message":"modnet.onnx not found"}
```

Bei einem Launch ueber macOS LaunchServices wird Helper-stdout nicht
zuverlaessig an den Bridge-Prozess weitergereicht. Deshalb fragt die Bridge den
Keyer-Status ueber `keyer.get` ab und protokolliert Backend-Wechsel als
`[Meeting] Runtime keyer status`. `meeting_get_state` liefert neben dem
Engine-Status auch den aktuellen `keyer`-Status.

Der erwartete macOS-Lauf mit automatischer WebApp-Konfiguration enthaelt:

```json
{
  "active_keyer": "coreml_modnet",
  "provider": "coreml",
  "fallback_active": false,
  "keyer_pipeline_mode": "fused_coreml",
  "compositor": "metal",
  "model_hash_ok": true,
  "mask_age_ms": 0
}
```

### Control-Channel: Ready-Handshake und Robustheit

Der Helper ist der Server des Control-Kanals (Unix-Socket auf macOS, Named
Pipe `\\.\pipe\broadify-meeting-<pid>-<ts>` auf Windows); die Bridge
oeffnet pro RPC eine neue Verbindung und serialisiert alle RPCs ueber eine
Queue. `ready` wird erst gesendet, wenn der Kanal tatsaechlich erreichbar ist:

- macOS: nach `bind` + `listen`.
- Windows: nach der ersten erfolgreichen `CreateNamedPipeA`. Schlaegt das
  Anlegen dauerhaft fehl (200 Versuche x 50 ms), meldet der Helper
  `{"type":"error","code":"control_pipe_failed","win32_error":<GetLastError>}`
  und sendet KEIN `ready`; der Bridge-Start laeuft dann mit sichtbarer Ursache
  in den Timeout.

Windows haelt immer eine freie Pipe-Instanz bereit (`PIPE_UNLIMITED_INSTANCES`,
naechste Instanz wird direkt nach `ConnectNamedPipe` angelegt, bevor der
aktuelle Request bearbeitet wird). Damit gibt es kein Fenster mehr, in dem die
Pipe nicht existiert und ein paralleler Connect mit `ENOENT` scheitert.
Transiente `CreateNamedPipeA`-Fehler (z. B. `ERROR_PIPE_BUSY`, waehrend libuv
das alte Client-Handle noch schliesst) werden als
`{"type":"control_pipe_retry","win32_error":..,"attempt":..}` protokolliert und
wiederholt statt den Control-Thread zu beenden. Die RPC-Verarbeitung bleibt
sequentiell (ein Thread, ein Request nach dem anderen).

Bridge-Seite (`meeting-helper-client.ts`): Connect-Fehler (`ENOENT`, `EPIPE`,
`ECONNREFUSED`) werden nur auf Windows und nur in der Connect-Phase bis zu
5x mit Backoff 20/40/80/160 ms innerhalb des RPC-Timeouts wiederholt. Fehler
nach dem Schreiben des Requests werden nie wiederholt (RPCs sind nicht
idempotent). Jeder Connect-Fehler wird zu `MeetingHelperRequestError` mit Code
`helper_not_reachable` (Message enthaelt den Systemcode), damit
Command-Antworten einen stabilen `errorCode` statt eines rohen `ENOENT`
tragen.

Liveness (`meeting-helper-manager.ts`): Laeuft der Helper-Prozess, aber der
2-s-Status-Poll scheitert 5x in Folge mit `helper_not_reachable`, gilt der
Kanal als verloren: Warn-Log mit PID, Event `helper_control_channel_lost`,
Prozess wird beendet und ueber den normalen Crash-Restart (max. 3 Versuche)
neu gestartet. Jeder erfolgreiche Snapshot setzt den Zaehler zurueck.

Fehlercodes des Control-Kanals:

| Code | Bedeutung | Massnahme |
| --- | --- | --- |
| `helper_not_reachable` | Socket/Pipe konnte nicht verbunden werden (Systemcode in der Message, z. B. `ENOENT`). Einzelner RPC, evtl. nach Retries. | Bei Haeufung Helper-Event-Log pruefen (`control_pipe_retry`, `control_pipe_failed`); Engine neu starten. |
| `helper_control_channel_lost` | 5 Polls in Folge `helper_not_reachable` bei lebendem Prozess; Bridge startet den Helper automatisch neu. | Tail des Helper-Event-Logs im Bridge-Log lesen; bei `helper_restart_exhausted` Bridge neu starten, Windows-Ereignisanzeige/AV-Software auf Pipe-Blocker pruefen. |
| `helper_ping_failed` | `ready` kam, aber 15 Pings (100 ms) blieben ohne `pong`; letzter Ping-Fehler steht im Debug-Log. | Debug-Log lesen (`control.ping failed ... last error`). |
| `control_pipe_failed` / `control_socket_failed` / `control_bind_failed` | Helper konnte den Kanal nicht anlegen; kein `ready`. | `win32_error` bzw. errno auswerten; Bridge-Start laeuft in den 20-s-Timeout. |

### Status-Poll und Publish-Kadenz

Die Bridge pollt den laufenden Helper alle `STATUS_POLL_INTERVAL_MS` (2000 ms)
und publiziert das Ergebnis als `bridge_event` `meeting_status`
(`reason: "status_poll"`). Zwei Schutzregeln
(`apps/bridge/src/services/meeting/meeting-helper-manager.ts`,
`apps/bridge/src/services/meeting/status-publish-policy.ts`):

- **In-flight-Guard:** Laeuft der vorherige Poll noch (langsamer RPC), wird
  der Tick uebersprungen statt gestapelt; ein Debug-Log alle
  `STATUS_POLL_SKIP_LOG_EVERY` (10) Skips.
- **Dedupe ueber stabile Projektion:** Verglichen wird der Snapshot ohne
  Per-Frame-Zaehler (`rendered_frames`, `reused_frames`,
  `published_preview_frames`, `written_framebus_frames`, `inference_ms`,
  `elapsed_seconds`, `video_frames`) und ohne `keyer.status.metrics`.
  Publiziert wird sofort bei `force` (Lifecycle, Recording-Wechsel), immer
  solange `recording.active` (Timer in der WebApp), bei jeder Aenderung der
  Projektion (Kamera, Provider, Fallback, Fehler, VCam), und sonst
  mindestens alle `STATUS_METRICS_PUBLISH_INTERVAL_MS` (6000 ms), damit
  Performance-Panels weiterlaufen. Es werden also nie Updates stillgelegt,
  nur reine Zaehler-Aenderungen gedrosselt.

### Company-Background-Fetch (`meeting_background_image_fetch`)

Die Bridge laedt Cloud-Hintergruende selbst (guarded HTTPS-Downloader:
nur HTTPS/443, oeffentliche Adressen, 8 MB Cap, PNG/JPEG/WebP) und cached
sie unter `<userDataDir>/meeting-backgrounds/<sha256>.<ext>` mit einem
`index.json` daneben (`apps/bridge/src/services/meeting/background-image-store.ts`):

- Cache-Key = Origin + Pfad der URL ohne Query, d. h. neu signierte
  Supabase-URLs treffen denselben Eintrag.
- Treffer mit vorhandener Datei: Conditional GET (`If-None-Match` mit dem
  gespeicherten ETag, sonst `If-Modified-Since`). `304` liefert den
  gecachten Pfad; `200` speichert neu (Datei wird nur geschrieben, wenn der
  Hash noch nicht existiert). Nur bei Transport-Fehlern (DNS, Connect,
  Reset, Timeout, TLS) wird die gecachte Datei mit Warn-Log genutzt;
  HTTP-Status-Antworten (401/403/404/410) und Guard-Ablehnungen sind
  autoritativ und werden weitergereicht, 404/410 entfernen den Eintrag.
- Cleanup: LRU-Eviction ueber `BACKGROUND_CACHE_MAX_FILES` (20) bzw.
  `BACKGROUND_CACHE_MAX_TOTAL_BYTES` (200 MB); lokale Uploads ueber die
  HTTP-Route werden unter `upload:<hash>` mitindiziert.
- Antwort: `{ path, cached }` (`cached: true` bei 304/Offline-Fallback).

## Kamera-Spiegelung

Die Kamera wird im Compositor standardmaessig horizontal gespiegelt, damit die
Person im virtuellen Kamera-Output wie in einer Self-View wirkt. Das Spiegeln
passiert nur in `drawCamera`; Backgrounds, Graphics, Lower Thirds und Schriften
bleiben ungespiegelt.

Die VCam-Extension gibt den fertigen Program-Frame unveraendert aus. Sie darf
den Frame nicht nochmals horizontal spiegeln, weil sonst Grafiken und Text fuer
Remote-Teilnehmer gespiegelt erscheinen.

Zur Laufzeit kann das Verhalten ueber die Program-Section `camera` gesetzt
werden:

```json
{"section":"camera","values":{"mirror":true}}
```

Fuer Debugging oder einen bewusst ungespiegelten Kameralayer:

```json
{"section":"camera","values":{"mirror":false}}
```

## Modelle

Modelle liegen unter:

```text
apps/bridge/native/meeting-helper/models/
```

Im lokalen macOS-Build liegt das App-Bundle direkt neben diesem Ordner. Die
Bridge loest deshalb bei
`Broadify Bridge Meeting Helper.app/Contents/MacOS/BroadifyMeetingHelper` das
Modellverzeichnis neben dem App-Bundle auf. Sie startet den Helper nicht, wenn
`MODNet.mlpackage` dort fehlt. `BRIDGE_MEETING_MODELS_DIR` bleibt der explizite
Override fuer Sonderfaelle.

Windows nutzt `manifest.json` und `modnet.onnx`. macOS nutzt
`coreml-manifest.json` und `MODNet.mlpackage`. Beide Artefakte werden vor einem
Release per SHA-256 verifiziert.

Hash-Helfer:

```bash
bash scripts/hash-meeting-model.sh modnet.onnx
```

ONNX Runtime liegt vendored unter:

```text
apps/bridge/native/meeting-helper/deps/onnxruntime/windows-x64/
├── include/
└── lib/
    ├── onnxruntime.lib
    ├── onnxruntime.dll
    ├── onnxruntime_providers_shared.dll
    └── DirectML.dll
```

CoreML-Modell vorbereiten:

```bash
MODNET_COREML_MODEL_SOURCE=/path/to/model-parent npm run prepare:modnet-coreml-model
```

Temporärer Build ohne MODNet, nur für Compiler-/Bridge-Arbeit:

```bash
MEETING_HELPER_ENABLE_MODNET=0 npm run build:meeting-helper
```

Native Tests:

```bash
npm run test:meeting-helper-native
npm run test:meeting-helper-gpu
npm run test:meeting-helper-keyer
```

`test:meeting-helper-native` baut das Helper-Build-Verzeichnis und fuehrt die
ctest-Suite aus (stdlib-only, keine ONNX-/Metal-/MediaFoundation-Abhaengigkeit):
`guided_mask_refine_test`, `framebus_reader_log_gate_test`,
`keyer_governor_test`, `keyer_cadence_test`. Abschaltbar ueber
`MEETING_HELPER_BUILD_TESTS=0` (Default an, analog zu
`MEETING_HELPER_ENABLE_MODNET`).

`test:meeting-helper-keyer` ruft den Helper mit `--keyer-self-test` auf:
20 getimte MODNet-Inferenzen pro Input-Groesse (512/320/256) auf einem
deterministischen synthetischen Frame, eine JSON-Zeile pro Groesse
(`mean_ms`, `p95_ms`, `probe_inference_ms`) plus `keyer_self_test_summary`.
Exit 0 nur, wenn das Modell geladen und Masken erzeugt wurden; ein Build ohne
ONNX Runtime meldet `{"ok":false,"reason":"onnxruntime_disabled"}` und Exit 1.
Direktaufruf:

```bash
"apps/bridge/native/meeting-helper/Broadify Bridge Meeting Helper.app/Contents/MacOS/BroadifyMeetingHelper" \
  --keyer-self-test --models-dir apps/bridge/native/meeting-helper/models
```

`BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER=cpu` erzwingt dabei den reinen
CPU-Provider (CI-Timings ohne GPU); die `-hardware`-Varianten lassen die
Variable weg.

## Nicht Mehr Vorhanden

- kein `apps/meeting-engine`
- kein FastAPI/Uvicorn
- kein Python venv im Release-Paket
- keine Demo-, Canon-, Wake-on-LAN- oder Session-Prototyp-Endpunkte
