# Short Release Process

## DeckLink Helper

```bash
npm run prepare:decklink-helper-release
```

## MODNet Model (Windows)

```bash
npm run prepare:modnet-model-release
```

Details: `apps/bridge/native/meeting-helper/models/DEPLOY.md`

Benötigtes GitHub-Secret:

- `MODNET_MODEL_URL` (GitHub Release Asset URL)

## MODNet CoreML Model (macOS)

```bash
npm run prepare:modnet-coreml-model
```

Benötigtes GitHub-Secret:

- `MODNET_COREML_MODEL_URL` (ZIP mit `MODNet.mlpackage`)

## SDL2 macOS Bundle

```bash
npm run prepare:sdl2-macos-release
```

Oder in GitHub Actions:

- `Build SDL2 macOS Asset`
- mit `runner_label=macos-15`

Nicht zwingend:

- Test- und Live-Release bauen SDL2 jetzt automatisch selbst, falls keine SDL2-Secrets gesetzt sind.

## Presentation Runtime (LibreOffice, macOS arm64)

Einmalig oder bei LibreOffice-Versionswechsel:

GitHub Actions:

- `Build Presentation Runtime macOS Asset`
- mit `runner_label=macos-15`

Oder lokal auf Apple Silicon:

```bash
npm run prepare:presentation-runtime-macos-release
```

Details: `apps/bridge/vendor/presentation-runtime/DEPLOY.md`

Benötigte GitHub-Secrets (für schnelle Release-Builds):

- `PRESENTATION_RUNTIME_URL_ARM64`
- `PRESENTATION_RUNTIME_SHA256_ARM64`

Ohne diese Secrets baut CI weiterhin über den langsamen DMG-Fallback.

## RC / Test Release

Benötigte GitHub-Secrets:

- `RELAY_URL_RC`
- `BRIDGE_RELAY_JWKS_URL_RC`

Branch-Regel:

- `release:test` auf `main`, `dev` oder Feature-Branches
- `release:live` nur auf `main`

### Bugfix

```bash
npm run release:test -- --bugfix
```

### Feature

```bash
npm run release:test -- --feature
```

## Live Release

Benötigte GitHub-Secrets:

- `RELAY_URL`
- `BRIDGE_RELAY_JWKS_URL`

### Bugfix

```bash
npm run release:live -- --bugfix
```

### Feature

```bash
npm run release:live -- --feature
```

## RC Continuation / Promotion

### Next RC Tag

```bash
npm run release:test
```

### Promote Current RC to Live Tag

```bash
npm run release:live
```
