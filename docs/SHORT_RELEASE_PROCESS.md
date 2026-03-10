# Short Release Process

## DeckLink Helper

```bash
npm run prepare:decklink-helper-release
```

## SDL2 macOS Bundle

```bash
npm run prepare:sdl2-macos-release
```

Oder in GitHub Actions:

- `Build SDL2 macOS Asset`
- mit `runner_label=macos-15`

Nicht zwingend:

- Test- und Live-Release bauen SDL2 jetzt automatisch selbst, falls keine SDL2-Secrets gesetzt sind.

## RC / Test Release

Benötigte GitHub-Secrets:

- `RELAY_URL_RC`
- `BRIDGE_RELAY_JWKS_URL_RC`

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
