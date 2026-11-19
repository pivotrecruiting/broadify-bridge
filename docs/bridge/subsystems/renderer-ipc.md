# Bridge Subsystem – Renderer & IPC

## Zweck
Dieses Subsystem steuert das Rendering von HTML/CSS‑Templates in einem separaten Electron‑Offscreen‑Prozess. Die Kommunikation erfolgt über lokale TCP‑IPC mit Token‑Handshake (Control-Plane). Der Frame-Transport läuft über FrameBus (Data-Plane).

## Verantwortlichkeiten
- Start/Shutdown des Renderer‑Prozesses
- IPC‑Handshake und Nachrichten‑Protokoll
- Renderer-Session-Konfiguration (`renderer_configure`)
- Offscreen‑Rendering im Single-Window-Modell
- Begrenzte Runtime-Recovery nach Renderer-Absturz ohne Engine-/ATEM-Neustart

## Hauptkomponenten
- Renderer Client (Bridge): `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
- Renderer Entry (Electron): `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- Renderer Interface: `apps/bridge/src/services/graphics/renderer/graphics-renderer.ts`
- IPC Framing: `apps/bridge/src/services/graphics/renderer/renderer-ipc-framing.ts`
- Animation CSS: `apps/bridge/src/services/graphics/renderer/animation-css.ts`

## IPC‑Protokoll (High‑Level)
- Transport: TCP, gebunden an `127.0.0.1`
- Auth: Token‑Handshake (Bridge generiert Token, Renderer bestätigt)
- Nachrichten: JSON‑Header + optionaler Binary‑Payload

### Commands (Bridge → Renderer)
- `renderer_configure`
- `set_assets`
- `create_layer`
- `update_values`
- `update_layout`
- `remove_layer`
- `shutdown`

### Events (Renderer → Bridge)
- `hello`
- `ready`
- `error`

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant GM as GraphicsManager
  participant RC as RendererClient
  participant ER as ElectronRenderer

  GM->>RC: initialize()
  RC->>ER: spawn + IPC server
  ER-->>RC: hello (token)
  ER-->>RC: ready

  GM->>RC: configureSession/renderLayer/updateValues
  RC->>ER: renderer_configure/create_layer/update_values
  ER->>ER: paint -> BGRA->RGBA
  ER->>FrameBus: writeFrame
```

## Security‑Hinweise
- IPC ist lokal (`127.0.0.1`) und token‑authentifiziert.
- Payload‑Limits schützen vor Speicher‑Missbrauch.
- Renderer‑BrowserWindow mit `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.

## Fehlerbilder
- Renderer Entry nicht gefunden → Initialisierung schlägt fehl, Stub‑Renderer fallback.
- Token‑Mismatch → IPC wird verworfen.
- Unerwartete Frame-Payload via IPC → wird verworfen (Frames sind FrameBus-only).
- Abnormaler Renderer-Exit → maximal zwei automatische Recovery-Versuche in 5 Minuten.
- Zweiter Recovery-Versuch startet mit deaktivierter GPU, sofern `BRIDGE_GRAPHICS_AUTO_GPU_FALLBACK` nicht `0` ist.
- Nach ausgeschöpftem Limit wechselt Graphics in `degraded`; Engine-/ATEM-Routen bleiben verfügbar.

## Runtime-Recovery
- Der Graphics-Renderer nutzt ein eigenes Electron-Profil: `userData/graphics-renderer-profile`.
- Recovery löscht nur volatile Renderer-Cache-Pfade innerhalb dieses Profils (`GPUCache`, `Code Cache`, `DawnGraphiteCache`, `DawnWebGPUCache`, Shader-Caches).
- Reihenfolge: Renderer-Prozess beendet sich → IPC-Server schließt → Cache-Cleanup → Renderer-Restart → Assets, Session und aktive Layer werden erneut gesendet.
- Recovery-Logs enthalten `recoveryId`, `reason`, `attempt`, `gpuDisabled`, Cleanup-Pfade und Restart-Ergebnis.
- Lifecycle-State: `ready`, `recovering`, `gpu_fallback`, `degraded`.

