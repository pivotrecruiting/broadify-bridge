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
- `APPLE_API_KEY` (Secret-Inhalt der `.p8`, z. B. Base64 oder raw PEM; im CI in Datei schreiben)
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

## Schritt 3: `electron-builder.json` ergänzen

Ergänze (bzw. prüfe) für Signing/Notarization mindestens:

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
    "entitlementsInherit": "build/entitlements.mac.plist",
    "notarize": true
  }
}
```

Wichtig:

1. `appId` auf finalen Broadify-Wert setzen (kein Template-Wert).
2. Entitlements minimal halten.
3. `notarize: true` ist optional, macht die Intention aber explizit. Die Notarization startet nur mit gesetzten Apple-Notary-Env-Variablen.

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

Hinweis:

- `@electron/notarize` erwartet für `APPLE_API_KEY` einen **Dateipfad** zur `.p8`.
- Wenn das GitHub Secret den Key-Inhalt (Base64 oder raw PEM) enthält, muss der Workflow ihn vor dem Build in eine temporäre Datei schreiben und `APPLE_API_KEY` auf diesen Pfad setzen.

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
4. `scripts/verify-macos-release-signing.sh` meldet `Main executable LC_UUID -> <uuid>` (siehe Abschnitt "Main executable UUID")

## Main executable UUID (LC_UUID)

**Warum.** macOS Local-Network-Privacy (Systemeinstellungen › Datenschutz & Sicherheit › Lokales Netzwerk) knüpft seine Entscheidung nicht nur an die Bundle-ID, sondern an die `LC_UUID` des Hauptexecutables (Apple TN3179). electron-builder benennt den Stock-Electron-Launcher (`node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`) nur um, d. h. **Prod (`com.broadify.bridge`) und RC (`com.broadify.bridge.rc`) hatten dieselbe UUID** (`4C4C44E2-5555-3144-A1E4-96FF6D8E37B0`). Folge im Feld: die RC-App erbte eine veraltete Deny-Entscheidung, zeigte nie den Local-Network-Dialog und ATEM-over-IP lief ins Timeout, während Prod funktionierte. Upstream: electron-userland/electron-builder#10297.

**Was gepatcht wird.** Der afterPack-Hook `scripts/patch-macos-main-executable-uuid.cjs` (aktiv über `electron-builder.config.cjs`, nur auf macOS) schreibt die `LC_UUID` des Hauptexecutables `Contents/MacOS/<productFilename>` um. Helper-Apps (Meeting Helper, PGM Helper, VCam) bleiben unberührt – TN3179 bezieht sich auf das Hauptexecutable, Helper laufen als Kindprozesse; der Bridge-Server selbst läuft als dasselbe Executable (`process.execPath` mit `ELECTRON_RUN_AS_NODE`), spricht also mit genau dieser UUID im LAN. Der Hook läuft in app-builder-lib 25 **vor** dem Signieren, die gepatchte Binary ist daher von codesign und Notarization abgedeckt. Thin- und Universal-(FAT-)Binaries werden unterstützt; die eigentliche Mach-O-Logik liegt in `scripts/lib/macho-uuid.cjs` (ohne Abhängigkeiten).

**Warum Prod ≠ RC, aber Updates stabil.** Die UUID ist deterministisch: SHA-256 über `appId \0 Contents/MacOS/<productFilename> \0 cputype`, erste 16 Bytes, RFC-4122-Version-5-/Variant-Bits. Die App-Version geht **nicht** ein. Damit bekommen Prod und RC verschiedene, aber über alle Releases hinweg stabile UUIDs – ein Update setzt die Local-Network-Freigabe nicht zurück, nur Prod und RC bekommen in TCC getrennte Einträge.

| Kanal | appId | Executable | arm64 LC_UUID |
| --- | --- | --- | --- |
| Prod | `com.broadify.bridge` | `Broadify Bridge` | `74ADD648-F95E-5731-BBA6-152E90ADB13C` |
| RC | `com.broadify.bridge.rc` | `Broadify Bridge RC` | `890B678E-AB3C-58C8-92C7-D932398BD590` |

**Verifikation.** `scripts/verify-macos-release-signing.sh` (läuft am Ende von `dist:mac:*`) liest die UUID per `dwarfdump --uuid`, vergleicht sie mit dem Sollwert aus der CLI und schlägt fehl, wenn sie vom Sollwert abweicht, noch der Stock-Electron-UUID entspricht oder mit dem jeweils anderen Kanal kollidiert. Manuell:

```bash
dwarfdump --uuid "dist/mac-arm64/Broadify Bridge.app/Contents/MacOS/Broadify Bridge"
node scripts/patch-macos-main-executable-uuid.cjs --print-expected \
  --app-id com.broadify.bridge --product-filename "Broadify Bridge" --cputype arm64
```

Beide Ausgaben müssen übereinstimmen. Sind Prod und RC gleichzeitig installiert, erscheinen unter Systemeinstellungen › Datenschutz & Sicherheit › Lokales Netzwerk zwei getrennte Einträge. Unit-Tests: `npm run test:release-contracts` (`scripts/macos-main-executable-uuid.test.cjs`).

**Hinweis dSYM/Sentry.** Gepatcht wird ausschließlich der ~34 KB große Electron-Launcher (`Contents/MacOS/<Name>`); `Electron Framework.framework` und alle Helper behalten ihre Original-UUIDs. Die Bridge nutzt `@sentry/electron` mit Default-Optionen (inkl. nativer Minidumps), lädt aber keine dSYMs hoch. Native Frames **innerhalb des Launchers** können mit der neuen UUID nicht mehr gegen Electrons öffentliche Symbole aufgelöst werden; da der Launcher nur in das Framework springt, liegt praktisch der gesamte native Code (und damit die Symbolisierung) weiterhin im unveränderten Framework.

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
