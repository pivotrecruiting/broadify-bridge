# Local Presentation Rendering

Broadify Meeting renders presentation content only on the Bridge host. Presentation files never leave the local machine.

## Runtime

The macOS Apple Silicon Bridge release packages LibreOffice 26.2.4 under `Contents/Resources/presentation-runtime/macos-arm64`. The release command prepares this runtime from the official LibreOffice disk image, validates SHA-256, and includes it in the signed application bundle.

PPTX files are converted to PDF with the bundled LibreOffice process. PDF pages are rendered into 1920 px PNG files with PDF.js and `@napi-rs/canvas`; the Bridge does not require a global Python, PyMuPDF, or LibreOffice installation.

## Storage and limits

The upload endpoint streams each file to the Bridge data directory. The per-file limit is 500 MB. Each asset stores its original input, optional converted PDF, rendered page PNGs, and metadata beneath `<Bridge user data>/meeting-media`.

The native Meeting Helper receives only the selected local PNG path. It does not parse PPTX or PDF files.

## Platform scope

The first release supports macOS Apple Silicon. Other platforms report `unsupported_platform` through `GET /meeting/media/rendering-status`, and the Meeting Builder disables presentation uploads.
