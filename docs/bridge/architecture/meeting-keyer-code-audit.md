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

Die aktuelle Meeting-Keyer-Pipeline ist fuer einen ersten End-to-End-Pfad sauber genug entkoppelt: Inferenz laeuft in einem Worker, der Program-Loop blockiert nicht direkt auf Vision/MODNet, FrameBus bleibt die Data-Plane. Das ist die richtige Grundrichtung.

Fuer Meeting-Qualitaet bei Bewegung reicht der aktuelle Stand aber noch nicht. Das Kernproblem ist nicht die statische Maskenqualitaet, sondern Sync: Der sichtbare RGB-Frame kommt aus dem aktuellen Kamera-Snapshot, die Alpha-Maske aus dem zuletzt fertig berechneten Keyer-Frame. Bei Bewegung fuehrt das zu sichtbarem Nachziehen, abgeschnittenen Haenden/Schultern oder Halo-Kanten. Temporal Blending stabilisiert Flackern, kann dieses Nachziehen aber verstaerken.

Zusaetzlich ist `background_mode: "transparent"` im finalen Program-Output faktisch ein opaker schwarzer Hintergrund. Das ist kein Bug, wenn die Virtual Camera ein fertig composited Program-Bild erwartet. Es ist aber irrefuehrend und wird problematisch, falls ein Downstream-Pfad echten Alpha-Output erwartet.

## Bewertung Nach Prioritaet

| Bereich | Bewertung | Launch-Relevanz |
| --- | --- | --- |
| Korrektheit bei Bewegung | Kritisch | Muss vor Launch fuer Keyer-Qualitaet adressiert werden |
| Latenz und Sync | Kritisch | Muss gemessen und durch Age-Gating/Tracking entschaerft werden |
| Alpha-/Compositing-Semantik | Hoch | Muss dokumentiert oder korrigiert werden |
| Performance | Mittel bis hoch | CPU-Kopien koennen Sync verschlechtern |
| Kantenqualitaet | Mittel | Nach Sync-Fix optimieren |
| Bridge-Validation/Controls | Mittel | Wichtig fuer Tuning und sichere Remote-Steuerung |

## Identifizierte Probleme Und Loesungen

### 1. Maske und RGB-Frame sind nicht synchron

**Symptom fuer Nutzer:** Bei Kopf-, Hand- oder Schulterbewegungen hinkt die Silhouette hinterher. Je nach Bewegung werden Koerperteile kurz abgeschnitten oder der alte Umriss bleibt als Halo sichtbar.

**Technische Ursache:** Im Program-Loop wird der aktuelle Kamera-Frame an den Worker uebergeben und sofort die zuletzt publizierte Maske auf denselben aktuellen Frame angewandt. Das passiert in `runFramePipeline` bei `keyerWorker.submit(frame)`, `copyLatest(latestMask)` und `applyLatestAlphaToCurrentFrame(frame, latestMask, keyedFrame)` (`apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:575`). Die Maske traegt den Timestamp des Keyer-Input-Frames, nicht des sichtbaren RGB-Frames (`apps/bridge/native/meeting-helper/src/keyer/vision_keyer.mm:160` und `apps/bridge/native/meeting-helper/src/keyer/modnet_keyer.cpp:270`).

**Fix-Richtung:**

- Kurzfristig: Mask-Age-Gating einfuehren. Ab einem harten Grenzwert, z. B. 80-100 ms bei 30 fps, nicht mehr hart freistellen. Stattdessen konservativ degradieren: passthrough, Blur/soft background oder mehr Vordergrund statt aggressives Replacement.
- Kurzfristig: `mask_age_ms` fuer jeden Program-Frame in Status/Logs sichtbar machen und Grenzwerte als native Settings steuerbar machen.
- Mittelfristig: Frame-Pairing einfuehren: zu jeder publizierten Maske den zugehoerigen RGB-Frame oder zumindest Bewegungsmetadata behalten und entweder den passenden RGB-Frame compositen oder die Maske per Motion-Tracking auf den aktuellen Frame warpen.
- Langfristig: Optical Flow / Vision tracking / Metal-basierte Motion Compensation fuer Maske zwischen Inferenzen.

**Verifikation:**