## IPC‑Framing (Detail)
- 4‑Byte Big‑Endian Header‑Length\n
- JSON‑Header enthält `type`, `token`, optional `bufferLength` + Metadaten\n
- Danach optionaler Binary‑Payload (`bufferLength` Bytes)\n
- Limits: Header 64KB, Payload 64MB, Max Frame Dimension 8192px

## Startparameter (Renderer‑Process)
- CLI: `--graphics-renderer --renderer-entry <path>`\n
- Env: `BRIDGE_GRAPHICS_IPC_PORT`, `BRIDGE_GRAPHICS_IPC_TOKEN`, `BRIDGE_GRAPHICS_USER_DATA_DIR`
- Beide CLI-Flags sind Pflicht. `--graphics-renderer` allein beendet den Prozess mit Exit 1 (`Missing --renderer-entry argument`); ein positionaler Pfad ohne Flag wird nie als Entry interpretiert.

## Renderer-Entry-Allowlist (Desktop Main, Aux Mode)
Die gepackte Desktop-Binary importiert im Aux Mode die per `--renderer-entry` angegebene Datei in ihren eigenen (signierten, TCC-berechtigten) Main-Prozess. Damit kein lokaler Prozess beliebigen Code in die App laden kann, prueft `src/electron/renderer-entry-policy.ts` (`resolveAllowedRendererEntry`) jeden Entry vor dem `import()`:

- Der Entry muss eine regulaere Datei sein (`not_a_file`).
- Der Entry muss nach Symlink-Aufloesung (`realpath`) **innerhalb** von `process.resourcesPath` oder `app.getAppPath()` liegen; `..`-Traversal, absolute Fremdpfade und Symlinks nach aussen werden abgelehnt (`outside_allowed_roots`). Der Root selbst zaehlt nicht als "innerhalb".
- Der aufgeloeste Basename muss in `ALLOWED_RENDERER_ENTRY_BASENAMES` stehen: `electron-renderer-entry.js` (Graphics-Renderer) oder `display-output-entry.js` (Conference-Display-Fenster) (`disallowed_basename`).
- Fehler bei `realpath`/`stat` fuehren zu `unresolvable`.

Jede Ablehnung loggt nur den Grund (`[GraphicsRenderer] Rejected renderer entry (<reason>)`), nie den untrusted Pfad, und beendet den Prozess mit `app.exit(1)`. Legitime Spawner sind ausschliesslich `electron-renderer-client.ts` (Graphics-Renderer) und `conference/conference-display-output.ts` (Display-Fenster); beide uebergeben Entries aus `<bridge-cwd>/dist/...`, also `<resources>/bridge/dist/...` im Paket bzw. `apps/bridge/dist/...` im Dev-Repo (= unter `app.getAppPath()`).

Im Dev-Modus (Electron-Binary aus `node_modules`) greift die Policy nicht: Electrons Default-App laedt den ersten Nicht-Options-Parameter (`<path>`) direkt als App, `main.ts` wird dort nicht ausgefuehrt.
- Session-Setup: `renderer_configure` enthält `framebusName`, `framebusSlotCount`, `framebusSize`, `pixelFormat`
- FrameBus-Namen im `ready`-ACK werden für den Vergleich kanonisiert: POSIX kann ein führendes `/`, Windows den Object-Namespace `Local\` oder `Global\` ergänzen. Alle übrigen Config-Metadaten und der kanonische Segmentname müssen weiterhin exakt zur ausstehenden Konfiguration passen.

## Relevante Dateien
- `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- `apps/bridge/src/services/graphics/renderer/graphics-renderer.ts`
- `apps/bridge/src/services/graphics/renderer/animation-css.ts`
- `src/electron/renderer-entry-policy.ts` (Allowlist fuer `--renderer-entry`)
- `apps/bridge/src/services/conference/conference-display-output.ts` (zweiter Spawner im Aux Mode)
