# ADR-0007: Meeting-Programm im Hochformat (9:16)

- Status: akzeptiert; in Teilen abgelöst durch ADR-0010 (Neustart-Entscheidung: die Bildrate wird jetzt mitverglichen;
  alles Übrige gilt unverändert)
- Datum: 2026-11-19

## Kontext
Das Meeting-Programm war bisher faktisch 16:9: die Web-App startete die Engine mit 1920×1080, die Meeting-Grafiken
wurden fest in 1920×1080 gerendert, und alle Abnehmer (Vorschau, Aufnahme, virtuelle Kamera, Conference-Display) gingen
von diesem Format aus. Für Hochkant-Inhalte (Reels, Shorts) soll das Programm selbst 1080×1920 sein, statt ein 16:9-Bild
nachträglich zu beschneiden. Gabriel (19.11.2026): echtes 9:16-Programm in der Engine; Vorschau, Dock und Aufnahme
hochkant; virtuelle Kamera und Display bleiben 16:9 mit Balken. Der Helper-Teil (Capture, Compositor, Balken für die
virtuelle Kamera) liegt in `apps/bridge/native/meeting-helper/README.md`, Abschnitt „Portrait Program (9:16)".

## Entscheidung
- **Die Leinwand ist ein Startparameter, kein Laufzeitzustand.** `meeting_engine_start` nimmt `width`/`height`
  unverändert entgegen; `height > width` ist Hochformat. Die Größe gilt für die Lebensdauer des Helper-Prozesses. Einen
  Formatwechsel im laufenden Betrieb gibt es nicht: ein Start mit anderer Geometrie bei laufender Engine wird mit
  `meeting_engine_restart_required` abgelehnt; derselbe Start mit gleicher Geometrie bleibt idempotent (zweiter Client,
  Autostart). Die Bridge startet dabei **nie selbst neu** – ein Stop finalisiert eine laufende Aufnahme und nimmt Kamera
  und virtuelle Kamera weg; diese Entscheidung trifft die Web-App mit explizitem `meeting_engine_stop` +
  `meeting_engine_start`. Läuft eine Aufnahme, nennt die Fehlermeldung das. Verglichen werden Breite und Höhe, nicht die
  Bildrate. Eine Ablehnung ändert nichts: sie fällt vor jeder Änderung an FrameBus, Renderern und Grafik-Ebenen – auch
  wenn der Start nur auf einen noch laufenden Startvorgang mit anderer Geometrie träfe (zweiter Client, Crash-Restart);
  die Antwort wartet dann auf diesen Start.
- **Capability statt Versionsraten.** `get_status.capabilities.meeting.program_portrait` (Typ `MeetingCapabilitiesT`,
  `services/meeting/meeting-capabilities.ts`) sagt, ob diese Bridge auf dieser Plattform ein Hochformat-Programm
  fahren kann: `true` auf macOS, `false` auf Windows, bis der Windows-Pfad am Gerät geprüft ist. Ohne Capability lehnt
  die Bridge einen Hochformat-Start mit `meeting_program_portrait_unsupported` ab. Ältere Bridges liefern den Block
  nicht; die Web-App blendet den Umschalter dann aus.
- **Der Status nennt die laufende Geometrie.** `program_format {width, height, fps}` steht im Meeting-Status
  (top-level und in `manager`), abgeleitet aus den Optionen des Starts, der den laufenden Helper erzeugt hat – denselben
  Optionen, die ein Crash-Restart wiederholt. `null`, solange die Engine nicht läuft. Ein wirkungsloser Start
  überschreibt diese Optionen nicht mehr.
- **Meeting-Grafiken in Programmgröße.** Der native Compositor legt jede Grafik-Ebene per Cover auf die Leinwand; eine
  1920×1080-Ebene auf 1080×1920 behielte rund 32 % ihrer Breite. Deshalb folgen Pre-Warm und
  `meeting_graphics_configure_outputs` der Engine-Geometrie, sobald die **Ausrichtung** von der Anfrage abweicht; bei
  gleicher Ausrichtung bleibt die angefragte Größe (heutiges Verhalten, z. B. 1920×1080-Ebenen auf einer 1280×720-
  Engine). Die Antwort nennt die tatsächlich konfigurierte Größe. Die Bridge-eigenen Inhalts-Ebenen (Videodatei,
  Browser-Quelle) bekommen die Bühnengröße als Parameter; im Querformat bleibt es bei 1920×1080.
