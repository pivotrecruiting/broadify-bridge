# Output Endpoints and Webapp Responses

This documents the output-related endpoints and the exact response shape that the webapp receives when the user clicks “Refresh outputs”.

## Webapp Call Chain (Refresh Outputs)

1. UI hook calls `window.electron.bridgeGetOutputs()`
   - Source: `src/ui/hooks/use-bridge-outputs.ts`
2. IPC handler `bridgeGetOutputs` in the Electron main process runs
   - Source: `src/electron/main.ts`
3. Main process calls `fetchBridgeOutputs()`
   - Source: `src/electron/services/bridge-outputs.ts`
4. HTTP GET to the Bridge Server:
   - `GET http://<bridge-host>:<bridge-port>/outputs`

If the bridge is not running or returns an error, the main process returns:

```json
{
  "output1": [],
  "output2": []
}
```

## HTTP Endpoint: GET /outputs

- **Path**: `/outputs`
- **Query**: `?refresh=1` to force a detection refresh
- **Source**: `apps/bridge/src/routes/outputs.ts`

### Response Shape (BridgeOutputsT)

```ts
type OutputDeviceT = {
  id: string;
  name: string;
  type: "capture" | "connection";
  available: boolean;
};

type BridgeOutputsT = {
  output1: OutputDeviceT[];
  output2: OutputDeviceT[];
};
```

### Semantics

- `output1`: **Devices** that have at least one output-capable port.
- `output2`: **Connection types** (e.g., `sdi`, `hdmi`, `usb`, `displayport`, `thunderbolt`) derived from output-capable ports.
- `available`: `true` only if the device/port is output-capable and available.

## Relay Command: list_outputs

When using the relay channel (not the HTTP route), the Bridge supports:

- **Command**: `list_outputs`
- **Source**: `apps/bridge/src/services/command-router.ts`
- **Response**:

```json
{
  "success": true,
  "data": {
    "output1": ["OutputDeviceT"],
    "output2": ["OutputDeviceT"]
  }
}
```

This uses the same internal transformation as `GET /outputs`.

## What the Webapp Receives on Refresh

The renderer process receives a `BridgeOutputsT` object from the IPC handler:

```json
{
  "output1": [
    {"id":"usb-capture-...","name":"USB Capture Device","type":"capture","available":true}
  ],
  "output2": [
    {"id":"sdi","name":"SDI Output 1","type":"connection","available":true},
    {"id":"hdmi","name":"HDMI Output","type":"connection","available":true}
  ]
}
```

If the bridge cannot be reached, the webapp receives empty arrays:

```json
{
  "output1": [],
  "output2": []
}
```

## Related Files

- `src/ui/hooks/use-bridge-outputs.ts`
- `src/electron/preload.cts`
- `src/electron/main.ts`
- `src/electron/services/bridge-outputs.ts`
- `apps/bridge/src/routes/outputs.ts`
- `apps/bridge/src/services/command-router.ts`
