# ATEM USB Helper — Release Artifacts

CI runners have no ATEM SDK, so release builds consume prebuilt helper
binaries as pinned release assets (same flow as the DeckLink helper).
Local `dist:*` runs build from source instead when the ATEM software is
installed; no SDK files are ever committed or shipped.

## 1. Build the artifacts (once per helper change)

macOS (both architectures; requires the ATEM software or ATEM_SDK_ROOT):

```bash
npm run prepare:atem-usb-helper-release   # on an arm64 machine
# repeat on an x64 machine (or build.sh under Rosetta with an x64 toolchain)
```

Windows (x64 Native Tools shell; requires the ATEM software):

```powershell
cd apps\bridge\native\atem-usb-helper
.\build.ps1
Get-FileHash .\atem-usb-helper.exe -Algorithm SHA256
```

## 2. Upload

Upload `atem-usb-helper-arm64`, `atem-usb-helper-x64` and
`atem-usb-helper.exe` as assets to the private assets release (same place
as the DeckLink helper artifacts).

## 3. Configure the repo secrets

| Secret | Value |
|---|---|
| `ATEM_USB_HELPER_URL_ARM64` / `ATEM_USB_HELPER_SHA256_ARM64` | asset URL + SHA256 |
| `ATEM_USB_HELPER_URL_X64` / `ATEM_USB_HELPER_SHA256_X64` | asset URL + SHA256 |
| `ATEM_USB_HELPER_URL_WIN` / `ATEM_USB_HELPER_SHA256_WIN` | asset URL + SHA256 |

The workflows set `SKIP_ATEM_USB_HELPER_BUILD=1` and download instead;
`scripts/download-atem-usb-helper.sh` verifies the SHA256 before install,
and `scripts/verify-release-artifacts.sh` requires the binary in the
packaged output.
