# Short Release Process

## DeckLink Helper

```bash
npm run prepare:decklink-helper-release
```

## RC / Test Release

### Bugfix

```bash
npm run release:test -- --bugfix
```

### Feature

```bash
npm run release:test -- --feature
```

## Live Release

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
