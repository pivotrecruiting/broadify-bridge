# Presentation Runtime Deploy (GitHub Release + Secrets)

## Ziel

Deploy des pre-signed LibreOffice-Bundles als GitHub Release Asset und Update der Secrets im Bridge-Repo. Release-CI lädt das Asset statt LibreOffice bei jedem Build neu zu extrahieren und zu signieren.

## Voraussetzungen

- Apple Silicon Mac oder GitHub Actions Runner `macos-15`
- GitHub Secrets im Bridge-Repo:
  - `APPLE_SIGNING_IDENTITY`
  - `CSC_LINK`
  - `CSC_KEY_PASSWORD`

## Option A: GitHub Actions (empfohlen)

1. Workflow starten: **Build Presentation Runtime macOS Asset**
2. Inputs:
   - `runner_label`: `macos-15`
   - `publish_release`: `true`
3. Nach Abschluss in der Workflow-Zusammenfassung notieren:
   - Release URL
   - SHA256
4. Secrets im Bridge-Repo setzen:
   - `PRESENTATION_RUNTIME_URL_ARM64` = Release-Asset-URL
   - `PRESENTATION_RUNTIME_SHA256_ARM64` = SHA256 aus der Zusammenfassung

Standard-Release-Tag: `deps-presentation-runtime-<libreoffice_version>-macos-arm64`

## Option B: Lokal auf Apple Silicon

```bash
npm run prepare:presentation-runtime-macos-release
```

Voraussetzung: `APPLE_SIGNING_IDENTITY` ist gesetzt (Developer ID Application).

Output:

- `apps/bridge/vendor/presentation-runtime/presentation-runtime-macos-arm64.tar.gz`
- SHA256 wird im Terminal ausgegeben

Asset manuell als GitHub Release hochladen (Tag wie oben), danach Secrets setzen.

## LibreOffice-Version bumpen

1. `apps/bridge/vendor/presentation-runtime/manifest.json` aktualisieren
2. Asset neu bauen (Option A oder B)
3. Secrets `PRESENTATION_RUNTIME_URL_ARM64` und `PRESENTATION_RUNTIME_SHA256_ARM64` aktualisieren

## Hinweise

- Nur macOS Apple Silicon (`arm64`) ist derzeit gebündelt.
- Release-Builds erwarten das pre-signed Asset; ohne Secrets fällt CI auf den langsamen DMG-Fallback zurück.
- `electron-builder` signiert `LibreOffice.app` nicht erneut (`signIgnore`); das Asset muss daher korrekt mit Developer ID signiert sein.
