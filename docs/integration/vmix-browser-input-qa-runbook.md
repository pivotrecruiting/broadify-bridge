# vMix Browser Input – Einfaches Runbook

## Zweck

Dieses Runbook prueft den aktuellen Standardfall:

- Broadify Bridge und vMix laufen auf **demselben Rechner**
- Broadify verbindet sich mit `vmix`
- Grafiken laufen ueber `browser_input`

Wichtig:

- Remote-vMix auf einem anderen Rechner ist **nicht** Teil dieses Standard-Runbooks.

## Voraussetzungen

Vor dem Test muss Folgendes gegeben sein:

- vMix ist installiert und laeuft
- die Broadify Bridge laeuft lokal auf demselben Rechner
- die WebApp ist mit derselben Bridge verbunden
- in Broadify ist als Engine `vMix` ausgewaehlt
- in Broadify ist als Graphics-Modus `browser_input` gespeichert

## Erwarteter Browser-Input-Link

Der Browser Input in vMix muss auf diese lokale Bridge-Seite zeigen:

`http://127.0.0.1:<bridge-port>/graphics/browser-input`

Beispiel:

`http://127.0.0.1:8787/graphics/browser-input`

## Testablauf

### 1. vMix verbinden

1. In der WebApp `vMix` verbinden.
2. Pruefen:
   - die Verbindung ist erfolgreich
   - Makros koennen geladen werden
   - es gibt keine dauerhaften Engine-Fehler

### 2. Browser Input in vMix anlegen

1. In vMix einen neuen `Web Browser Input` anlegen.
2. Die Browser-Input-URL aus Broadify einfuegen.
3. Optional den empfohlenen Namen aus Broadify uebernehmen.

Erwartung:

- der Browser Input laedt die Broadify-Seite

### 3. Erste Grafik anzeigen

1. In Broadify eine einfache Grafik senden, zum Beispiel eine Lower Third.
2. Den Browser Input in vMix auf Preview oder Program legen.

Erwartung:

- die Grafik ist sichtbar
- der Hintergrund ist korrekt transparent, falls das Template transparent ist

### 4. Grafik live aktualisieren

1. Die sichtbare Grafik in Broadify aendern.

Erwartung:

- die Aenderung erscheint im Browser Input
- es gibt keinen kompletten stoerenden Reload

### 5. Makro testen

1. Ein vMix-Makro aus Broadify ausloesen.

Erwartung:

- das Makro startet in vMix
- Broadify bleibt weiter bedienbar

### 6. Browser Input neu laden

1. Den Browser Input in vMix kurz neu laden oder neu oeffnen.

Erwartung:

- die Seite laedt erneut
- die aktive Grafik erscheint wieder
- es bleibt kein dauerhafter leerer Zustand zurueck

## Test bestanden

Der Test gilt als bestanden, wenn:

- Broadify verbindet sich mit vMix
- der Browser Input laedt die Broadify-Seite lokal
- Grafiken sind sichtbar
- Grafik-Updates kommen an
- Makros funktionieren
- ein Reload fuehrt zu sauberem Recover

## Wenn etwas nicht funktioniert

### Browser Input bleibt leer

Pruefen:

- stimmt die URL
- laeuft die Bridge lokal
- wurde bereits eine Grafik gesendet

### Grafik ist nicht transparent

Pruefen:

- vMix Browser-Input-Einstellungen
- verwendetes Template

### Makros funktionieren nicht

Pruefen:

- ist `vMix` wirklich verbunden
- ist die vMix-API lokal erreichbar

### Nach Reload kommt nichts mehr

Pruefen:

- Browser Input erneut oeffnen
- Bridge laeuft noch
- Grafik erneut senden

## Was fuer die Abnahme reicht

Fuer eine einfache Kundenabnahme reichen:

- ein Screenshot der Browser-Input-URL in Broadify
- ein Screenshot des Browser Inputs in vMix
- ein kurzes Video fuer:
  - erste Grafik
  - Grafik-Update
  - Reload und Recover
