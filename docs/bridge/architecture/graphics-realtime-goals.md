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

## Finalisiert
### Akzeptanzkriterien pro Output-Key
- `video_sdi`: 1080p@50: Renderer fps ≥ 50, Drops ≤ 1% über 60s; Output-Helper fps stabil ±1 fps über 60s; Trigger→Frame Latenz < 200ms (Median).
- `video_hdmi`: 1080p@50: Renderer fps ≥ 50, Drops ≤ 1% über 60s; Output-Helper fps stabil ±1 fps über 60s; Trigger→Frame Latenz < 200ms (Median).
- `key_fill_sdi`: 1080p@50: Renderer fps ≥ 50, Drops ≤ 1% über 60s; Helper fps stabil ±1 fps über 60s; Key/Fill Sync ≤ 1 Frame (Output-Beobachtung).
- `key_fill_split_sdi` (Legacy-Pfad): 1080p@50: fps ≥ 50, Drops ≤ 1% über 60s; bleibt bis nativer Split fertig im Legacy-stdin.
- `key_fill_ndi`: Stub/Non-Goal (keine Realtime-Kriterien im Refactor).

### Minimale, reproduzierbare Test-Templates
- `static-card`: 1 Layer, statischer Text + Hintergrund.
- `lower-third-slide`: 1 Layer, Slide-up Animation, 2 Textfelder.
- `ticker-stress`: 2-3 Layer, 10 Hz Text-Updates, 1 PNG Asset.
