# DeckLink Helper (macOS)

This directory is reserved for the native DeckLink helper binary.

Current behavior:
- `decklink-helper --list` prints a JSON array of devices.
- `decklink-helper --watch` prints JSON events (one per line) for hotplug.
- `decklink-helper --playback` reads RGBA 8-bit frames from stdin (RGBA order, 4 Bpp),
  then outputs SDI key/fill or single video using the selected pixel format.
- `decklink-helper --list-modes` prints JSON display modes for a device/connection.

The helper must use the DeckLink SDK and follow the official samples:
- Device enumeration via `CreateDeckLinkIteratorInstance`.
- Hotplug via `IDeckLinkDiscovery::InstallDeviceNotifications`.
- Output/keying via `IDeckLinkOutput` + `IDeckLinkKeyer` (external keying).
- Single video output via `IDeckLinkOutput` (no keyer).

Pixel format + colorspace notes (actual behavior):
- Pixel format is selected via `--pixel-format` or `--pixel-format-priority`.
- YUV output uses `IDeckLinkVideoConversion::ConvertNewFrame` with colorspace from
  display mode flags (Rec601/709/2020).
- RGB channels are mapped to legal range (16-235) before output.

The Bridge expects the helper at:
- Dev: `apps/bridge/native/decklink-helper/decklink-helper`
- Prod: `${process.resourcesPath}/native/decklink-helper/decklink-helper`

Release workflow (best practice):
- Build helper binaries locally (macOS arm64 + x64) using the SDK.
- Publish the binaries as artifacts (no SDK shipped).
- CI downloads artifacts via `DECKLINK_HELPER_URL_*` and verifies SHA256.

Security note: Keep SDK calls in the helper to isolate crashes and blocking calls.

## Build (macOS)

```bash
./build.sh
```

Environment overrides:
- `DECKLINK_SDK_ROOT` (default: `/Users/dennisschaible/SDKs/Blackmagic`)
- `DECKLINK_FRAMEWORK_PATH` (default: `/Library/Frameworks`)

Requires:
- Blackmagic Desktop Video (installs `DeckLinkAPI.framework`)

Playback args (bridge-managed):
- `--device <decklink-id>`
- `--fill-port <device-id>-sdi-a`
- `--key-port <device-id>-sdi-b`
- `--output-port <device-id>-sdi|<device-id>-sdi-a|<device-id>-hdmi`
- `--width <int> --height <int> --fps <int>`
- `--pixel-format <label>` (single choice)
- `--pixel-format-priority <label,label,...>` (priority list)
- `--range <legal|full>` (RGB range mapping)

Mode listing (diagnostics):
- `decklink-helper --list-modes --device <decklink-id> --output-port <device-id>-sdi`
- Optional filters: `--width <int> --height <int> --fps <int>`
- Keying modes only: `--keying`
