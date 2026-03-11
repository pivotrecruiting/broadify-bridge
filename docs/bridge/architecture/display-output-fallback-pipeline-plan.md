# Display Output Fallback Pipeline Plan

## Kontext

Dieser Plan beschreibt, wie die Display-Output-Pipeline fuer externe Displays
(HDMI/DisplayPort/Thunderbolt) end-to-end konsistent gemacht werden soll, ohne
die bestehenden Fallbacks zu entfernen.

Wichtige Praemisse:

- Fallbacks bleiben aktiv, auch wenn sie im Einzelfall falsch sein koennen.
- Fallbacks duerfen aber nicht mehr als "echte" Display-Capability erscheinen.
- Die Pipeline muss jederzeit klar unterscheiden zwischen:
  - wirklich erkannt
  - aus aktivem Desktop-Modus abgeleitet
  - blindem Fallback

## Zielbild

- Die WebApp zeigt fuer Display-Outputs nur dann "echte" Formate oder
  Pixelformate an, wenn diese wirklich erkannt wurden.
- Die Bridge liefert fuer Display-Outputs eine klare Qualitaetsstufe der
  Erkennung mit.
- Der Renderer, FrameBus und Display-Helper arbeiten immer mit einer einzigen,
  aufgeloesten Output-Format-SSOT.
- Auch im Fallback-Fall kann weiterhin gesendet werden, aber mit klarer
  Kennzeichnung und kontrolliertem Verhalten.

## Nicht-Ziele

- Keine Entfernung von Fallbacks.
- Kein kurzfristiger Umbau auf einen voll kontrollierten HDMI-Signalpfad wie bei
  DeckLink.
- Keine Behauptung eines physikalischen Signalformats, wenn das OS oder die
  Hardware diese Information nicht verlaesslich liefert.

## Phase 0 - Baseline und Begriffsbereinigung

- [ ] Begriffe im Team und in der UI sauber trennen:
  - `render_format`
  - `desktop_mode`
  - `display_signal`
  - `fallback_format`
- [ ] Festlegen, dass `pixelFormats` fuer `display`-Outputs nur dann befuellt
  werden darf, wenn es dafuer eine echte native Datenquelle gibt.
- [ ] Festlegen, dass `range` und `colorspace` fuer `display`-Outputs aktuell
  keine harte Signalgarantie darstellen.
- [ ] Dokumentieren, dass der aktuelle `display-helper` nur RGBA aus FrameBus
  annimmt und keinen echten Display-Mode am Monitor setzt.

## Phase 1 - Beobachtbarkeit und Diagnostik

- [ ] Bridge-Logs fuer `display`-Detection um folgende Felder erweitern:
  - stabile Display-ID
  - Display-Name
  - Connection-Type
  - erkannte Aufloesung
  - erkannte Refresh-Rate
  - Datenquelle
  - Confidence/Qualitaetsstufe
  - Fallback-Grund
- [ ] Fuer Kundenfaelle einen klaren Vergleichslog definieren:
  - Monitor direkt
  - Monitor ueber ATEM
- [ ] In `graphics_list` oder einem dedizierten Status-Objekt den aktuell
  verwendeten Validation-Modus zurueckgeben:
  - `exact_detected`
  - `active_mode_derived`
  - `fallback_assumed`
- [ ] Im `display-helper` bei Start loggen:
  - gewaehlter Screen
  - Display-Name
  - Bounds
  - angeforderte Width/Height/FPS
  - tatsächlicher Desktop-Bounds-Match

## Phase 2 - WebApp-Fallbacks sauber modellieren

- [ ] Die bestehenden Fallback-Formate `1080i50` und `1080p50` beibehalten.
- [ ] Fallback-Formate in der UI klar als Fallback markieren und nicht als
  erkannte Display-Formate darstellen.
- [ ] In der UI unterscheiden zwischen:
  - `detected mode`
  - `recommended fallback`
  - `manual fallback`
