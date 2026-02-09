# Graphics Realtime Refactor – Ziele & Constraints

## Unverhandelbare Ziele
- Realtime Triggering und Rendering.
- Flüssige Animationen mit 50 fps.
- Sehr geringe Latenz zwischen Trigger und sichtbarem Frame.

## Wichtige Constraints
- Pro Session ist immer nur ein Output aktiv.
- Output-Format wird über `graphics_configure_outputs` vorgegeben.
- DeckLink-Formate müssen gegen Display-Modes validiert werden.
- Display-Outputs dürfen keine Frames über TCP-IPC erhalten.
- Plattform-Status: macOS only (Windows/Linux deferred).

## Nicht-Ziele
- Multi-Output parallel in einer Session.
- NDI-Output (aktuell Stub).
- Cloud-Rendering.

## Akzeptanzkriterien
- End-to-End 50 fps stabil bei 1080p.
- Keine sichtbaren Frame-Sprünge bei Standard-Animationen.
- Keine IPC-Backpressure im Frame-Transport.

## TODO
- [ ] Akzeptanzkriterien finalisieren pro Output-Key.
- [ ] Minimale, reproduzierbare Test-Templates definieren.
