Stand: 19. Februar 2026.

## Ziel

macOS-App (`.app` im `.dmg`) korrekt für Direct Distribution bereitstellen:
1. Code Signing
2. Notarization
3. Stapling

## Schritt 1: Apple Developer vorbereiten (außerhalb vom Code)

1. Apple Developer Program aktiv haben (Team).
2. Zertifikat `Developer ID Application` erstellen.
3. Zertifikat als `.p12` exportieren (inkl. privatem Schlüssel).
4. In App Store Connect einen API Key für Notarization erstellen:
   - `Issuer ID`
   - `Key ID`
   - `.p8` Datei herunterladen

Hinweis:
- Für euren aktuellen DMG-Flow reicht `Developer ID Application`.
- `Developer ID Installer` braucht ihr erst bei `.pkg`.

## Schritt 2: GitHub Secrets anlegen (außerhalb vom Code)

In `Settings -> Secrets and variables -> Actions` anlegen:

- `APPLE_SIGNING_IDENTITY` (z. B. `Developer ID Application: Firma GmbH (TEAMID)`)
- `CSC_LINK` (Base64 oder URL zur `.p12`)
- `CSC_KEY_PASSWORD` (Passwort der `.p12`)
- `APPLE_API_KEY` (Base64-Inhalt der `.p8`)
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

## Schritt 3: `electron-builder.json` ergänzen

Eure Datei hat aktuell nur `mac.target = dmg`. Ergänze für Signing/Notarization:

```json
{
  "appId": "com.broadify.bridge",
  "mac": {
    "target": "dmg",
    "icon": "./icon.png",
    "category": "public.app-category.utilities",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist"
  }
}
```

Wichtig:
1. `appId` auf finalen Broadify-Wert setzen (kein Template-Wert).
2. Entitlements minimal halten.

## Schritt 4: Entitlements-Datei anlegen

Datei: `build/entitlements.mac.plist`

Start minimal und erweitere nur bei Bedarf (z. B. wenn Electron-Features sonst blockieren):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
```

## Schritt 5: Release-Workflow um Notarization-Env erweitern

Im macOS-Job von `.github/workflows/release.yml` zusätzliche `env` bereitstellen:

```yaml
env:
  APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
  CSC_LINK: ${{ secrets.CSC_LINK }}
  CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
  APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
  APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
  APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
```

## Schritt 6: Build ausführen

1. Tag auf `main` pushen (euer `release.yml` triggert auf `v*`).
2. macOS-Job läuft und baut `dist/*.dmg`.
3. electron-builder signiert und notarisiert im Build-Prozess.

Lokaler Test:

```bash
npm run dist:mac:arm64
```

## Schritt 7: Verifikation erzwingen (Pflicht)

Nach Build auf macOS prüfen:

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Broadify Bridge.app"
spctl -a -t exec -vv "dist/mac-arm64/Broadify Bridge.app"
xcrun stapler validate "dist/Broadify Bridge-<version>-arm64.dmg"
```

Erwartung:
1. `codesign` ohne Fehler
2. `spctl` akzeptiert Artefakt
3. `stapler validate` erfolgreich

## Schritt 8: Manual Fallback (wenn CI hängt)

Wenn Notarization in CI fehlschlägt:
1. Lokal auf macOS signieren
2. Manuell mit `xcrun notarytool submit ... --wait` notarize
3. Mit `xcrun stapler staple` staplen
4. Dieselben Verify-Checks aus Schritt 7 fahren

## Quick-Checkliste

1. Apple Team + `Developer ID Application` vorhanden.
2. API Key (`.p8`) für Notarization vorhanden.
3. Secrets für Zertifikat + Notary gesetzt.
4. `electron-builder.json` hat `hardenedRuntime` + Entitlements.
5. `appId` ist final.
6. Build erzeugt notarisiertes, gestapeltes DMG.
7. `codesign`, `spctl`, `stapler validate` sind grün.

## Quellen

- https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- https://www.electron.build/mac.html
- https://www.electron.build/code-signing-mac.html
