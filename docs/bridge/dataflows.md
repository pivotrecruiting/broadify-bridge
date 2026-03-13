# Bridge – Dataflows (Aktueller Stand)

## Zweck
Diese Datei beschreibt die aktuellen Laufzeit-Datenfluesse der Bridge als zentrale Referenz ausserhalb des abgeschlossenen Refactor-Ordners.

## 1) Command-Ingress (Relay -> Bridge)
```mermaid
sequenceDiagram
  participant Relay as Relay Server
  participant RC as RelayClient
  participant CR as CommandRouter
  participant GM as GraphicsManager

  Relay->>RC: command(requestId, command, payload, meta, signature)
  RC->>RC: size/signature/TTL/replay checks
  RC->>CR: handleCommand(command, payload)
  CR->>GM: graphics_* (bei Graphics-Commands)
  CR-->>RC: { success, data|error, errorCode? }
  RC-->>Relay: command_result
```

Wesentliche Punkte:
- Relay-Payloads sind untrusted und werden vor Ausfuehrung geprueft.
- Non-Graphics-Validierung liegt im Command Router (`relay-command-schemas.ts`).
- Graphics-Validierung liegt im Graphics-Stack (`graphics-schemas.ts` + Services).

## 2) Output-Konfiguration (`graphics_configure_outputs`)
```mermaid
sequenceDiagram
  participant CR as CommandRouter
  participant GM as GraphicsManager
  participant VT as ValidationService
  participant TS as OutputTransitionService
  participant R as Renderer
  participant OA as OutputAdapter

  CR->>GM: configureOutputs(payload)
  GM->>VT: validateOutputTargets + validateOutputFormat
  GM->>TS: runAtomicTransition(config)
  TS->>R: configureSession(framebus config)
  TS->>OA: stop(previous)
  TS->>OA: configure(next)
  TS->>TS: persist config
```

Wesentliche Punkte:
- Transition ist serialisiert und atomar (`GraphicsOutputTransitionService`).
- Bei Fehlern wird Rollback auf vorherigen Runtime-Zustand versucht.
- FrameBus-Umgebungsvariablen werden pro Session gesetzt.

## 3) Graphics-Render-Flow (`graphics_send`, Updates, Remove)
```mermaid
sequenceDiagram
  participant CR as CommandRouter
  participant GM as GraphicsManager
  participant R as RendererClient
  participant ER as ElectronRenderer
  participant FB as FrameBus
  participant OA as OutputAdapter/Helper

  CR->>GM: graphics_send/update/remove
  GM->>GM: schema + template/assets + preset logic
  GM->>R: renderer commands (configure/create/update/remove)
  R->>ER: TCP IPC control-plane (token)
  ER->>FB: write latest frame (RGBA)
  OA->>FB: read latest frame
```

Wesentliche Punkte:
- Renderer-IPC ist Control-Plane, nicht Frame-Transport.
- Data-Plane ist FrameBus (Shared Memory).
- `sendFrame()` der Output-Adapter ist im aktuellen Pfad ein No-op.

## 4) Device-/Output-Discovery-Flow
```mermaid
sequenceDiagram
  participant API as /outputs oder list_outputs
  participant DC as DeviceCache
  participant MR as ModuleRegistry
  participant DM as DeviceModules

  API->>DC: getDevices(refresh?)
  DC->>MR: detectAll()
  MR->>DM: decklink/display/usb-capture detect
  DM-->>MR: DeviceDescriptor[]
  MR-->>DC: merged devices
  DC-->>API: cached/updated devices
```

Wesentliche Punkte:
- Cache TTL und Refresh-Rate-Limit begrenzen Detection-Last.
- Ausgabe wird auf UI-kompatibles Output-Modell transformiert.

## 5) Status- und Error-Events
```mermaid
sequenceDiagram
  participant GM as GraphicsManager
  participant EP as EventPublisher
  participant RC as RelayClient
  participant Relay as Relay Server

  GM->>EP: publishGraphicsStatusEvent / publishGraphicsErrorEvent
  EP->>RC: publishBridgeEvent
  RC-->>Relay: bridge_event(graphics_status|graphics_error)
```

Wesentliche Punkte:
- `graphics_status` und `graphics_error` werden ueber Relay als Bridge-Events publiziert.
- Fehlercodes: `output_config_error`, `renderer_error`, `output_helper_error`, `graphics_error`.
