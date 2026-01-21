# Graphics Umsetzungsplan (Messbar)

## Scope

- Fokus: Graphics Pipeline (Renderer -> Composite -> DeckLink Helper Output).
- Ziele: klarer Datenfluss, SDK-konforme Format/Colorspace-Logik, konfigurierbare Range.

## Plan

### 1) Redundanter Frame-Transport entfernen

- [x] Transport-Entscheidung treffen (TCP IPC **oder** process IPC als Single Source).
  - Verify: Entscheidung dokumentiert in `docs/debug/graphics-umsetzungsplan.md`.
  - Entscheidung: TCP IPC.

- [x] Nicht genutzten Transportpfad entfernen (Code + Logs).
  - Betroffene Files: 
    - `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
    - `apps/bridge/src/services/graphics/renderer/electron-renderer-client.ts`
  - Verify: `rg -n "process.send|child.on\("message"\)"` zeigt nur noch den gewaehlten Pfad.

- [x] IPC-Sicherheit dokumentieren und Token-Handshake implementieren.
  - Security Risiko: lokaler IPC ohne Auth kann Frames injizieren, wenn lokaler Zugriff kompromittiert ist.
  - Mitigation: Token-Handshake ueber ENV + Header-Feld in IPC.
  - Verify: Security-Abschnitt aktualisiert in `docs/graphics/graphics-dataflows.md`.

### 2) Format-Validierung (Placeholder ersetzen)

- [x] Display-Modes ueber DeckLink Helper lesen und format/fps validieren.
  - Betroffene Files:
    - `apps/bridge/src/services/graphics/graphics-manager.ts`
    - `apps/bridge/src/modules/decklink/decklink-helper.ts`
  - Verify: `graphics_configure_outputs` returnt Fehler bei nicht unterstuetztem Format.

### 3) Colorspace-Fallback

- [x] Fallback definieren, wenn DisplayMode keine Colorspace-Flags liefert.
  - Vorschlag: Rec709 fuer HD, Rec601 fuer SD (klar dokumentieren).
  - Betroffene Files:
    - `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`
  - Verify: Helper startet nicht mehr mit "Colorspace flags not provided" bei validen Modes.

### 4) Pixel-Format-Policy als Single Source of Truth

- [x] Pixel-Format-Policy zentral definieren (Video vs. Key/Fill) und in Adapter + Helper spiegeln.
  - Betroffene Files:
    - `apps/bridge/src/services/graphics/output-adapters/decklink-video-output-adapter.ts`
    - `apps/bridge/src/services/graphics/output-adapters/decklink-key-fill-output-adapter.ts`
    - `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`
  - Verify: Policy in einer Datei dokumentiert + Adapter nutzen dieselbe Reihenfolge.

### 5) Legal-Range-Mapping konfigurierbar machen

- [x] Range-Option (Full vs. Legal) in Config aufnehmen und an Helper uebergeben.
  - Betroffene Files:
    - `apps/bridge/native/decklink-helper/src/decklink-helper.cpp`
    - `apps/bridge/src/services/graphics/graphics-schemas.ts`
    - `apps/bridge/src/services/graphics/output-config-store.ts`
  - Verify: Konfig aendert sichtbare Ausgabe-Level (Testpattern/Scope).

### 6) Datenfluss-Transparenz sicherstellen

- [x] Doku + Logging so anpassen, dass Datenfluss eindeutig ist.
  - Betroffene Files:
    - `docs/graphics/graphics-dataflows.md`
    - `docs/graphics/bridge-production-dataflow.md`
  - Verify: Doku benennt exakt den aktiven Frame-Transportpfad und Pixel-Format-Policy.
