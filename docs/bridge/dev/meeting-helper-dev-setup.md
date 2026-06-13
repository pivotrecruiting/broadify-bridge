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
