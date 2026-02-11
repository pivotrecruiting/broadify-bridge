# Display Helper (macOS)

Native C++ helper that reads RGBA frames from FrameBus shared memory and displays fullscreen via SDL2. Replaces the Electron Display Helper when `BRIDGE_DISPLAY_NATIVE_HELPER=1` to eliminate IPC bottlenecks (SIGSEGV at 60 fps with large frames).

## Prerequisites

- macOS (arm64 or x64)
- clang++
- SDL2 (`brew install sdl2`)

## Build

```bash
./build.sh
```

The binary is placed at `display-helper` in this directory.

## Usage

The helper is started by the Display Output Adapter when FrameBus and Native Helper are enabled. Manual invocation for testing:

```bash
# With env (Bridge sets these when spawning)
BRIDGE_FRAMEBUS_NAME=broadify-framebus-xxx \
BRIDGE_FRAME_WIDTH=2560 \
BRIDGE_FRAME_HEIGHT=1440 \
BRIDGE_FRAME_FPS=60 \
./display-helper

# Or with args
./display-helper \
  --framebus-name broadify-framebus-xxx \
  --width 2560 \
  --height 1440 \
  --fps 60 \
  --display-index 0
```

## Arguments

| Arg | Description |
|-----|-------------|
| `--framebus-name <name>` | FrameBus shared memory name |
| `--width <int>` | Frame width |
| `--height <int>` | Frame height |
| `--fps <int>` | Target FPS (default 60) |
| `--display-index <int>` | SDL display index (default 0) |

## Handshake

- Sends `{"type":"ready"}` on stdout after FrameBus is open and SDL window is created.
- Bridge waits for this before considering the output configured.

## Shutdown

- SIGTERM or SIGINT triggers clean exit.
- Bridge sends SIGTERM on `stop()`, then SIGKILL if necessary.

## Path Resolution

- Dev: `apps/bridge/native/display-helper/display-helper`
- Prod: `${process.resourcesPath}/native/display-helper/display-helper`

Override with `BRIDGE_DISPLAY_HELPER_PATH`.
