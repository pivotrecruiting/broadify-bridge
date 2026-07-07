# Broadify Virtual Camera — Windows (Media Foundation)

A Media Foundation virtual camera for Windows 11 (`MFCreateVirtualCamera`).
It exposes the meeting-helper's live program frame to any camera app
(Teams, Zoom, Meet, the Windows Camera app) as **"Broadify Camera"**.

## Architecture

```
meeting-helper  --(raw BGRA frame stream, loopback TCP :18787)-->  broadify-vcam.dll
   (program frames)                                                (IMFMediaSource, RGB32)
                                                                          |
                                                        Windows Frame Server loads the DLL
                                                                          |
                                                        MFCreateVirtualCamera("Broadify Camera")
                                                                          |
                                                              Teams / Zoom / Camera app
```

The media source lives in `broadify-vcam.dll` and is loaded by the Windows
Frame Server (a service). It consumes **Channel A** — the raw-frame TCP
stream served by the meeting-helper (`--vcam-frame-port`, default 18787) —
rather than the FrameBus shared memory, because the Frame Server session may
not see the helper's `Local\` mapping, while loopback TCP crosses that
boundary. The stream already ships pre-swizzled BGRA, which maps directly to
`MFVideoFormat_RGB32`.

Source layout:

- `raw_frame_client.*` — Channel-A consumer (BFRG records, reconnect/backoff).
- `media_source.*` / `media_stream.*` — `IMFMediaSourceEx` / `IMFMediaStream2`
  (RGB32, resolution taken dynamically from the stream header).
- `mf_attributes.h` — `IMFAttributes` delegation.
- `dllmain.cpp` — class factory, DLL exports, and COM registration.
- `vcam_log.*` — fault-tolerant logging to `%ProgramData%\Broadify\vcam.log`.

Media-source contract modelled on Microsoft's VCamSample (MIT).

## Build

From a **Developer PowerShell for VS** (CMake + MSVC on PATH):

```powershell
cmake -S apps\bridge\native\vcam-helper\windows -B build\vcam -DCMAKE_BUILD_TYPE=Release
cmake --build build\vcam --config Release
# -> build\vcam\Release\broadify-vcam.dll
```

## Register (Administrator required)

The Frame Server resolves the CLSID from **HKEY_LOCAL_MACHINE**, so the DLL
must be registered from an **elevated** shell, and it must live at a stable
path (never register a DLL from a temp/build directory — if it is cleaned up,
HKLM points at nothing).

Use the deploy script from an elevated PowerShell; it unregisters the old
copy, installs the new DLL to `C:\dev\broadify-vcam\`, and registers it:

```powershell
# register / refresh (run after every rebuild)
.\deploy-vcam.ps1 -SourceDll <path>\build\vcam\Release\broadify-vcam.dll

# unregister (clean rollback — removes the whole HKLM CLSID tree)
.\deploy-vcam.ps1 -Unregister
```

Equivalent manual commands (elevated), for the installer / reference:

```powershell
regsvr32 "C:\dev\broadify-vcam\broadify-vcam.dll"        # register
regsvr32 /u "C:\dev\broadify-vcam\broadify-vcam.dll"     # unregister
```

**Re-run the register step on every rebuild** (unregister → copy → register),
otherwise the Frame Server keeps loading the previously registered file.

## Run

1. Start the meeting-helper with the raw stream enabled
   (`camera.start`, program `camera.enabled`, `output.framebus.start`).
2. Create the virtual camera (Session lifetime) with `MFCreateVirtualCamera`
   using `sourceId = "{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}"`.
3. Open the Windows Camera app (or Teams/Zoom) and pick **"Broadify Camera"**.
