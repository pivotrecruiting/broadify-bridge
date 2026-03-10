# Release Process - Schritt für Schritt Anleitung

## Übersicht

Diese Anleitung beschreibt den kompletten Prozess für das Erstellen und Veröffentlichen eines Releases der Broadify Bridge Desktop App.

## Voraussetzungen

- Git Repository mit `main`, `dev` und Feature-Branches
- GitHub Actions Workflow (`.github/workflows/release.yml`) muss auf `main` vorhanden sein
- Version in `package.json` sollte aktualisiert sein
- DeckLink Helper Binary (macOS) ist als Release-Asset verfügbar
- GitHub Secrets gesetzt:
  - `DECKLINK_HELPER_URL_ARM64`, `DECKLINK_HELPER_SHA256_ARM64`
  - `DECKLINK_HELPER_URL_X64`, `DECKLINK_HELPER_SHA256_X64` (falls x64-Builds)
  - `APPLE_SIGNING_IDENTITY` (für macOS Code-Signing / Notarization, z.B. `Developer ID Application: Your Team (XXXXX)`)
  - `BRIDGE_RELAY_JWKS_URL` (für Production Relay)

## Release-Kanäle

- `latest`: Normales produktives Release für alle Nutzer
- `rc`: Downloadbarer Produktions-Testbuild vor dem finalen Rollout

Tag-Regel:

- `v0.11.8` => normales Release auf Kanal `latest`
- `v0.11.8-rc.1` => GitHub Pre-Release auf Kanal `rc`

Wirkung:

- RC-Builds sind installierbar und live testbar
- aktive Nutzer auf `latest` bekommen dadurch kein Auto-Update
- erst das spätere finale Tag ohne `-rc` triggert den echten Produktions-Rollout

## NPM-Release-Skript

Für den Standardfall gibt es jetzt ein automatisches Release-Skript:

```bash
# RC/Test-Release mit Patch-Bump
npm run release:test -- --bugfix

# RC/Test-Release mit Minor-Bump
npm run release:test -- --feature

# Echtes Release mit Patch-Bump
npm run release:live -- --bugfix

# Echtes Release mit Minor-Bump
npm run release:live -- --feature
```

Verhalten:

- `--bugfix` erhöht die Patch-Version
- `--feature` erhöht die Minor-Version und setzt Patch auf `0`
- `release:test` erzeugt Tags wie `v0.12.0-rc.1`
- `release:live` erzeugt Tags wie `v0.12.0`
- das Skript commitet den Versionssprung, erstellt den Tag und pusht Branch plus Tag nach `origin`

RC-Folgeschritte:

```bash
# Aus 0.12.0-rc.1 wird 0.12.0-rc.2
npm run release:test

# Aus 0.12.0-rc.2 wird 0.12.0
npm run release:live
```

Sicherheitsnetz:

- nur auf sauberem Working Tree
- nur auf Branch `main`
- optional prüfbar mit `--dry-run`

## DeckLink Helper Hosting (ohne SDK) - Einmalig vorbereiten

Best Practice: Eigener GitHub Release (separates Repo) mit nur dem fertigen Helper-Binary. Keine SDK-Dateien hochladen.

Security-Hinweis: Die CI lädt die Helper-Binaries von einer URL. Die Integrität wird per SHA256 geprüft. Nutze nur kontrollierte Release-Assets und aktualisiere die Hashes bei jedem neuen Helper-Build.

### Schritt A: Helper lokal bauen (macOS arm64)

1. DeckLink SDK lokal installieren (nur auf deinem Build-Mac).
2. Im Repo: `apps/bridge/native/decklink-helper/README.md` folgen.
3. `./build.sh` ausführen, das Binary landet in:
   - `apps/bridge/native/decklink-helper/decklink-helper`
4. Datei umbenennen zu `decklink-helper-arm64`.

Kurzweg vom Repo-Root:

```bash
npm run prepare:decklink-helper-release
```

Der Befehl:

- baut den Helper fuer die aktuelle macOS-Architektur
- erzeugt standardmaessig `decklink-helper-arm64` bzw. `decklink-helper-x64`
- gibt `minOS` und `SHA256` direkt aus

### Schritt B: Release-Assets hochladen (GitHub UI)

1. Öffne GitHub → Repo für den Helper (z. B. `broadify-decklink-helper`).
2. Klicke **Releases** → **Draft a new release**.
3. Tag setzen, z. B. `v1.0.0` (beliebig, aber konsistent).
4. Titel vergeben, z. B. `DeckLink Helper v1.0.0`.
5. Asset hochladen:
   - `decklink-helper-arm64`
6. **Publish release**.

### Schritt C: SHA256 berechnen (lokal)

```bash
shasum -a 256 apps/bridge/native/decklink-helper/decklink-helper-arm64
```

### Schritt D: Secrets im App-Repo setzen (GitHub UI)

1. Öffne GitHub → App-Repo (dieses Repo).
2. Klicke **Settings** → **Secrets and variables** → **Actions**.
3. **New repository secret** anlegen:
   - `DECKLINK_HELPER_URL_ARM64` = `https://github.com/<owner>/<helper-repo>/releases/download/<tag>/decklink-helper-arm64`
   - `DECKLINK_HELPER_SHA256_ARM64` = Hash aus Schritt C

