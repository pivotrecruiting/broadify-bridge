# Meeting Keyer Code Audit

Datum: 2026-06-14

## Umfang

Analysiert wurden `KEYING-AGENT.md`, `docs/bridge/architecture/meeting-keyer-rendering-dataflow.md` und die aktuellen Codepfade fuer Capture, Keying, Alpha-Postprocessing, Compositing, Bridge-Control und Meeting-Graphics-FrameBus.

Wichtige Dateien:

- `apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp`
- `apps/bridge/native/meeting-helper/src/compose/compositor.cpp`
- `apps/bridge/native/meeting-helper/src/keyer/vision_keyer.mm`
- `apps/bridge/native/meeting-helper/src/keyer/modnet_keyer.cpp`
- `apps/bridge/native/meeting-helper/src/capture/camera_avfoundation.mm`
- `apps/bridge/native/meeting-helper/src/control/control_server.cpp`
- `apps/bridge/src/services/meeting/meeting-command-handler.ts`
- `apps/bridge/src/services/meeting/meeting-command-schemas.ts`

## Executive Summary

Die wichtigste P0-Korrektur ist erledigt: Die Pipeline nutzt Frame-Pairing.
Der async Keyer publiziert RGB-Frame und Alpha-Maske als Paar aus demselben
Capture-Frame. Der Program-Loop wendet die Maske nicht mehr auf den aktuellen
Kamera-RGB-Frame an, sondern auf das gepaarte RGB-Frame. Dadurch ist der
sichtbare Transparenz-Nachlaeufer entfernt.

Der neue Tradeoff ist die erwartbare Latenz des gesamten keyed Kameralayers:
Das freigestellte Kamerabild kann um `mask_age_ms` hinter der aktuellen Kamera
liegen. Apple Vision `balanced` bleibt aktuell die beste Qualitaetsbasis;
`fast` senkt zwar Latenz, verschlechtert aber die sichtbare Kante zu stark.

Das fehlgeschlagene Edge-Softening/Background-Blur-Degradation-Experiment ist
nicht Teil der aktuellen Richtung. Behalten werden Statusfelder,
`temporal_blend_enabled`, `max_mask_age_ms` Safety-Fallback, strikte
Bridge-Validation und die WebApp-Statusbar-Metriken fuer reproduzierbare Tests.

## Bewertung Nach Prioritaet

| Bereich | Bewertung | Launch-Relevanz |
| --- | --- | --- |
| Korrektheit bei Bewegung | Deutlich verbessert | Frame-Pairing erledigt; Motion-Lag jetzt als ganze Kamera-Layer-Latenz |
| Latenz und Sync | Hoch | Sync geloest, Latenz muss ueber Keyer-/Capture-Kosten reduziert werden |
| Alpha-/Compositing-Semantik | Hoch | Muss dokumentiert oder korrigiert werden |
| Performance | Mittel bis hoch | CPU-Kopien koennen Sync verschlechtern |
| Kantenqualitaet | Mittel | Nach Sync-Fix optimieren |
| Bridge-Validation/Controls | Erledigt fuer P0 | Schema ist strikt und WebApp-kompatibel |
| Beobachtbarkeit | Erledigt fuer P1-Messung | Statusbar zeigt native Keyer-Metriken live an |

## Identifizierte Probleme Und Loesungen

### 1. Maske und RGB-Frame sind nicht synchron

**Status:** Erledigt fuer P0.

**Vorheriges Symptom:** Bei Kopf-, Hand- oder Schulterbewegungen hinkte die
Silhouette hinterher. Koerperteile wurden kurz abgeschnitten oder der alte
Umriss blieb als Halo sichtbar.

**Aktueller Stand:** `AsyncKeyerWorker` publiziert ein gepaartes Kamera-Frame
mit Maske. Der Program-Loop nutzt dieses Paar fuer Hard-Keying und faellt bei
`mask_age_ms > max_mask_age_ms` auf Passthrough zurueck.

**Verbleibender Tradeoff:** Alpha-Kante und RGB sind synchron, aber das gesamte
keyed Kameralayer kann um `mask_age_ms` verzoegert sein. Die naechste Arbeit
muss diese Latenz messbar reduzieren.

**Verifikation:**

- Testsequenz mit schneller Handbewegung und Schulterdrehung aufnehmen.
- `mask_age_ms`, `session_run_ms`, `dropped_frames`, `program_frame_ms` parallel loggen.
- Akzeptanz: Keine Alpha-Nachlaeufer; verbleibender Lag ist als ganzes
  Kameralayer sichtbar und anhand der Metriken quantifizierbar.

