# DeckLink Helper (macOS)

This directory is reserved for the native DeckLink helper binary.

Current behavior:
- `decklink-helper --list` prints a JSON array of devices.
- `decklink-helper --list --with-diagnostics` prints
  `{"devices":[...],"diagnostics":{...}}` with DeckLink API availability,
  API version when available, helper version and an optional error string.
- `decklink-helper --watch` prints JSON events (one per line) for hotplug.
- `decklink-helper --playback` reads RGBA 8-bit frames from stdin (RGBA order, 4 Bpp),
  then outputs SDI key/fill or single video using the selected pixel format.
- `decklink-helper --list-modes` prints JSON display modes for a device/connection.
- `decklink-helper --version` prints
  `{"type":"version","helperVersion":"...","builtAt":"..."}`.

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
- `--display-mode <sdk-mode-id>` (optional; exact DeckLink mode id wins before
  the width/height/fps heuristic)
- `--pixel-format <label>` (single choice)
- `--pixel-format-priority <label,label,...>` (priority list)
- `--range <legal|full>` (RGB range mapping)

Mode listing (diagnostics):
- `decklink-helper --list-modes --device <decklink-id> --output-port <device-id>-sdi`
- Optional filters: `--width <int> --height <int> --fps <int>`
- Keying modes only: `--keying`

Stdout protocol:

| Event | When |
| --- | --- |
| `ready` | Emitted after output setup and FrameBus validation. Includes `helperVersion`; readiness semantics are unchanged. |
| `playback_started` | Emitted after `StartScheduledPlayback` succeeds. |
| `metrics` | Emitted periodically during playback. FrameBus metrics include `tornFrames`. |
| `warning` | Additive non-fatal notices, including `display_mode_id_not_found` before heuristic fallback. |
| `fatal` | Emitted before helper-owned fatal exits with `code`, `message` and optional `hresult`. |

Fatal codes used by playback:
- `invalid_config`
- `device_not_found`
- `output_interface_unavailable`
- `no_external_keying`
- `no_supported_mode`
- `connection_unsupported`
- `enable_video_output_failed`
- `device_busy`
- `keyer_enable_failed`
- `framebus_open_failed`
- `framebus_geometry_mismatch`
- `start_scheduled_playback_failed`
- `playback_stopped`
- `schedule_frame_failed`

Exit codes:
- `0`: normal completion
- `1`: configuration, hardware selection or setup failure
- `2`: DeckLink API unavailable in `--watch`
- `3`: playback started or start attempted, then DeckLink scheduled playback failed/stopped

FrameBus reader policy:
- The reader reopens the shared memory region after 2 seconds without sequence
  progress. If a stale reopen fails, the helper keeps the last scheduled frame
  alive and retries every 5 seconds.
- After copying slot `(seq - 1) % slot_count`, the helper re-reads `seq`; if the
  writer may have reached the first reuse of that slot (`seqAfter - seqBefore >=
  slot_count - 1`, or any change with one slot), it discards the read and
  retries boundedly.

SDK-free policy test:

```bash
clang++ -std=c++17 apps/bridge/native/decklink-helper/tests/reader-policy-test.cpp -o /tmp/decklink-reader-policy-test && /tmp/decklink-reader-policy-test
```
