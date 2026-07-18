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
`apps/bridge/native/vcam-helper`. Sie liest den Meeting-FrameBus und stellt
`broadify Camera` fuer Zoom, Meet und Teams bereit.
Wegen macOS-SystemExtension-Sandboxing konsumiert die Extension den fertigen
Program-Frame ueber den lokalen Raw-Frame-Stream des Meeting-Helpers.

```bash
npm run build:vcam-helper
```

Danach:

1. `apps/bridge/native/vcam-helper/build/Release/BroadifyVCam.app` nach
   `/Applications` kopieren.
2. `meeting_engine_start` ausloesen.
3. `meeting_output_configure` mit `target: "framebus"`, `action: "start"` senden.
4. `meeting_output_configure` mit `target: "virtual_camera"`, `action: "start"`
   senden. Die Bridge oeffnet die App.
5. macOS-Freigabe in System Settings bestaetigen und in der Meeting-App
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

## Nicht Mehr Vorhanden

- kein `apps/meeting-engine`
- kein FastAPI/Uvicorn
- kein Python venv im Release-Paket
- keine Demo-, Canon-, Wake-on-LAN- oder Session-Prototyp-Endpunkte
