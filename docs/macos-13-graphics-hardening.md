# macOS 13 Graphics Hardening

Ziel: macOS-Release-Artefakte so absichern, dass der native `display-helper` auf Ventura nicht mehr an lokaler Homebrew-SDL2 oder zu hohen `minos`-Werten scheitert.

## Phase 1: Support-Floor festziehen

- [x] `13.0` als macOS-Floor fuer den `display-helper` definiert.
- [x] `13.0` als macOS-Floor fuer den `decklink-helper` definiert.
- [x] Release-Workflow auf feste Floor-Variablen verdrahtet.

## Phase 2: Portable SDL2-Runtime fuer macOS

- [x] `display-helper` baut jetzt mit gebuendelter `libSDL2-2.0.0.dylib`.
- [x] Der Loader-Pfad wird auf `@loader_path/libSDL2-2.0.0.dylib` umgeschrieben.
- [x] Build-Skript akzeptiert `SDL2_DYLIB_PATH`, `SDL2_CFLAGS` und `SDL2_LIBS`.
- [x] Build-Skript prueft die `minos` der verwendeten SDL2-Runtime.
- [x] Build-Skript kann bei `SDL2_STRICT_MINOS=1` auf inkompatibler SDL2 hart fehlschlagen.

## Phase 3: Packaging und Signierung

- [x] macOS-Packaging nimmt `libSDL2-2.0.0.dylib` in `extraResources` auf.
- [x] Signierung deckt Runtime-Dylib und `display-helper` ab.
- [x] Runtime-Diagnostics und Release-Logs melden die SDL2-Runtime explizit.

## Phase 4: Fail-Fast-Checks vor dem Release

- [x] Release-Verify prueft, dass `libSDL2-2.0.0.dylib` vorhanden ist.
- [x] Release-Verify blockiert absolute SDL2-Pfade wie `/opt/homebrew` oder `SDL2.framework`.
- [x] Release-Verify prueft `minos` fuer `display-helper`, SDL2-Runtime und `decklink-helper`.
- [x] DeckLink-Check blockiert zu neue Helper-Binaries bereits vor dem Packaging.

## Phase 5: Operative Release-Voraussetzungen

- [ ] Eine Ventura-kompatible SDL2-Runtime fuer CI bereitstellen.
- [ ] Entweder auf einem macOS-13-Build-Host bauen oder `SDL2_DYLIB_PATH` auf eine SDL2-Runtime mit `minos <= 13.0` setzen.
- [ ] Nach Bereitstellung der kompatiblen SDL2-Runtime einen kompletten `dist:mac:*` Build durchlaufen lassen.
- [ ] Final auf einem sauberen Ventura-System ohne Homebrew-SDL2 testen.

## Hinweise

- Homebrew-SDL2 von neueren macOS-Versionen kann selbst bereits `minos 15+` tragen. Dann ist das Bundle zwar portabel, aber nicht Ventura-kompatibel.
- Der neue Verify-Pfad blockiert solche Builds jetzt bewusst, statt ein scheinbar funktionierendes, aber beim Kunden brechendes Release zu erzeugen.
- `decklink-helper` bleibt auf `DeckLinkAPI.framework` angewiesen. Das muss auf Zielsystemen mit DeckLink-Nutzung weiterhin durch Blackmagic Desktop Video bereitgestellt werden.
