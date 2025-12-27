# Release Management

## Übersicht

Dieses Dokument beschreibt den Prozess für das Erstellen und Veröffentlichen von Releases der Broadify Bridge Desktop App.

## Erste Einrichtung

### GitHub Repository konfigurieren

1. Stelle sicher, dass das Repository auf GitHub existiert
2. Der GitHub Actions Workflow verwendet automatisch `GITHUB_REPOSITORY` aus der Umgebung
3. Für die Web-App Integration: Passe `GITHUB_OWNER` und `GITHUB_REPO` in der Web-App an

## Versionierung

### Version Format

Die Versionierung folgt dem [Semantic Versioning](https://semver.org/) Format:

- **Major** (z.B. `1.0.0`): Breaking Changes
- **Minor** (z.B. `0.1.0`): Neue Features, rückwärtskompatibel
- **Patch** (z.B. `0.0.1`): Bugfixes, rückwärtskompatibel

### Version in package.json

Die Version wird in `package.json` gepflegt:

```json
{
  "version": "0.1.0"
}
```

### Git Tags Format

Git Tags müssen dem Format `v{VERSION}` entsprechen:

- `v1.0.0` für Major Release
- `v0.1.0` für Minor Release
- `v0.0.1` für Patch Release

## Release-Prozess

### 1. Version aktualisieren

1. Version in `package.json` aktualisieren
2. Änderungen committen:
   ```bash
   git add package.json
   git commit -m "chore: bump version to 0.1.0"
   ```

### 2. Git Tag erstellen

```bash
git tag -a v0.1.0 -m "Release version 0.1.0"
git push origin v0.1.0
```

### 3. Automatischer Build

Nach dem Push des Tags wird automatisch ein GitHub Actions Workflow ausgelöst:

- Build für alle Plattformen (macOS ARM64/x64, Windows x64, Linux x64)
- Upload der Artefakte zu GitHub Releases
- Erstellung eines GitHub Releases mit allen Download-Links

### 4. Release verifizieren

1. GitHub Repository → Releases
2. Prüfen, ob alle Plattformen gebaut wurden
3. Download-Links testen

## Build-Artefakte

### macOS

- **ARM64 (Apple Silicon)**: `broadify-bridge-{version}-arm64.dmg`
- **x64 (Intel)**: `broadify-bridge-{version}-x64.dmg`
- **Update-Metadaten**: `latest-mac.yml`

### Windows

- **Portable**: `broadify-bridge-{version}-win-x64.exe`
- **Installer**: `broadify-bridge-{version}-win-x64.msi`
- **Update-Metadaten**: `latest.yml`

### Linux

- **AppImage**: `broadify-bridge-{version}-x64.AppImage`
- **Update-Metadaten**: `latest-linux.yml`

## Manuelle Builds (Development)

Für lokale Tests können Builds manuell erstellt werden:

```bash
# Alle Plattformen
npm run dist:all

# Einzelne Plattformen
npm run dist:mac:arm64    # macOS ARM64
npm run dist:mac:x64      # macOS Intel
npm run dist:win          # Windows
npm run dist:linux        # Linux
```

## GitHub Releases API

Die Web-App kann die Download-Links über die GitHub Releases API abrufen:

### Latest Release

```bash
GET https://api.github.com/repos/{owner}/{repo}/releases/latest
```

### Response Beispiel

**WICHTIG:** Die GitHub Releases API gibt ALLE Assets zurück, inklusive `.blockmap` und `.yml` Dateien. Diese müssen gefiltert werden!

```json
{
  "tag_name": "v0.1.0",
  "name": "Release 0.1.0",
  "assets": [
    {
      "name": "broadify-bridge-0.1.0-arm64.dmg",
      "browser_download_url": "https://github.com/{owner}/{repo}/releases/download/v0.1.0/broadify-bridge-0.1.0-arm64.dmg",
      "size": 133901796,
      "content_type": "application/x-apple-diskimage"
    },
    {
      "name": "broadify-bridge-0.1.0-arm64.dmg.blockmap",
      "browser_download_url": "https://github.com/{owner}/{repo}/releases/download/v0.1.0/broadify-bridge-0.1.0-arm64.dmg.blockmap",
      "size": 12345,
      "content_type": "application/octet-stream"
    },
    {
      "name": "broadify-bridge-0.1.0-x64.dmg",
      "browser_download_url": "https://github.com/{owner}/{repo}/releases/download/v0.1.0/broadify-bridge-0.1.0-x64.dmg",
      "size": 133901796,
      "content_type": "application/x-apple-diskimage"
    },
    {
      "name": "broadify-bridge-0.1.0-x64.dmg.blockmap",
      "browser_download_url": "https://github.com/{owner}/{repo}/releases/download/v0.1.0/broadify-bridge-0.1.0-x64.dmg.blockmap",
      "size": 12345,
      "content_type": "application/octet-stream"
    },
    {
      "name": "latest-mac.yml",
      "browser_download_url": "https://github.com/{owner}/{repo}/releases/download/v0.1.0/latest-mac.yml",
      "size": 1234,
      "content_type": "text/yaml"
    },
    {
      "name": "broadify-bridge-0.1.0-win-x64.exe",
      "browser_download_url": "https://github.com/{owner}/{repo}/releases/download/v0.1.0/broadify-bridge-0.1.0-win-x64.exe",
      "size": 120000000,
      "content_type": "application/x-msdownload"
    },
    {
      "name": "broadify-bridge-0.1.0-win-x64.msi",
      "browser_download_url": "https://github.com/{owner}/{repo}/releases/download/v0.1.0/broadify-bridge-0.1.0-win-x64.msi",
      "size": 125000000,
      "content_type": "application/x-msi"
    },
    {
      "name": "broadify-bridge-0.1.0-x64.AppImage",
      "browser_download_url": "https://github.com/{owner}/{repo}/releases/download/v0.1.0/broadify-bridge-0.1.0-x64.AppImage",
      "size": 110000000,
      "content_type": "application/x-executable"
    }
  ]
}
```

**Filter-Regeln für Web-App:**

- ✅ Verwende: `.dmg`, `.exe`, `.msi`, `.AppImage` Dateien
- ❌ Ignoriere: `.blockmap` Dateien (für Delta-Updates, nicht für Downloads)
- ❌ Ignoriere: `.yml` / `.yaml` Dateien (Update-Metadaten, nicht für Downloads)

Siehe [WEB_APP_INTEGRATION.md](./WEB_APP_INTEGRATION.md) für Beispiel-Implementation mit Filterung.

## Web-App Integration

Siehe [WEB_APP_INTEGRATION.md](./WEB_APP_INTEGRATION.md) für Details zur Integration in die Web-App.
