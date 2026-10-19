# Bundled LibreOffice on Windows (PPTX -> PDF)

Meeting content PPTX is converted to PDF on the bridge via LibreOffice
(`soffice --headless --convert-to pdf`), then rendered to page images with pdfjs.
LibreOffice was bundled for macOS only, so on Windows PPTX failed with
"No LibreOffice installation was found" unless the operator installed LibreOffice
system-wide. This bundles LibreOffice for Windows the same way it is bundled for
macOS, so PPTX works out of the box.

## What this change adds (code — done)
- `resolveLibreOffice` (meeting-media-service.ts) now also looks for a bundled
  Windows runtime at `<resources>/presentation-runtime/win-x64/program/soffice.exe`
  (preferred over a system install).
- `electron-builder.config.cjs` packages `apps/bridge/vendor/presentation-runtime/win-x64`
  into the Windows app **only if it was provisioned** (guarded by `existsSync`), so
  the build never fails when the runtime is absent.
- `scripts/prepare-windows-presentation-runtime.ps1` + `npm run ensure:presentation-runtime:windows`,
  wired into `dist:win`, download + verify + unpack the runtime (mirrors the mac
  `download-presentation-runtime-macos.sh`). No-op when not configured.

## What Dennis must do (infra — one-time, mirrors the macOS setup)
1. **Prepare the runtime zip.** Take an official **LibreOffice Windows x64** release
   (same major/minor you're comfortable supporting), install/extract it, and zip its
   install tree so that unzipping into `win-x64/` yields `win-x64/program/soffice.exe`
   (i.e. the zip root contains `program/`, `share/`, ... — the LibreOffice program
   tree, not an outer `LibreOffice/` folder). Keep LibreOffice's `LICENSE`/`NOTICE`
   files in the tree (they ship inside it) so the attribution rides along.
   - A minimal tree (program/ + share/ + the fonts/filters LibreOffice needs for
     pptx->pdf) is enough; the full install also works (just larger).
2. **Host it** on the same release mirror as the macOS runtime.
3. **Set the CI Release-Build variables** (next to `PRESENTATION_RUNTIME_URL_ARM64` /
   `PRESENTATION_RUNTIME_SHA256_ARM64`):
   - `PRESENTATION_RUNTIME_URL_WIN` = https URL of the zip
   - `PRESENTATION_RUNTIME_SHA256_WIN` = lowercase hex SHA256 of the zip
4. Cut the next RC. The Windows build then bundles LibreOffice and PPTX works
   without a system install. Windows installer grows by the runtime size (~200-350 MB
   depending on how trimmed the tree is).

Until step 3 is done, the code is inert on Windows: the build ships without the
bundle and PPTX keeps using a system LibreOffice / `BROADIFY_SOFFICE_PATH` if present.

## Licensing
LibreOffice is **MPL 2.0** — commercial redistribution/bundling of the unmodified
binaries is permitted; our own source stays closed. Obligations: ship LibreOffice's
license/notice files (they are inside the bundled tree) and do not rebrand it or
imply endorsement. This is a standard commercial bundling case. (Not legal advice —
a quick legal sign-off before a production ship is sensible.)
