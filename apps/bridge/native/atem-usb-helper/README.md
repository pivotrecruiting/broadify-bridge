# ATEM USB Helper

Native helper that connects to a USB-attached Blackmagic ATEM switcher via
the official ATEM Switchers SDK. It exists so the Studio-mode engine layer
can offer `transport: "usb"` next to the existing network transport
(`atem-connection`), without linking SDK code into the bridge process.

## Design rules

- **All SDK calls stay in this helper** to isolate crashes and blocking
  calls from the bridge (same doctrine as the DeckLink helper).
- **No SDK files are committed or shipped.** Headers come from the locally
  installed ATEM software (or `ATEM_SDK_ROOT`); the runtime is loaded by
  `BMDSwitcherAPIDispatch` from
  `/Library/Application Support/Blackmagic Design/Switchers/BMDSwitcherAPI.bundle`.
  If the ATEM software is not installed, the helper reports
  `atem_software_not_installed` instead of crashing — the customer-facing
  requirement is "Blackmagic ATEM software installed".
- USB connect uses `IBMDSwitcherDiscovery::ConnectTo` with an **empty device
  address**, which the SDK manual defines as "only connect via USB".

## Modes

### `--probe` (one-shot diagnostics)

```bash
./atem-usb-helper --probe
```

Prints a single JSON object:

- SDK missing: `{"mode":"probe","sdk_available":false,"connected":false,"error":"atem_software_not_installed","helper_build":{"sdk_idl_sha":"...","sdk_discovery_clsid":"...","sdk_version":"..."}}`
- No switcher on USB: `{"mode":"probe","sdk_available":true,"connected":false,"error":"no_usb_switcher_found","helper_build":{"sdk_idl_sha":"...","sdk_discovery_clsid":"...","sdk_version":"..."}}`
- Connected: `{"mode":"probe","sdk_available":true,"connected":true,"product_name":"...","macro_slots":100,"valid_macros":3,"helper_build":{"sdk_idl_sha":"...","sdk_discovery_clsid":"...","sdk_version":"..."}}`

Windows probe output also includes `discovery_hr` and includes the
`CoCreateInstance` HRESULT in `detail` when the SDK COM object is missing.

Stable error identifiers: `atem_software_not_installed`,
`no_usb_switcher_found`, `incompatible_firmware`, `corrupt_data`,
`state_sync_failed`, `state_sync_timed_out`.

## Build

macOS:

```bash
./build.sh                       # uses the installed ATEM Developer SDK
ATEM_SDK_ROOT=/path/to/SDK ./build.sh
```

Windows (Developer PowerShell for VS — `cl` + `midl` on PATH; the COM
interface header is midl-generated from the SDK's `BMDSwitcherAPI.idl`):

```powershell
.\build.ps1                      # uses the installed ATEM Developer SDK
$env:ATEM_SDK_ROOT = "D:\SDKs\ATEM\Windows"; .\build.ps1
```

On Windows the graceful-degradation path is COM-based: without the ATEM
software installed, `CoCreateInstance` fails (`REGDB_E_CLASSNOTREG`) and the
helper reports `atem_software_not_installed` exactly like on macOS.
The Windows build first checks `ATEM_SDK_ROOT`, then the current
`Blackmagic Design\ATEM Switchers\Developer SDK\Windows` install path, then the
legacy `Blackmagic Design\Blackmagic ATEM Switchers\Developer SDK\Windows`
path.

### `--run` (long-lived session for the bridge adapter)

One JSON command per line on stdin, one JSON event per line on stdout
(SDK logs go to stderr; stdout stays machine-readable).

Commands:

```json
{"command":"connect"}
{"command":"disconnect"}
{"command":"list_macros"}
{"command":"macro_run","index":3}
{"command":"macro_stop"}
{"command":"shutdown"}
```

Events:

- `{"type":"ready","helper_build":{"sdk_idl_sha":"...","sdk_discovery_clsid":"...","sdk_version":"..."}}` — emitted once at startup.
- `{"type":"connected","product_name":"ATEM Mini Extreme"}`
- `{"type":"macros","macros":[{"id":0,"name":"...","description":"..."}]}` —
  after connect, on `list_macros`, and on every macro-pool change.
- `{"type":"macro_state","status":"idle|running|waiting","loop":false,"index":0}` —
  after connect and on every run-status change (`index` 65535 = none).
- `{"type":"disconnected"}` — on explicit disconnect and when the switcher
  drops off USB.
- `{"type":"error","error":"<identifier>","detail":"..."}` — identifiers:
  the connect errors above plus `already_connected`, `not_connected`,
  `invalid_macro_index`, `missing_macro_index`, `macro_run_failed`,
  `macro_stop_failed`, `unknown_command`.

Threading contract: SDK callbacks arrive on SDK threads; stdout writes are
mutex-serialized; session state is torn down only by explicit
`disconnect`/`shutdown` (callbacks never release SDK objects).

The bridge-side `AtemUsbAdapter` consumes this mode (transport "usb" in the
engine connect contract).