- [ ] Beim Speichern der Output-Konfiguration zusaetzlich persistieren:
  - ob das Format erkannt oder Fallback war
  - welcher Fallback-Grund vorlag
- [ ] Fuer `display`-Outputs keine Pixelformat-Anzeige aus `pixelFormats`
  ableiten, solange diese vom Bridge-Pfad nicht echt geliefert werden.
- [ ] Falls `modes` leer sind, weiterhin Save erlauben, aber mit sichtbarem
  Warning-State in der UI.

## Phase 3 - Bridge-Datenmodell fuer Display-Outputs erweitern

- [ ] Das Bridge-Modell fuer `display`-Outputs um Metadaten erweitern:
  - `detectionSource`
  - `modeConfidence`
  - `fallbackReason`
  - `activeMode`
  - `candidateModes`
  - `displayId`
- [ ] Zwischen diesen Datenarten sauber trennen:
  - aktuell aktiver Desktop-Modus
  - verfuegbare Modi laut nativer API
  - Fallback-Kandidaten
- [ ] `OutputDisplayModeT` fuer `display`-Outputs nur dann als "detected"
  behandeln, wenn Width, Height und FPS aus einer belastbaren Quelle stammen.
- [ ] Wenn nur Teilinformationen vorliegen, daraus einen markierten
  `derived`-Mode erzeugen statt einen stillen "echten" Mode.
- [ ] Wenn gar keine Mode-Daten vorliegen, keine Schein-Mode erzeugen, sondern
  den Fallback-Grund explizit setzen.

## Phase 4 - Native Display-Erkennung auf macOS robust machen

- [ ] Auf macOS fuer `display`-Outputs eine native Primaerquelle definieren:
  bevorzugt CoreGraphics/IOKit statt ausschliesslich `system_profiler`.
- [ ] `system_profiler` nur noch als Secondary-/Fallback-Quelle behandeln.
- [ ] Eine stabile Display-ID durchgaengig erfassen und an die weiteren
  Pipeline-Stufen weitergeben.
- [ ] Aktiven Desktop-Modus nativ auslesen:
  - Width
  - Height
  - Refresh
  - ggf. HiDPI/Scaling-Kontext
- [ ] Wenn moeglich verfuegbare Modi nativ auslesen und separat modellieren.
- [ ] Fuer Connection-Type den heutigen Fallback auf `displayport` beibehalten,
  aber mit eigener Confidence markieren.
- [ ] Fuer ATEM-Zwischenfaelle die Rohdaten "direkt" vs. "ueber ATEM" gezielt
  vergleichen.

## Phase 5 - Bridge-Validierung auf kontrollierte Fallbacks umstellen

- [ ] Die aktuelle Logik "keine Modes -> Validation skip" ersetzen.
- [ ] Stattdessen drei Validierungsstufen einfuehren:
  - `strict_match`
  - `derived_match`
  - `blind_fallback`
- [ ] `blind_fallback` weiterhin erlauben, aber nur mit:
  - Warning-Log
  - Status-Rueckmeldung
  - sichtbarem UI-Hinweis
- [ ] Die aufgeloeste Output-Konfiguration in der Bridge immer um diese Felder
  erweitern:
  - `requestedFormat`
  - `resolvedFormat`
  - `validationMode`
  - `warnings`
- [ ] Sicherstellen, dass die Bridge nie mehr implizit so wirkt, als sei ein
  Fallback ein sauber validierter Display-Mode.

## Phase 6 - SSOT fuer Render- und Output-Format

- [ ] Eine einzige aufgeloeste Format-SSOT definieren, aus der alle
  nachfolgenden Komponenten gespeist werden.
- [ ] Diese SSOT muss mindestens enthalten:
  - width
  - height
  - fps
  - source
  - confidence
  - fallbackReason
- [ ] Renderer-Konfiguration ausschliesslich aus dieser SSOT ableiten.
- [ ] FrameBus-Header ausschliesslich aus dieser SSOT ableiten.
- [ ] Display-Helper-Startparameter ausschliesslich aus dieser SSOT ableiten.
- [ ] Rueckkanal fuer `graphics_list` aus derselben SSOT speisen.

