# Local Presentation Rendering

Broadify Meeting renders presentation content only on the Bridge host. Presentation files never leave the local machine.

## Runtime

The macOS Apple Silicon Bridge release packages LibreOffice 26.2.4 under `Contents/Resources/presentation-runtime/macos-arm64`.

Release builds download a pinned, pre-signed bundle via `PRESENTATION_RUNTIME_URL_ARM64` / `PRESENTATION_RUNTIME_SHA256_ARM64` (see `apps/bridge/vendor/presentation-runtime/DEPLOY.md`). Local development falls back to `npm run prepare:presentation-runtime:macos`, which extracts the upstream DMG on first use.

`electron-builder` skips re-signing the bundled `LibreOffice.app` (`signIgnore`); the release asset must therefore be signed with the Broadify Developer ID before upload.

PPTX files are converted to PDF with the bundled LibreOffice process. PDF pages are rendered into 1920 px PNG files with PDF.js and `@napi-rs/canvas`; the Bridge does not require a global Python, PyMuPDF, or LibreOffice installation.

## Storage and limits

The upload endpoint streams each file to the Bridge data directory. The per-file limit is 500 MB. Each asset stores its original input, optional converted PDF, rendered page PNGs, and metadata beneath `<Bridge user data>/meeting-media`.

The native Meeting Helper receives only the selected local PNG path. It does not parse PPTX or PDF files.

## Platform scope

The first release supports macOS Apple Silicon. Other platforms report `unsupported_platform` through `GET /meeting/media/rendering-status`, and the Meeting Builder disables presentation uploads.
