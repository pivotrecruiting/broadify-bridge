# vMix Browser Input – QA Runbook

Ziel: Den `v1`-Demo-Flow fuer `vmix` + `browser_input` auf einer realen Zielmaschine reproduzierbar pruefen.

## Scope

Dieses Runbook prueft:
- Bridge <-> vMix Verbindung
- Browser-Input-Setup in vMix
- Broadify-HTML5-Grafikseite im vMix Browser Input
- Grafik-Live-Updates
- Makro-Ausloesung ueber Controls
- Reload-/Recover-Verhalten des Browser Inputs

Nicht im Scope:
- NDI-/Video-Ingest
- Remote-vMix als Standardfall
- Vollautomatisches Zero-Touch-Setup

## Voraussetzungen

- Windows- oder Laptop-Zielmaschine mit installierter vMix-Version, die Browser Inputs unterstuetzt
- Broadify Bridge laeuft lokal auf derselben Maschine wie vMix
- Broadify WebApp oder Desktop-App ist mit derselben Bridge verbunden
- Engine-Typ ist `vmix`
- vMix-API ist lokal erreichbar, Standardfall `http://127.0.0.1:8088`
- Graphics-Output ist in Broadify auf `browser_input` gespeichert
- Bridge-Port ist bekannt, Standardfall `8787`

## Erwartete Werte

- Browser-Input-URL: `http://127.0.0.1:<bridge-port>/graphics/browser-input`
- Browser-Input-WS-URL: `ws://127.0.0.1:<bridge-port>/graphics/browser-input/ws`
- Empfohlener Input-Name: `Broadify <bridgeName>` oder `Broadify Browser Input`

## Demo-Flow

### 1. Bridge und vMix verbinden

1. Bridge lokal starten.
2. In Broadify `vmix` als Engine verbinden.
3. Verifizieren:
   - Engine-Status ist `connected`
   - Makroliste ist ladbar
   - Keine wiederholten Engine-Fehler im UI oder in den Bridge-Logs

### 2. Browser-Input-Modus konfigurieren

1. In Broadify Graphics den Output-Modus `browser_input` waehlen.
2. Format speichern, z. B. `1920x1080 @ 50 fps`.
3. Verifizieren:
   - `graphics_list` bzw. Graphics-UI zeigt `browserInputUrl`
   - `recommendedInputName` ist sichtbar
   - `transport` steht auf `websocket`

### 3. Browser Input in vMix anlegen

Manueller Pfad:
1. In vMix neuen `Web Browser Input` anlegen.
2. Browser-Input-URL aus Broadify einfuegen.
3. Input-Name nach Empfehlung setzen.
4. Transparenz / Alpha / Layering gemaess vMix-Setup aktivieren.

Optionaler API-Komfortpfad:
1. In der WebApp den CTA `In vMix anlegen` ausloesen.
2. Verifizieren:
   - Erfolgsmeldung erscheint
   - In vMix existiert der Browser Input
   - Name und URL wurden gesetzt

### 4. Grafik sichtbar machen

1. Eine einfache Grafik senden, z. B. Lower Third.
2. In vMix den Browser Input auf Preview oder Program legen.
3. Verifizieren:
   - Grafik erscheint sichtbar
   - Hintergrund ist transparent, wenn das Template transparent ausgelegt ist
   - Keine fehlenden Fonts oder Assets sichtbar

### 5. Grafik-Live-Update pruefen

1. Bereits sichtbare Grafik in Broadify aktualisieren.
2. Verifizieren:
   - Werte-Update wird im Browser Input sichtbar
   - Kein kompletter visuell stoerender Reload
   - `browserClientCount` bleibt >= 1, solange der Browser Input aktiv ist

### 6. Makro-Flow pruefen

1. Ein sichtbares vMix-Makro aus Broadify Controls ausloesen.
2. Verifizieren:
   - Makro startet in vMix
   - Erwartete Aktion tritt ein
   - Broadify Controls bleiben bedienbar

### 7. Browser-Input-Reload / Recover pruefen

1. Browser Input in vMix manuell reloaden oder Input kurz neu oeffnen.
2. Verifizieren:
   - Snapshot wird erneut geladen
   - Aktive Grafik erscheint wieder
   - Kein dauerhafter Fehlerzustand in `browserInput.lastError`
   - Definiertes Verhalten: kurzer Recover ist akzeptabel, permanenter leerer Zustand nicht

## Soll-Ergebnis

Der Flow gilt als bestanden, wenn:
- Bridge verbindet sich stabil mit vMix
- Browser Input laedt die Broadify-Seite lokal
- Grafik ist sichtbar und transparent korrekt
- Live-Updates kommen an
- Makros funktionieren
- Reload fuehrt zu einem definierten Recover

## Negative Checks

- Ohne gespeicherten `browser_input`-Output darf der API-Komfortpfad nicht erfolgreich sein
- Remote-Zugriff ohne Token auf Browser-Input-WS darf nicht funktionieren
- Ein LAN-Bind der Bridge darf die in Broadify angezeigte Browser-Input-URL nicht automatisch auf LAN-IP umstellen

## Typische Fehlerbilder

- Browser Input bleibt leer:
  - URL falsch
  - Bridge nicht lokal erreichbar
  - Grafik nie gesendet

- Grafik ohne Transparenz:
  - vMix Browser-Input-Setup falsch
  - Template nicht transparent ausgelegt

- Assets fehlen:
  - Asset-Datei fehlt lokal
  - `browserInput.lastError.code = asset_missing`

- Makros fehlen:
  - vMix-API nicht erreichbar
  - Engine nicht verbunden

- Nach Reload keine Grafik:
  - Snapshot-/Recover-Pfad pruefen
  - WebSocket verbunden, aber kein Initialzustand sichtbar

## Artefakte fuer Abnahme

- Screenshot der Broadify Browser-Input-URL
- Screenshot des vMix Browser Inputs
- Kurzes Video oder GIF fuer:
  - erstes Laden
  - Grafik-Update
  - Browser-Input-Reload / Recover
- Kurze Notiz zu:
  - verwendeter vMix-Version
  - verwendeter Bridge-Port
  - transparentem oder nicht transparentem Template

## Optionales Remote-LAN-Runbook

Nur falls bewusst getestet:
1. Bridge-LAN-Bind aktivieren.
2. Browser-Input-URL manuell auf eine vom vMix-Host erreichbare Adresse umstellen.
3. Token-/Expositionsmodell separat pruefen.

Wichtig:
- Das ist nicht der `v1`-Standardfall.
- Ergebnisse getrennt vom same-machine-Flow dokumentieren.