## Phase 7 - Display-Helper gezielt haerten

- [ ] Display-Zuordnung nicht primaer ueber Namen machen, sondern ueber stabile
  Display-ID, falls verfuegbar.
- [ ] Name und Width/Height nur als sekundaeres Matching beibehalten.
- [ ] Vor Start des Fullscreen-Fensters den aktiven Desktop-Bounds-/Mode-Kontext
  sauber loggen.
- [ ] Explizit definieren, was passiert wenn:
  - angeforderte Render-Aufloesung != Desktop-Aufloesung
  - angeforderte FPS != Desktop-Refresh
- [ ] Das Verhalten in diesen Faellen produktseitig festlegen:
  - skalieren erlaubt
  - frame pacing best effort
  - Warning ausgeben
- [ ] Optionalen spaeteren Ausbau pruefen:
  - nativer Display-Mode-Switch vor Start
  - aber nur als explizite spaetere Phase, nicht als Sofortmassnahme

## Phase 8 - Vertragsbereinigung zwischen WebApp und Bridge

- [ ] Payload und Rueckgabeobjekte fuer Display-Outputs um Herkunft und
  Vertrauensstufe erweitern.
- [ ] In der WebApp nicht nur `format`, sondern auch `formatSource` und
  `fallbackReason` mitdenken.
- [ ] In `GraphicsStatus`/`graphics_list` den vom Bridge-Prozess tatsaechlich
  verwendeten `resolvedFormat` zurueckgeben.
- [ ] Sicherstellen, dass ein gespeicherter User-Fallback beim naechsten Laden
  wieder als Fallback erkennbar ist und nicht als "detecteter" Mode erscheint.

## Phase 9 - QA-Matrix und Abnahme

- [ ] Testmatrix fuer folgende Topologien definieren:
  - Monitor direkt
  - Monitor ueber ATEM
  - unterschiedliche Monitore
  - unterschiedliche Aufloesungen
  - unterschiedliche Refresh-Raten
- [ ] Fuer jede Topologie pruefen:
  - Display wird richtig gematcht
  - erkannter Mode ist korrekt oder sauber als Fallback markiert
  - Renderer-Format == FrameBus-Format == Bridge-Status
  - keine Width/Height-Mismatches
  - keine FPS-Mismatches
  - Fullscreen landet auf dem richtigen Screen
- [ ] Testfall definieren, bei dem bewusst keine Display-Modes erkannt werden,
  um den Fallback-Pfad reproduzierbar zu validieren.
- [ ] Logs und UI-State fuer Kunden-Support als festen Diagnoseablauf
  dokumentieren.

## Umsetzungsreihenfolge

- [ ] Zuerst Phase 1 bis Phase 3 umsetzen, damit Sichtbarkeit und Datenmodell
  sauber werden.
- [ ] Danach Phase 5 und Phase 6 umsetzen, damit die Bridge konsistent arbeitet.
- [ ] Danach Phase 4 und Phase 7 umsetzen, um die eigentliche Display-Erkennung
  und den Runtime-Pfad robuster zu machen.
- [ ] Phase 9 parallel vorbereiten und vor Rollout komplett abarbeiten.

## Erfolgskriterien

- [ ] Ein Kunde kann auch ohne vollstaendige Display-Capability-Erkennung
  weiterhin senden.
- [ ] Jeder Fallback ist im System explizit als Fallback sichtbar.
- [ ] Der tatsaechlich verwendete `resolvedFormat` ist in WebApp und Bridge
  eindeutig nachvollziehbar.
- [ ] Width/Height/FPS-Mismatches werden nicht mehr still uebergangen.
- [ ] Der Unterschied zwischen "direkt am Monitor" und "ueber ATEM" ist in
  Logs und Statusdaten eindeutig sichtbar.