### 2. Temporal Alpha Blending kann Motion-Trails verstaerken

**Symptom fuer Nutzer:** Die Kante wirkt zwar ruhiger, aber alte Koerperkonturen bleiben nahe am aktuellen Umriss stehen. Haare/Schultern koennen "schmieren".

**Technische Ursache:** `blendAlphaTemporal` mischt vorherige Alpha-Werte in einer geschuetzten Zone mit bis zu `0.85` Previous-Weight, solange `maskAgeMs < 140 ms` (`apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:189`). Die Schutzmaske wird um die aktuelle Alpha-Zone dilatiert (`kTemporalProtectionRadiusPx = 10`, `apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:26`). Bei Motion ist das eine Stabilisierung ohne Bewegungsmodell.

**Fix-Richtung:**

- Sofort messbar machen: Toggle fuer Temporal Blend in `keyer.configure`, damit A/B gegen reine Maske moeglich ist.
- Previous-Weight dynamisch an Frame-Differenz oder Mask-Age koppeln, nicht nur an Alpha-Differenz.
- Bei hoher Motion oder hoher Mask-Age Previous-Weight deutlich reduzieren oder Blending deaktivieren.
- Erst nach Sync-Gating Kanten-Feather/Dilate feintunen.

**Verifikation:**

- A/B-Run mit Temporal Blend an/aus.
- Messung: `mask_age_ms`, subjektive Trail-Laenge in Testclip, Dropped Frames.
- Akzeptanz: Stabilisierung darf Flackern reduzieren, aber keine laengeren sichtbaren Nachzieher erzeugen als ohne Blending.

### 3. Stale Masks werden ohne harte Altersgrenze verwendet

**Status:** Erledigt fuer P0.

**Aktueller Stand:** `max_mask_age_ms` ist als native Setting und
Bridge-Payload verfuegbar. Wenn das gepaarte Keyer-Frame zu alt ist, nutzt der
Program-Loop Passthrough statt Hard-Keying. `stale_mask_active` und
`degradation_stage` melden den Zustand.

**Wichtig:** Edge-Softening/Background-Blur wurde nicht weiter verfolgt, weil
dieser Ansatz Flimmern und Gesamtbild-Pumpen erzeugt hat.

**Verifikation:**

- Inferenz kuenstlich verzoegern und pruefen, dass `degradation_stage` auf
  `passthrough` geht.
- In Motion-Tests sicherstellen, dass keine alte Maske auf aktuelles RGB gelegt
  wird.

### 4. `transparent` Background ist im Program-Output opak schwarz

**Symptom fuer Nutzer:** Ein als transparent konfigurierter Output enthaelt schwarzen Hintergrund. Downstream-Systeme, die Alpha erwarten, bekommen kein transparentes Key/Fill-Signal.

**Technische Ursache:** `fillBackground` initialisiert den gesamten Frame mit `255` und `setPixel` schreibt standardmaessig Alpha `255`. Im `transparent` Branch werden nur RGB-Werte auf Schwarz gesetzt, Alpha bleibt `255` (`apps/bridge/native/meeting-helper/src/compose/compositor.cpp:78`). `blendPixel` erzwingt ebenfalls `dst.a = 255` (`apps/bridge/native/meeting-helper/src/compose/compositor.cpp:43`).

**Fix-Richtung:**

- Produktentscheidung treffen: Program-Output ist entweder immer fertig composited und opak, oder es gibt einen separaten Alpha-erhaltenden Output-Modus.
- Wenn opak gewollt: `transparent` im Meeting-Program-Kontext umbenennen oder in API/Doku als `black`/`program_transparent_graphics_input` klarstellen.
- Wenn echter Alpha-Output gewollt: Compositor muss destination alpha korrekt akkumulieren, `fillBackground` bei transparent mit Alpha `0` starten und Layer-Blend muss Alpha erhalten.

**Verifikation:**

- FrameBus-Test, der bei transparentem Background Alpha-Werte des Program-Frames prueft.
- Screenshot/Frame-Dump mit und ohne Graphics-Layer.

### 5. Layering trennt Behind- und Front-Graphics nicht semantisch

