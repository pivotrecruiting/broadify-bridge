# ATEM USB Helper

Native helper that connects to a USB-attached Blackmagic ATEM switcher via
the official ATEM Switchers SDK. It exists so the Studio-mode engine layer
can offer `transport: "usb"` next to the existing network transport
(`atem-connection`), without linking SDK code into the bridge process.

## Design rules

- **All SDK calls stay in this helper** to isolate crashes and blocking
  calls from the bridge (same doctrine as the DeckLink helper).
- **No SDK files are committed or shipped.** On macOS, headers come from the
  locally installed ATEM software (or `ATEM_SDK_ROOT`); the runtime is loaded by
  `BMDSwitcherAPIDispatch` from
  `/Library/Application Support/Blackmagic Design/Switchers/BMDSwitcherAPI.bundle`.
  On Windows, the helper builds against a minimal interoperability header with
  the known ATEM Switchers 9.x and 10.x Discovery COM identities.
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

Windows probe output also includes `sdk_generation` and `discovery_hr`. When
the SDK COM object is missing, it includes `discovery_hr_v97`,
`discovery_hr_v100`, and the `CoCreateInstance` HRESULTs in `detail`.

Stable error identifiers: `atem_software_not_installed`,
`no_usb_switcher_found`, `incompatible_firmware`, `corrupt_data`,
`state_sync_failed`, `state_sync_timed_out`.

## Build

macOS:

```bash
./build.sh                       # uses the installed ATEM Developer SDK
ATEM_SDK_ROOT=/path/to/SDK ./build.sh
```

Windows (x64 Developer PowerShell for VS — `cl` on PATH; no ATEM SDK required):

```powershell
.\build.ps1
```

On Windows the graceful-degradation path is COM-based: without the ATEM
software installed, `CoCreateInstance` fails (`REGDB_E_CLASSNOTREG`) and the
helper reports `atem_software_not_installed` exactly like on macOS.
The default Windows build embeds both known Discovery generations:

- 9.x Discovery IID `83C30ED4-4314-4C81-B1E3-23C518D6D8BD`, CLSID
  `B8C0BA7E-BDED-4B73-96A8-266AF1BC2D7A`
- 10.x Discovery IID `1EEE089A-5422-4A76-B068-F6EDCFBD3AC0`, CLSID
  `8A13D4FA-4801-48E3-BF68-442D63E34500`

For local SDK cross-checks only, `.\build.ps1 -UseSdkIdl` runs `midl` against
an installed SDK IDL after checking `ATEM_SDK_ROOT`, the current
`Blackmagic Design\ATEM Switchers\Developer SDK\Windows` install path, and the
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

- `{"type":"ready","helper_build":{"sdk_idl_sha":"...","sdk_discovery_clsid":"...","sdk_version":"..."}}` — emitted once at startup. Windows also includes `sdk_generation`.
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
