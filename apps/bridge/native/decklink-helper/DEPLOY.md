# DeckLink Helper Deploy (GitHub Release + Secrets)

## Ziel

Deploy des DeckLink Helper Binaries als GitHub Release Asset und Update der Secrets im Bridge Repo.

## Voraussetzungen

- macOS Build-Maschine mit installiertem Blackmagic Desktop Video.
- DeckLink SDK lokal installiert (nur fuer Build).
- Zugriff auf das Helper-Repo (Release Assets) und das Bridge-Repo (Secrets).
- Compatibility rule: land/deploy the TS side first, then publish the new helper
  asset. Older helpers remain valid but do not emit `helperVersion`,
  `playback_started`, diagnostics envelopes or fatal codes.

## Ablauf (arm64)

1) Build

```bash
cd apps/bridge/native/decklink-helper
./build.sh
```

Fuer den aktuellen Release-SDK-Pfad auf Gabriels Mac:

```bash
DECKLINK_SDK_ROOT="/Users/gabrielbaeuerle/Downloads/Blackmagic DeckLink SDK 16.0" ./build.sh
```

2) Binary umbenennen

```bash
mv decklink-helper decklink-helper-arm64
```

3) SHA256 erzeugen

```bash
shasum -a 256 decklink-helper-arm64
```

4) Binary auf Desktop kopieren

```bash
cp decklink-helper-arm64 ~/Desktop/
```

5) GitHub Release Asset hochladen

- Helper-Repo oeffnen (z. B. `broadify-decklink-helper`).
- **Releases** -> **Draft a new release**.
- Tag setzen (z. B. `v1.0.0`).
- Asset hochladen: `decklink-helper-arm64`.
- Release publizieren.

6) Secrets im Bridge-Repo aktualisieren

- Bridge-Repo -> **Settings** -> **Secrets and variables** -> **Actions**.
- Secrets setzen:
  - `DECKLINK_HELPER_URL_ARM64` =
    `https://github.com/<owner>/<helper-repo>/releases/download/<tag>/decklink-helper-arm64`
  - `DECKLINK_HELPER_SHA256_ARM64` = SHA256 aus Schritt 3

## Optional: x64 Build

Wenn ein x64 Binary benoetigt wird, Build auf einem x86_64 Mac wiederholen:

- Binary Name: `decklink-helper-x64`
- Secrets:
  - `DECKLINK_HELPER_URL_X64`
  - `DECKLINK_HELPER_SHA256_X64`

## Hinweise

- SDK Dateien niemals als Release Asset hochladen.
- Die Bridge laedt das Binary zur Build-Zeit und verifiziert per SHA256.

## Asset-Standort (Stand 24.9.2026)

Die aktuell in den Secrets referenzierten Assets liegen im Release
`helper-assets-20260924` des Bridge-Repos (`pivotrecruiting/broadify-bridge`),
weil das Helper-Repo fuer den CI-Account nicht beschreibbar ist. Das Release ist
bewusst nicht als „Latest" markiert und traegt kein `v*`-Tag, damit weder der
App-Updater noch der Release-Workflow darauf reagieren.