**Symptom fuer Nutzer:** Grafiken koennen nur als ein bereits gerenderter RGBA-Frame hinter der Kamera liegen, waehrend native Placeholder-Graphics spaeter ueber der Kamera liegen. Eine klare Semantik "Background -> Behind Graphics -> Person -> Front Overlays" ist nur teilweise vorhanden.

**Technische Ursache:** `drawGraphicsFrame` wird vor `drawCamera` gerendert, `drawGraphics` und `drawCornerbug` danach (`apps/bridge/native/meeting-helper/src/compose/compositor.cpp:266`). Meeting Builder Graphics kommen aber als ein gemeinsames FrameBus-Bild `bfy-meet-gfx`; der C++ Compositor kennt keine einzelnen Meeting-Layer mit eigener Front/Behind-Zuordnung (`apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:431`).

**Fix-Richtung:**

- Kurzfristig klar dokumentieren: Meeting-Graphics-FrameBus ist Behind-Person-Layer; native placeholders sind Front-Layer.
- Mittelfristig zwei Graphics-FrameBus-Inputs: `behind` und `front`, oder ein gerenderter Frame mit Layer-Split/Channel-Metadaten.
- Keine Wiederbelebung alter Multi-Window/Bridge-Compositing-Pfade; innerhalb des Single-Renderer/FrameBus-Prinzips bleiben.

**Verifikation:**

- Testscene mit farbiger Flaeche hinter Person und Lower Third vor Person.
- Pixeltest: Behind-Layer darf durch Person-Alpha verdeckt werden, Front-Layer muss ueber Person liegen.

### 6. Alpha-Formatannahmen sind nicht explizit abgesichert

**Symptom fuer Nutzer:** Dunkle/helle Saeume an halbtransparenten Grafiken oder Personenkanten, wenn Upstream premultiplied alpha liefert.

**Technische Ursache:** `blendPixel` nutzt Straight-Alpha-Math (`src.rgb * src.a + dst.rgb * (1-src.a)`) und setzt Zielalpha auf 255 (`apps/bridge/native/meeting-helper/src/compose/compositor.cpp:43`). Es gibt keinen Guard, keine Conversion und keine Metadaten, die Straight vs. Premultiplied Alpha pruefen.

**Fix-Richtung:**

- FrameBus-Kontrakt explizit auf straight RGBA8 festlegen und in Renderer-Output validieren.
- Optional Diagnose: bekannte Testpatterns fuer premultiplied/straight alpha ueber FrameBus schicken.
- Falls Renderer premultiplied liefert: vor Compositing unpremultiply oder Compositor auf premultiplied pipeline umstellen.

**Verifikation:**

- Golden-Pixel-Test mit 50%-Rot ueber Schwarz/Weiss.
- Vergleich erwarteter RGB-Werte fuer Straight-Alpha.

### 7. Kamera-Capture verursacht CPU-Kopien und nutzt Helper-Wallclock statt Sample-Timestamp

**Symptom fuer Nutzer:** Hoehere Baseline-Latenz und instabilere Age-Metrik. Unter Last kann die Pipeline schneller in Stale-Mask-Situationen laufen.

**Technische Ursache:** AVFoundation liefert BGRA, danach kopiert `handleSampleBuffer` jeden Frame in einen neuen RGBA-Vector und setzt `timestampNs = nowNs()` (`apps/bridge/native/meeting-helper/src/capture/camera_avfoundation.mm:218`). Die Capture-Session nutzt `AVCaptureSessionPresetHigh` statt expliziter Format-/FPS-Konfiguration (`apps/bridge/native/meeting-helper/src/capture/camera_avfoundation.mm:111`).

**Fix-Richtung:**

- Kurzfristig `camera_copy_ms` ernsthaft auswerten und gegen Aufloesung/FPS loggen.
- Sample presentation timestamp (`CMSampleBufferGetPresentationTimeStamp`) zusaetzlich speichern, helper-local monotonic timestamp aber fuer lokale Age-Messung behalten.
- Mittelfristig BGRA intern akzeptieren oder Conversion in GPU/Metal verschieben.
- Kameraformat explizit passend zu `options.width/height/fps` waehlen oder zumindest die reale Capture-Aufloesung im Status sichtbar machen.

**Verifikation:**

- Metrikvergleich 720p/1080p, 30/60 fps.
- Akzeptanz: Capture-Copy darf nicht signifikant zum Mask-Age beitragen; reale Kamera-FPS muss nachvollziehbar sein.

### 8. Vision/MODNet haben doppelte und inkonsistente Mask-Sampling-Pfade

