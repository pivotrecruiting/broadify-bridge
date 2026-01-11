# Graphics File Map

## Ziel

Kompakte Uebersicht, welche Dateien fuer Graphics relevant sind und wie sie zusammenhaengen.

## Core Services

- `apps/bridge/src/services/graphics/graphics-manager.ts`
  - Zentrales Orchestrieren: Layer Registry, Validation, Renderer Calls, Composite, Output Tick.

- `apps/bridge/src/services/graphics/graphics-schemas.ts`
  - Zod Schemas fuer `graphics_*` Commands, Layer/Layout/Bundle, Output Config.

- `apps/bridge/src/services/graphics/asset-registry.ts`
  - Disk Cache fuer Assets (Base64 -> Datei), asset:// Mapping.

- `apps/bridge/src/services/graphics/output-config-store.ts`
  - Persistiert Output Config (userData/graphics/graphics-output.json).

- `apps/bridge/src/services/graphics/composite.ts`
  - RGBA Composite und Background Handling.

## Renderer

- `apps/bridge/src/services/graphics/renderer/graphics-renderer.ts`
  - Renderer Interface.

- `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
  - Bridge-seitiger Client: spawn Electron, TCP IPC, Frame Empfang.

- `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
  - Electron Child: Offscreen BrowserWindow, asset:// Protocol, Frame Capture.

- `apps/bridge/src/services/graphics/renderer/stub-renderer.ts`
  - Dev Stub (liefert leere RGBA Frames).

## Output

- `apps/bridge/src/services/graphics/output-adapter.ts`
  - Output Adapter Interface.

- `apps/bridge/src/services/graphics/output-adapters/decklink-key-fill-output-adapter.ts`
  - DeckLink SDI Key&Fill (external keying).

- `apps/bridge/src/services/graphics/output-adapters/stub-output-adapter.ts`
  - Stub Output: Logging, Frame Drop Simulation.

## Bridge Glue

- `apps/bridge/src/services/command-router.ts`
  - `graphics_*` Commands routing.

- `apps/bridge/src/services/bridge-context.ts`
  - userDataDir + Logger (Bridge Context).

- `apps/bridge/scripts/graphics-smoke.ts`
  - Smoke Test fuer Renderer + Output Tick.

## Docs

- `docs/graphics/graphics-dataflows.md`
- `docs/graphics/graphics-dataflow-overview.md`
- `docs/graphics/graphics-implementation-checklist.md`
- `docs/graphics/webapp-relay-bridge-contract.md`
