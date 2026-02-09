# Graphics Realtime Refactor – Dataflow

## Control-Flow
```mermaid
sequenceDiagram
  participant WebApp
  participant Relay
  participant Bridge
  participant Renderer

  WebApp->>Relay: graphics_send / update_values
  Relay->>Bridge: command
  Bridge->>Bridge: validate + preset logic
  Bridge->>Renderer: create_layer / update_values / update_layout
```

## Frame-Flow
```mermaid
sequenceDiagram
  participant Renderer
  participant FrameBus
  participant OutputHelper

  Renderer->>FrameBus: write latest frame
  OutputHelper->>FrameBus: read latest frame
  OutputHelper->>OutputHelper: tick @ fps
```

## Error-Flow
- Renderer fällt aus: Bridge stoppt Output-Helper und publiziert Status.
- Output-Helper fällt aus: Bridge stoppt Session und fordert Re-Konfiguration an.

## Legacy-Fallback Flow (Notfall)
- Bridge empfängt Frames vom Renderer (IPC).
- Bridge compositet Frames und tickt pro Output-FPS.
- Output-Helper erhält Frames über Legacy-stdin.

## TODO
- [ ] Error-Codes und Status-Events final definieren.
