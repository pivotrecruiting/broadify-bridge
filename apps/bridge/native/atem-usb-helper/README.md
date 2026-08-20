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

```bash
./atem-usb-helper --probe
```

Prints a single JSON object:

- SDK missing: `{"mode":"probe","sdk_available":false,"connected":false,"error":"atem_software_not_installed"}`
- No switcher on USB: `{"mode":"probe","sdk_available":true,"connected":false,"error":"no_usb_switcher_found"}`
- Connected: `{"mode":"probe","sdk_available":true,"connected":true,"product_name":"...","macro_slots":100,"valid_macros":3}`

Stable error identifiers: `atem_software_not_installed`,
`no_usb_switcher_found`, `incompatible_firmware`, `corrupt_data`,
`state_sync_failed`, `state_sync_timed_out`.

## Build (macOS)

```bash
./build.sh                       # uses the installed ATEM Developer SDK
ATEM_SDK_ROOT=/path/to/SDK ./build.sh
```

A long-lived `--run` mode (NDJSON commands/events for connect, macro run/stop
and state change events) plus the Windows build follow in later steps; the
bridge-side `AtemUsbAdapter` consumes that mode.