### Schritt E: Test-Run (optional, manuell)

1. GitHub → App-Repo → **Actions**.
2. Workflow **Test Release Build** auswählen.
3. **Run workflow** klicken.
4. Nach Abschluss unter **Artifacts** prüfen, ob alle Plattformen gebaut wurden.

## FrameBus Addon - CI-Build

Das native FrameBus Node-Addon wird automatisch beim `dist:*` Build erstellt:

- **Build:** `npm run build:framebus` (via `scripts/build-framebus.sh`) – baut für die eingesetzte Electron-Version
- **Paketierung:** `framebus.node` landet via `extraResources` in `bridge/native/framebus/build/Release/`
- **Kein separater Schritt nötig** – das Addon wird vor jedem Release-Build gebaut

## Display Helper (ohne SDK) - CI-Build

Der Display Helper wird **nicht** separat gehostet wie der DeckLink Helper. Er wird direkt in der CI gebaut:

- **macOS Runners:** SDL2 wird per `brew install sdl2` installiert, danach `build:display-helper`.
- **Ventura-Kompatibilität:** `DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET=13.0`, `DECKLINK_HELPER_MACOSX_DEPLOYMENT_TARGET=13.0` und `MACOS_FLOOR_VERSION=13.0` sind fuer Release-Builds gesetzt.
- **Portable Runtime:** `build:display-helper` bundelt `libSDL2-2.0.0.dylib` neben dem Binary, der Helper linkt auf `@loader_path/libSDL2-2.0.0.dylib`.
- **Fail-Fast Check:** `scripts/verify-release-artifacts.sh` muss fehlschlagen, wenn `display-helper` noch absolute SDL2-Pfade (`/opt/homebrew`, `/usr/local`, `SDL2.framework`) enthält oder `minos > 13.0` ist.
- **SDL2-Runtime-Floor:** `SDL2_STRICT_MINOS=1` blockiert Release-Builds, wenn die verwendete SDL2-Runtime selbst nicht Ventura-kompatibel ist. In diesem Fall muss eine kompatible Runtime via `SDL2_DYLIB_PATH` bereitgestellt oder auf einem passenden Builder gebaut werden.
- **Signing:** Bei gesetztem `APPLE_SIGNING_IDENTITY` werden Runtime-Dylib und Binary automatisch mit `codesign` signiert (für Notarization).
- **Kein separater Release nötig** – das Binary landet in der gepackten App.

## Release-Prozess

### Schritt 1: Feature-Branch zu dev mergen

```bash
# Auf Feature-Branch arbeiten und committen
git checkout feature-branch-name
git add .
git commit -m "feat: your feature description"

# Zu dev wechseln und mergen
git checkout dev
git pull origin dev
git merge feature-branch-name
git push origin dev
```

### Schritt 2: dev zu main mergen

```bash
# Zu main wechseln
git checkout main

# Aktuellen Stand von GitHub holen
git pull origin main

# dev Branch mergen
git merge dev

# Änderungen pushen
git push origin main
```

**Alternative:** Pull Request auf GitHub erstellen und über die Web-UI mergen.

### Schritt 3: Version in package.json aktualisieren

```bash
# package.json öffnen und Version aktualisieren
# z.B. von "0.0.0" zu "0.1.0"

# Änderung committen (falls noch nicht geschehen)
git add package.json
git commit -m "chore: bump version to 0.1.0"
git push origin main
```

### Schritt 4: Tag erstellen und pushen

**WICHTIG:** Der Tag muss auf dem aktuellen `main` Branch erstellt werden, damit der GitHub Actions Workflow ausgeführt wird.

```bash
# Sicherstellen, dass du auf main bist
git checkout main

# Aktuellen Stand holen
git pull origin main

# Tag erstellen
git tag -a v0.7.0 -m "Release version 0.7.0"

# Tag zu GitHub pushen
git push origin v0.7.0
```

### Schritt 4a: Optionaler Produktions-Test per RC-Tag

Wenn du einen echten, signierten und downloadbaren Testbuild brauchst, aber noch kein Update für aktive Nutzer auslösen willst:

```bash
git checkout main
git pull origin main
git tag -a v0.7.0-rc.1 -m "RC version 0.7.0-rc.1"
git push origin v0.7.0-rc.1
```

Ergebnis:

- GitHub erstellt ein `prerelease`
- die App läuft auf dem Updater-Kanal `rc`
- produktive Installationen auf `latest` bleiben unberührt
- nach erfolgreichem Live-Test veröffentlichst du separat `v0.7.0`

### Schritt 5: GitHub Actions Workflow prüfen

1. Gehe zu deinem GitHub Repository
2. Klicke auf den Tab **"Actions"**
3. Du solltest einen laufenden Workflow **"Release Build"** sehen
4. Die Builds für alle Plattformen laufen parallel:
   - macOS ARM64 (Apple Silicon)
   - macOS x64 (Intel)
   - Windows x64
   - Linux x64

### Schritt 6: Release verifizieren

