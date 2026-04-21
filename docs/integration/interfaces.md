# Integration – Schnittstellen (Desktop ↔ Bridge)

## Überblick
Diese Seite beschreibt die wichtigsten Schnittstellen zwischen Desktop‑App und Bridge (IPC + HTTP).

## Desktop IPC → Main
- `bridgeGetProfile()` / `bridgeSetName(name)`
- `bridgeStart(config)` / `bridgeStop()`
- `bridgeGetStatus()` / `subscribeBridgeStatus(cb)`
- `bridgeGetOutputs()`
- `bridgeGetLogs()` / `bridgeClearLogs()`
- `appGetLogs()` / `appClearLogs()`
- `engineConnect()` / `engineDisconnect()` / `engineGetStatus()` / `engineGetMacros()` / `engineRunMacro()` / `engineStopMacro()`
- fuer dokumentierte vMix-Script-Aktionen zusaetzlich: `engine_vmix_run_action`

## Main → Bridge HTTP
- `GET /status` (inkl. optional `bridgeName`)
- `GET /relay/status`
- `GET /outputs`
- `POST /engine/connect`
- `POST /engine/disconnect`
- `GET /engine/status`
- `GET /engine/macros`
- `POST /engine/macros/:id/run`
- `POST /engine/macros/:id/stop`
- `POST /engine/vmix/actions/run`
- `GET /logs`
- `POST /logs/clear`

## Bridge Internal (Relay)
- `bridge_hello`, `bridge_auth_challenge`, `bridge_auth_response`, `bridge_auth_ok`, `bridge_auth_error`, `command`, `command_result`
- Command: `bridge_pair_validate` (Pairing‑Code prüfen)
- Bridge-Events fuer Live-Updates:
  - `engine_status`
  - `engine_macro_execution`
  - `engine_error`
  - `graphics_status`
  - `graphics_error`

## Engine Macro Runtime Contract

### Macro-Katalog
`GET /engine/macros` und `engine_get_macros` liefern weiterhin die definitorische Makroliste:

```ts
type MacroStatusT =
  | "idle"
  | "pending"
  | "running"
  | "waiting"
  | "recording";

type MacroT = {
  id: number;
  name: string;
  status: MacroStatusT;
};
```

`completed`, `stopped` und `failed` sind bewusst keine Katalog-Statuswerte. Diese Werte gehoeren zur einzelnen Ausfuehrung.

### Engine-State Snapshot
`GET /engine/status`, `engine_get_status`, `POST /engine/macros/:id/run` und `POST /engine/macros/:id/stop` liefern einen Engine-State, der die Macro-Runtime enthaelt:

```ts
type MacroExecutionStatusT =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "stopped"
  | "failed";

type MacroExecutionT = {
  runId: string;
  macroId: number;
  macroName?: string;
  engineType: "atem" | "tricaster" | "vmix";
  status: MacroExecutionStatusT;
  triggeredAt: number;
  startedAt: number | null;
  waitingAt: number | null;
  completedAt: number | null;
  actualDurationMs: number | null;
  loop: boolean;
  stopRequestedAt?: number | null;
  error?: string;
};

type EngineStateT = {
  status: "disconnected" | "connecting" | "connected" | "error";
  type?: "atem" | "tricaster" | "vmix";
  ip?: string;
  port?: number;
  macros: MacroT[];
  macroExecution?: MacroExecutionT | null;
  lastCompletedMacroExecution?: MacroExecutionT | null;
  lastUpdate?: number;
  error?: string;
};
```

### Interne Bridge-WebSocket-Events
Die lokale Bridge-WebSocket-Route bleibt rueckwaertskompatibel und sendet weiterhin `engine.status`, `engine.macros` und `engine.macroStatus`. Zusaetzlich gibt es:

```ts
type EngineMacroExecutionEventT = {
  type: "engine.macroExecution";
  execution: MacroExecutionT | null;
  lastCompletedExecution?: MacroExecutionT | null;
};
```

### Relay-/Webapp-Events
Die Webapp verwendet Snapshots fuer Initialzustand/Resync und Bridge-Events fuer Live-Uebergaenge:

- `engine_status`: Snapshot-artiges Event mit `status`, `type`, `ip`, `port`, `macros`, `macroExecution`, `lastCompletedMacroExecution`, `error`, `lastUpdate`.
- `engine_macro_execution`: feingranulares Lifecycle-Event mit `execution` und `lastCompletedExecution`.
- `engine_error`: separater Fehlerpfad mit `code` und `message`.

Nach Relay-Reconnect publiziert die Bridge weiterhin `engine_status_snapshot`; danach laufen Live-Updates wieder ueber `engine_status` und `engine_macro_execution`.

## Payloads
Siehe:
- `docs/bridge/features/graphics-commands.md`
- `docs/bridge/features/output-config.md`
- `docs/bridge/features/relay-protocol.md`
