# ADR-0007: Meeting-Programm im Hochformat (9:16)

- Status: akzeptiert
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
  Bildrate.
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
- **Der Template-Designraum bleibt 1920×1080.** Die Basis-Box des Renderers (`electron-renderer-dom-runtime.ts`) und
  der Studio-Pfad sind unverändert. Im Hochformat platziert die Web-App die Templates per Layout in der 1080×1920-Ebene.
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

## Folgen
- Neue Vertragsteile (additiv): `capabilities.meeting.program_portrait`, `program_format` im Meeting-Status,
  Fehlercodes `meeting_program_portrait_unsupported` und `meeting_engine_restart_required`. Die Web-App muss
  `meeting_engine_restart_required` behandeln; bisher war jeder Start bei laufender Engine erfolgreich.
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