**Symptom fuer Nutzer:** Kanten koennen je nach internem Debug-/Fallback-Pfad anders aussehen als im echten async Program-Pfad.

**Technische Ursache:** Vision `applyMaskToFrame` nutzt nearest-neighbor (`apps/bridge/native/meeting-helper/src/keyer/vision_keyer.mm:71`), MODNet `applyAlphaMask` ebenfalls (`apps/bridge/native/meeting-helper/src/keyer/modnet_keyer.cpp:249`). Der sichtbare async Program-Pfad nutzt dagegen bilineares Sampling in `applyLatestAlphaToCurrentFrame` (`apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:250`). Der keyed RGBA-Frame aus `KeyerResult` wird im normalen Program-Loop praktisch nicht benutzt.

**Fix-Richtung:**

- KeyerResult-Frame-Anwendung entfernen oder klar als Debug-Artefakt markieren.
- Eine gemeinsame Mask-Sampling-Utility verwenden.
- Falls KeyerResult.frame gebraucht wird: ebenfalls bilinear und identisch zum Program-Pfad anwenden.

**Verifikation:**

- Unit-Test fuer gleiche Alpha-Werte bei identischer Maske und Skalierung.
- Debug-Preview darf nicht andere Kanten zeigen als Program-Output.

### 9. Bridge-Keyer-Payload ist zu breit validiert

**Symptom fuer Nutzer/Admin:** Remote Commands koennen beliebige Felder durchreichen. Native Seite clamped einiges, aber Modellnamen, Background Modes und unbekannte Felder sind nicht streng typisiert. Fehler werden dadurch spaeter und uneinheitlicher sichtbar.

**Technische Ursache:** `meeting_keyer_configure` nutzt `MeetingPassthroughSchema = z.record(z.unknown())` (`apps/bridge/src/services/meeting/meeting-command-handler.ts:166`, `apps/bridge/src/services/meeting/meeting-command-schemas.ts:18`). Native `keyer.configure` liest Felder per String-Extractor und akzeptiert unbekannte Werte teilweise implizit (`apps/bridge/native/meeting-helper/src/control/control_server.cpp:198`).

**Fix-Richtung:**

- Eigenes `MeetingKeyerConfigureSchema` einfuehren:
  - `enabled?: boolean`
  - `model?: "modnet" | "vision_person_segmentation"`
  - `background_mode?: "transparent" | "gradient" | "solid_light" | "checkerboard"` oder Produkt-Enum
  - `quality_mode?: "fast" | "balanced" | "accurate"`
  - `mask_dilate_px?: int 0..8`
  - `mask_feather_px?: int 0..3`
  - `dynamic_dilation?: boolean`
- Native Seite weiterhin defensiv lassen, aber Bridge soll ungueltige Remote-Payloads frueh ablehnen.

**Verifikation:**

- Jest-Tests fuer gueltige/ungueltige `meeting_keyer_configure` Payloads.
- Native Integrationstest fuer unsupported model.

### 10. Preview-Encoding-Metrik wird nicht aktualisiert

**Symptom fuer Entwickler:** `mjpeg_encode_ms` existiert im Status, bleibt aber ohne Aussage, wenn Preview-Kosten den Program-Loop beeinflussen.

**Technische Ursache:** `runFramePipeline` ruft `previewFrames.publish(...)` auf, misst aber nur `programFrameMs` und `cameraCopyMs` im Loop (`apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:605`). `mjpeg_encode_ms` wird in diesem Pfad nicht gesetzt.

**Fix-Richtung:**

- Preview publish/encode separat messen.
- Wenn MJPEG-Encoding in anderem Thread passiert, Queue-Lag und encode p95 messen.
- Preview niemals Program-Frame-Takt blockieren lassen.

**Verifikation:**

- Status muss bei aktiver Preview plausible `mjpeg_encode_ms` oder explizit `null` mit Grund liefern.
- Lasttest mit Preview an/aus.

## Umsetzungsplan

### Phase 0: Stabiler Motion-Keyer

- [x] Frame-Pairing einfuehren, damit Maske und RGB aus demselben
  Capture-Frame stammen.
- [x] `max_mask_age_ms` als harten Safety-Fallback zu Passthrough nutzen.
- [x] `degradation_stage` und `stale_mask_active` im Keyer-Status melden.
- [x] Temporal Blend per Config toggelbar machen.
- [x] `transparent` Program-Semantik als opaken Program-Output dokumentieren.
- [x] Bridge-Schema fuer `meeting_keyer_configure` streng typisieren und
  WebApp-kompatibel halten.