- **Die Box einer Ebene gehört zur Ebene (`canvas`), nicht zum Renderer** (Nachtrag 20.11.2026; die erste Fassung
  ließ die feste 1920×1080-Box stehen). Der Renderer gab jeder Template-Ebene eine 1920×1080-Box – Ebenen-Host und
  `#graphic-root` –, die das Layout nur verschiebt und skaliert. In einem 1080×1920-Programm füllten Templates, die
  ihre Box prozentual ausfüllen, damit nur die oberen 1080×1080; Bild-in-Bild-Anteile skalierten die falsche Box, und
  9:16-Presets ragten über das Programm hinaus. `graphics_send` trägt deshalb optional `canvas { width, height }`
  (ganze Zahlen, 16–7680): die Größe der Box in Ebenen-Pixeln **vor** der Layout-Transformation. Ohne das Feld bleibt
  die Box 1920×1080, DOM und Renderer-Payload sind dann unverändert; der Studio-Pfad sendet es nicht. Ein weiteres
  `graphics_send` derselben Ebene setzt die Box neu (anderes `canvas`, oder ohne Feld wieder 1920×1080),
  `graphics_update_layout` lässt sie stehen. Die Supersampling-Stufe steckt weiter allein in der Layout-Transformation;
  die Box wird nie mit ihr multipliziert. Die Web-App erkennt die Unterstützung an
  `capabilities.meeting.layer_canvas` – auf allen Plattformen `true`, unabhängig von `program_portrait`.
- **16:9-Abnehmer bekommen Balken, keine Verzerrung.** Die virtuelle Kamera füllt der Helper auf 1920×1080 auf
  (`util/frame_fit`). Das Conference-Display (`display-output-entry.ts`) zeichnet das Bild per `computeContainRect`
  eingepasst und zentriert statt gestreckt (WebGL-Viewport bzw. Canvas-2D).

## Alternativen
- **Formatwechsel im laufenden Helper** (Leinwand zur Laufzeit umbauen): verworfen. FrameBus-Regionen, Encoder,
  Recorder und die Ringe der virtuellen Kamera sind auf eine feste Geometrie angelegt; ein Umbau unter laufenden
  Abnehmern wäre die riskanteste Stelle des Features.
- **Automatischer Neustart in der Bridge** bei abweichender Geometrie: verworfen, weil ein zweiter Client mit alter
  Voreinstellung sonst eine laufende Sendung oder Aufnahme beenden könnte.
- **16:9 rendern und für Hochkant beschneiden**: verworfen (Auflösungsverlust, Layouts nicht für Hochkant gebaut).
- **Grafik-Ebenen in 1920×1080 lassen und im Compositor einpassen**: verworfen; Grafiken wären im Hochformat nur ein
  schmaler Streifen oder stark beschnitten.
- **Native Hochformat-Ausgabe für virtuelle Kamera und Display**: zurückgestellt; Meeting-Clients und Capture-Geräte
  erwarten 16:9.
- **Feste 1920×1080-Box behalten und Hochformat allein über das Layout lösen** (erste Fassung): verworfen. Verschieben
  und gleichmäßiges Skalieren macht aus einer 16:9-Box keine 9:16-Box, und die Web-App rechnet bereits mit einer Box in
  der Größe der Bühne, auf der das Layout entstanden ist.

## Folgen
- Neue Vertragsteile (additiv): `capabilities.meeting.program_portrait`, `program_format` im Meeting-Status,
  Fehlercodes `meeting_program_portrait_unsupported` und `meeting_engine_restart_required`. Die Web-App muss
  `meeting_engine_restart_required` behandeln; bisher war jeder Start bei laufender Engine erfolgreich.
- Ebenfalls additiv: `canvas` in `graphics_send` und `capabilities.meeting.layer_canvas`. Bridges ohne die Capability
  werten das Feld nicht aus (sie entfernen es, sehr alte lehnen den Send ab); die Web-App sendet es deshalb nur mit der
  Capability. Beide HTML-Hosts (Offscreen-Renderer und vMix-Browser-Input) legen die Box über dieselbe Funktion an
  (`renderer/layout-runtime.ts`).
- Das Offscreen-Fenster des Meeting-Renderers ist im Hochformat 1080×1920, mit 2×-Supersampling 2160×3840. macOS
  erlaubt das (`enableLargerThanScreen`; am 19.11.2026 auf einem 1728×1117-Display gemessen: Inhaltsgröße 1080×1920
  und 2160×3840 ohne Klemmen). **Windows** klemmt neue Fenster auf den Arbeitsbereich; `ensureWindowContentSize` fragt
  erneut an, fällt sonst auf 1× zurück und meldet danach „still clamped" – auf einem Monitor mit weniger als 1920
  Zeilen wären Grafiken dann unten abgeschnitten und verzerrt. Das ist vor dem Freischalten der Windows-Capability am
  Gerät zu prüfen.
- Der Conference-Modus startet weiter im Querformat; das Einpassen im Display ist eine Absicherung, kein neuer Modus.
  Nebenwirkung: weicht das Seitenverhältnis des Displays vom Programm ab (16:9-Programm auf 16:10-Display), erscheinen
  jetzt Balken statt eines gestreckten Bildes.
- Studio-Live-Ausspielung, DeckLink und die Studio-Display-Ausgabe (nativer Display-Helper) bleiben 16:9 und unberührt.
- Nur am Gerät prüfbar: Hochformat mit echter freigestellter Kamera, Grafiken und Inhalts-Ebenen im 1080×1920-Programm,
  Conference-Display mit Balken, der gesamte Windows-Pfad.