- Testsequenz mit schneller Handbewegung und Schulterdrehung aufnehmen.
- `mask_age_ms`, `session_run_ms`, `dropped_frames`, `program_frame_ms` parallel loggen.
- Akzeptanz: Bei 30 fps sollte sichtbares Hard-Keying nur mit Masken unter definierter Age-Schwelle stattfinden. Bei Ueberschreitung muss die Degradation sichtbar ruhiger sein als ein alter Key.

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

**Symptom fuer Nutzer:** Bei hoher Inferenzzeit oder CPU-Last bleibt die Person scheinbar mit einer alten Kontur freigestellt. Das sieht schlimmer aus als ein kurzzeitiger Fallback.

**Technische Ursache:** `applyLatestAlphaToCurrentFrame` hat keine Age-Pruefung (`apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:250`). Der Program-Loop berechnet `mask_age_ms`, nachdem die Maske bereits angewandt wurde (`apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:579`). `kTemporalAlphaMaxAgeNs = 250 ms` begrenzt nur Temporal Blending zwischen Masken, nicht die Nutzung der Maske im Output (`apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp:28`).

**Fix-Richtung:**

- Vor `applyLatestAlphaToCurrentFrame` `frame.timestampNs - latestMask.timestampNs` berechnen.
- Konfigurierbare Grenzwerte einfuehren: `warn_mask_age_ms`, `max_hard_key_mask_age_ms`, `max_mask_age_ms`.
- Bei Ueberschreitung Fallback-Strategie ausloesen: passthrough, conservative-alpha expansion oder background blur.
- Statusfeld `stale_mask_active` und `degradation_mode` ausgeben.

**Verifikation:**

- Inferenz kuenstlich verzoegern und pruefen, dass keine > Grenzwert alte Maske fuer Hard-Keying genutzt wird.
- Unit-/Integrationstest fuer Age-Gating mit synthetischen Timestamps.

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

## Priorisierte Roadmap

### P0: Vor Launch Des Keyer-Erlebnisses

1. Mask-Age-Gating vor Alpha-Anwendung einbauen.
2. Degradation Mode fuer alte Masken definieren und sichtbar machen.
3. Temporal Blend per Config toggelbar machen und Default-Weights reduzieren, falls Testclips Trails zeigen.
4. `transparent` Program-Semantik entscheiden: opak dokumentieren oder Alpha korrekt erhalten.
5. Bridge-Schema fuer `meeting_keyer_configure` streng typisieren.

### P1: Qualitaets- Und Performance-Haertung

1. Reale Capture-Aufloesung/FPS und Sample-Timestamp erfassen.
2. Camera BGRA -> RGBA Copy reduzieren oder GPU/Metal-Pfad planen.
3. Gemeinsame Mask-Sampling-Utility fuer Vision, MODNet und Program-Pfad.
4. Zwei Graphics-Layer-Pfade fuer Behind/Front definieren, falls Meeting Builder beide Ebenen semantisch braucht.
5. Straight-Alpha-Kontrakt per Tests absichern.

### P2: Enterprise-Qualitaet

1. Motion Compensation / Optical Flow fuer Maske zwischen Inferenzframes.
2. ROI-Keying und adaptive Quality Mode Selection.
3. GPU-Compositing statt CPU-Pixel-Loops.
4. Automatisierte Video-Golden-Tests fuer Handbewegung, Haare, Brille, Schulterbewegung.

## Fazit

Die bestehende Architektur ist nicht "falsch" gebaut: Worker-Entkopplung, Single Program-Loop und FrameBus-Output sind die richtigen Leitplanken. Der aktuelle Keyer ist aber noch kein meeting-tauglicher Motion-Keyer, weil er alte Masken auf aktuelle RGB-Frames legt und diese Nutzung nicht hart begrenzt. Solange dieses Sync-Problem offen ist, bringen reine Kanten-Optimierungen nur begrenzt etwas.

Der pragmatische naechste Schritt ist kein grosser Architekturumbau, sondern ein kontrollierter Safety-Layer: Mask-Age vor Anwendung pruefen, klare Degradation statt altem Hard-Key, Temporal Blend schaltbar machen und Metriken fuer reproduzierbare Motion-Tests nutzen. Danach lohnt sich die Arbeit an Motion Compensation, GPU-Pfad und feiner Kantenqualitaet.