- [x] Fehlgeschlagene Blur-/Edge-Degradation nicht weiter verfolgen.

### Phase 1: Messbarkeit Und Debug-Statusbar

- [x] Native Keyer-Metriken ueber `keyer.get` ausgeben:
  `camera_copy_ms`, `tensor_ms`, `session_run_ms`, `mask_apply_ms`,
  `mask_dilate_ms`, `mask_postprocess_ms`, `mask_age_ms`,
  `program_frame_ms`, `mjpeg_encode_ms`, `mask_width`, `mask_height`,
  `dropped_frames`.
- [x] Native Rate-/Stabilitaetsmetriken ausgeben:
  `mask_age_avg_ms`, `keyer_fps`, `program_fps`,
  `dropped_frames_per_sec`.
- [x] WebApp-Statusbar um alle vorhandenen Keyer-Metriken erweitern.
- [x] WebApp-Statusbar um `Keyer FPS`, `Program FPS`, `Drop/s` und
  `Maske avg` erweitern.
- [x] WebApp-Preview-Panel pollt `meeting_keyer_get` waehrend der laufenden
  Preview, damit die Werte live lesbar sind.
- [ ] Motion-Test-Notizen mit typischen `balanced`-Werten dokumentieren:
  ruhige Pose, schnelle Handbewegung, Kopfbewegung, Schulterdrehung.

### Phase 2: Latenz Reduzieren Ohne Qualitaetsverlust

- [ ] `balanced` als Default beibehalten; `fast` nur als A/B-Diagnose nutzen,
  weil die sichtbare Kante schlechter ist.
- [x] Program-Loop Frame-Pacing korrigieren: Renderzeit wird von der
  Ziel-Frame-Zeit abgezogen statt zusaetzlich zu einem festen Sleep addiert.
- [ ] `camera_copy_ms` gegen Aufloesung/FPS messen und unnoetige Kopien oder
  Reallocations entfernen.
- [ ] Vision-Input-Erzeugung analysieren: RGBA/CGImage-CPU-Pfad gegen
  CVPixelBuffer/CoreVideo/Metal-Optionen bewerten.
- [ ] `session_run_ms` und `tensor_ms` getrennt auswerten, damit Vision-Kosten
  nicht mit Vor-/Nachverarbeitung verwechselt werden.
- [ ] Temporal Blend A/B testen: `balanced + on` gegen `balanced + off`.

### Phase 3: Kantenqualitaet Und Alpha-Kontrakt

- [ ] Minimalistische Mask-Postprocessing-Tests: kleine Dilate-/Feather-Werte,
  keine altersabhaengige Blur-/Edge-Degradation.
- [ ] Gemeinsame Mask-Sampling-Utility fuer Vision, MODNet und Program-Pfad.
- [ ] Straight-Alpha-Kontrakt per Tests absichern.
- [ ] Produktentscheidung fuer echten Alpha-Output vs. immer opaker
  Program-Output treffen.

### Phase 4: Architekturhaertung

- [ ] Zwei Graphics-Layer-Pfade fuer Behind/Front definieren, falls Meeting
  Builder beide Ebenen semantisch braucht.
- [ ] GPU-Compositing statt CPU-Pixel-Loops evaluieren.
- [ ] Motion Compensation / Optical Flow fuer Maske zwischen Inferenzframes nur
  dann einplanen, wenn Phase 2 den sichtbaren Lag nicht ausreichend senkt.
- [ ] Automatisierte Video-Golden-Tests fuer Handbewegung, Haare, Brille und
  Schulterbewegung aufbauen.

## Fazit

Die bestehende Architektur ist nicht "falsch" gebaut: Worker-Entkopplung, Single Program-Loop und FrameBus-Output sind die richtigen Leitplanken. Der groesste Motion-Fehler war das Anwenden alter Masken auf aktuelle RGB-Frames; dieser Fehler ist durch Frame-Pairing behoben.

Der neue limitierende Faktor ist Latenz des gesamten keyed Kameralayers. Der pragmatische naechste Schritt ist kein neuer Degradation-Modus, sondern Latenzreduktion auf der bestehenden `balanced`-Basis: Metriken live auslesen, Capture-/Copy-Kosten senken, Vision-Input-Pfad optimieren und erst danach feines Mask-Postprocessing bewerten.
