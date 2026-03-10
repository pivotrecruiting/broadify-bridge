# Display Helper (macOS / Windows)

Native C++ helper that reads RGBA frames from FrameBus shared memory and displays fullscreen via SDL2. Used by the Display Video Output Adapter on macOS and Windows.

## Prerequisites

- macOS (arm64 or x64): `clang++` + SDL2 (`brew install sdl2`)
- Windows (x64): MSVC (`cl.exe`) + SDL2 (`SDL2_DIR` or `VCPKG_ROOT` configured)

## Build

macOS:

```bash
./build.sh
```

The macOS build requests a `13.0` deployment target by default. Override only if your support matrix is stricter:

```bash
DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET=13.0 ./build.sh
```

Optional SDL2 overrides (for portable/older runtime builds):

```bash
SDL2_DYLIB_PATH=/path/to/libSDL2-2.0.0.dylib \
SDL2_CFLAGS="-I/path/to/include -I/path/to/include/SDL2" \
SDL2_LIBS="-L/path/to/lib -lSDL2" \
DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET=13.0 ./build.sh
```

By default, if the SDL2 runtime `minOS` exceeds the requested deployment target, the build auto-upgrades the target so local builds keep working on newer macOS versions. Set `SDL2_STRICT_MINOS=1` to fail instead and enforce a Ventura-compatible SDL2 runtime for release builds.

Windows (Developer PowerShell):

```powershell
./build.ps1
```

The binary is placed at:
- macOS: `display-helper` + bundled runtime `libSDL2-2.0.0.dylib`
- Windows: `display-helper.exe` (plus optional `SDL2.dll` copied next to it)

On macOS the bundled runtime is rewritten to `@loader_path/libSDL2-2.0.0.dylib`, so the packaged app does not depend on Homebrew paths on the target machine.
After the rewrite, the build re-signs both the dylib and helper binary. Local builds use ad-hoc signing automatically; release builds use `APPLE_SIGNING_IDENTITY` / `CSC_NAME` when present.

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
| `--fps <int>` | Target FPS (default 50) |
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
- Windows Dev: `apps/bridge/native/display-helper/display-helper.exe`
- Windows Prod: `${process.resourcesPath}/native/display-helper/display-helper.exe`

Override with `BRIDGE_DISPLAY_HELPER_PATH`.