Nach Abschluss der Builds (ca. 10-20 Minuten):

1. Gehe zu **"Releases"** im Repository
2. Es sollte ein Release **"v0.1.0"** mit allen Download-Links geben
3. Prüfe, ob alle Plattformen erfolgreich gebaut wurden:
   - `broadify-bridge-0.1.0-arm64.dmg` (macOS Apple Silicon)
   - `Broadify-Bridge-0.1.0-arm64.zip` (macOS Updater-Paket)
   - `Broadify-Bridge-Setup-0.1.0.exe` (Windows NSIS Installer, primär für Auto-Update)
   - `broadify-bridge-0.1.0-win-x64.msi` (Windows MSI)
   - `broadify-bridge-0.1.0-x64.AppImage` (Linux)

Für RC-Releases zusätzlich prüfen:

- Release ist in GitHub als `Pre-release` markiert
- die installierte App zeigt im Updater-Dialog den Kanal `rc`
- produktive Geräte auf `latest` sehen kein neues Update

## Häufige Probleme und Lösungen

### Problem: Tag wurde auf falschem Commit erstellt

**Symptom:** GitHub Actions zeigt keine Workflow-Runs.

**Lösung:** Tag löschen und neu erstellen:

```bash
# Tag lokal löschen
git tag -d v0.1.0

# Tag auf GitHub löschen (falls vorhanden)
git push origin :refs/tags/v0.1.0

# Zu main wechseln und aktuell sein
git checkout main
git pull origin main

# Tag neu erstellen
git tag -a v0.10.0 -m "Version update 0.10.0"

# Tag pushen
git push origin v0.10.0
```

### Problem: Workflow-File fehlt auf main

**Symptom:** Workflow wird nicht ausgeführt.

**Lösung:** Workflow-File zu main bringen:

```bash
# Workflow-File von dev/feature-branch holen
git checkout dev
git checkout dev -- .github/workflows/release.yml

# Zu main wechseln
git checkout main
git add .github/workflows/release.yml
git commit -m "chore: add release workflow"
git push origin main
```

### Problem: Tag existiert bereits auf GitHub

**Lösung:** Tag mit Force-Push überschreiben:

```bash
# Tag lokal löschen
git tag -d v0.1.0

# Tag auf aktuellen Commit neu erstellen
git checkout main
git tag -a v0.1.0 -m "Release version 0.1.0"

# Force-push des Tags
git push origin v0.1.0 --force
```

## Schnellreferenz - Kompletter Release-Prozess

```bash
# 1. Feature-Branch zu dev mergen
git checkout dev
git pull origin dev
git merge feature-branch-name
git push origin dev

# 2. dev zu main mergen
git checkout main
git pull origin main
git merge dev
git push origin main

# 3. Version in package.json aktualisieren (manuell)
# package.json: "version": "0.1.0"

# 4. Version-Update committen (falls nötig)
git add package.json
git commit -m "chore: bump version to 0.1.0"
git push origin main

# 5. Tag erstellen und pushen
git checkout main
git pull origin main
git tag -a v0.1.0 -m "Release version 0.1.0"
git push origin v0.1.0

# 6. GitHub Actions prüfen
# → Repository → Actions → "Release Build" sollte laufen

# 7. Release verifizieren (nach 10-20 Minuten)
# → Repository → Releases → v0.1.0 sollte mit allen Downloads vorhanden sein
```

## Versionierung

### Semantic Versioning

- **Major** (z.B. `1.0.0`): Breaking Changes
- **Minor** (z.B. `0.1.0`): Neue Features, rückwärtskompatibel
- **Patch** (z.B. `0.0.1`): Bugfixes, rückwärtskompatibel

### Git Tags Format

Tags müssen dem Format `v{VERSION}` entsprechen:

- `v1.0.0` für Major Release
- `v0.1.0` für Minor Release
- `v0.0.1` für Patch Release

## Checkliste vor Release

- [ ] Alle Features sind auf `dev` gemerged
- [ ] Tests laufen erfolgreich
- [ ] Version in `package.json` ist aktualisiert
- [ ] CHANGELOG.md ist aktualisiert (optional)
- [ ] Workflow-File (`.github/workflows/release.yml`) ist auf `main`
- [ ] `main` Branch ist aktuell (`git pull origin main`)
- [ ] Tag wird auf `main` erstellt (nicht auf Feature-Branch)
- [ ] GitHub Secrets gesetzt: DeckLink URLs/Hashes, ggf. `APPLE_SIGNING_IDENTITY`, `BRIDGE_RELAY_JWKS_URL`

## Nach dem Release

1. **Web-App Integration:** Download-Links sind über GitHub Releases API verfügbar
2. **Monitoring:** Prüfe GitHub Actions Logs auf Fehler
3. **Testing:** Teste Downloads für alle Plattformen
4. **Dokumentation:** Aktualisiere Release Notes falls nötig

## Weitere Informationen

- [RELEASES.md](./RELEASES.md) - Detaillierte Release-Dokumentation
- [WEB_APP_INTEGRATION.md](./WEB_APP_INTEGRATION.md) - Integration in Web-App
