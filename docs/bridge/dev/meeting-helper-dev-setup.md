# Meeting Helper Dev Setup

Der Meeting-Pfad verwendet keinen Python-Sidecar mehr. Die Bridge startet den
nativen C++ `meeting-helper`; Frames laufen über FrameBus, Steuerung über
JSON-RPC auf einem lokalen Control-Socket.

## Build

MODNet ist im nativen Helper der Hauptpfad. Der Standard-Build erwartet lokale
ONNX Runtime Artefakte und `modnet.onnx`.

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
  --preview-port <port> \
  --control-socket <path> \
  --framebus-name broadify-meeting-framebus \
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

Der macOS-VCam-Reader verwendet denselben Standardnamen:
`broadify-meeting-framebus`. Wenn `BRIDGE_MEETING_FRAMEBUS_NAME` gesetzt wird,
muss die Camera Extension entsprechend gebaut bzw. angepasst werden.

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

Wenn `BroadifyVCam.app` zwar startet, aber kein Kamera-Device erscheint, pruefe
zuerst:

- `systemextensionsctl list | grep broadify`
- `log show --last 2h --predicate 'eventMessage CONTAINS[c] "com.apple.developer.system-extension.install" OR eventMessage CONTAINS[c] "com.broadify.vcam"'`

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

## Kamera-Spiegelung

Die Kamera wird im Compositor standardmaessig horizontal gespiegelt, damit die
Person im virtuellen Kamera-Output wie in einer Self-View wirkt. Das Spiegeln
passiert nur in `drawCamera`; Backgrounds, Graphics, Lower Thirds und Schriften
bleiben ungespiegelt.

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

`manifest.json` ist im Repo. `modnet.onnx` muss lokal bereitgestellt und per
SHA-256 verifiziert werden.

Hash-Helfer:

```bash
bash scripts/hash-meeting-model.sh modnet.onnx
```

ONNX Runtime liegt vendored unter:

```text
apps/bridge/native/meeting-helper/deps/onnxruntime/macos-arm64/
├── include/
└── lib/libonnxruntime.dylib
```

Temporärer Build ohne MODNet, nur für Compiler-/Bridge-Arbeit:

```bash
MEETING_HELPER_ENABLE_MODNET=0 npm run build:meeting-helper
```

## Nicht Mehr Vorhanden

- kein `apps/meeting-engine`
- kein FastAPI/Uvicorn
- kein Python venv im Release-Paket
- keine Demo-, Canon-, Wake-on-LAN- oder Session-Prototyp-Endpunkte
