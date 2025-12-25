# Release Process - Schritt für Schritt Anleitung

## Übersicht

Diese Anleitung beschreibt den kompletten Prozess für das Erstellen und Veröffentlichen eines Releases der Broadify Bridge Desktop App.

## Voraussetzungen

- Git Repository mit `main`, `dev` und Feature-Branches
- GitHub Actions Workflow (`.github/workflows/release.yml`) muss auf `main` vorhanden sein
- Version in `package.json` sollte aktualisiert sein

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
git tag -a v0.1.0 -m "Release version 0.1.0"

# Tag zu GitHub pushen
git push origin v0.1.0
```

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
   - `broadify-bridge-0.1.0-x64.dmg` (macOS Intel)
   - `broadify-bridge-0.1.0-win-x64.exe` (Windows Portable)
   - `broadify-bridge-0.1.0-win-x64.msi` (Windows Installer)
   - `broadify-bridge-0.1.0-x64.AppImage` (Linux)

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
git tag -a v0.1.0 -m "Release version 0.1.0"

# Tag pushen
git push origin v0.1.0
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

## Nach dem Release

1. **Web-App Integration:** Download-Links sind über GitHub Releases API verfügbar
2. **Monitoring:** Prüfe GitHub Actions Logs auf Fehler
3. **Testing:** Teste Downloads für alle Plattformen
4. **Dokumentation:** Aktualisiere Release Notes falls nötig

## Weitere Informationen

- [RELEASES.md](./RELEASES.md) - Detaillierte Release-Dokumentation
- [WEB_APP_INTEGRATION.md](./WEB_APP_INTEGRATION.md) - Integration in Web-App

