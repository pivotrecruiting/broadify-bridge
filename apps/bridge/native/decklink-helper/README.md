# DeckLink Helper (macOS)

This directory is reserved for the native DeckLink helper binary.

Planned behavior:
- `decklink-helper --list` prints a JSON array of devices.
- `decklink-helper --watch` prints JSON events (one per line) for hotplug.
- `decklink-helper --playback` reads RGBA frames from stdin and outputs SDI key/fill or single video.

The helper must use the DeckLink SDK and follow the official samples:
- Device enumeration via `CreateDeckLinkIteratorInstance`.
- Hotplug via `IDeckLinkDiscovery::InstallDeviceNotifications`.
- Output/keying via `IDeckLinkOutput` + `IDeckLinkKeyer` (external keying).
- Single video output via `IDeckLinkOutput` (no keyer).

The Bridge expects the helper at:
- Dev: `apps/bridge/native/decklink-helper/decklink-helper`
- Prod: `${process.resourcesPath}/native/decklink-helper/decklink-helper`

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
- `--output-port <device-id>-sdi|<device-id>-hdmi`
- `--width <int> --height <int> --fps <int>`
