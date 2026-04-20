# vMix Controls Final – Umsetzungsplan

## Zweck

Diese Doku beschreibt den finalen Zielpfad fuer die Controls-Integration mit `vMix`.

Ziel ist eine produktionssaubere Loesung ohne ATEM-geerbte Makro-Annahmen.
Die Controls-Seite soll fuer `vMix` fachlich korrekt, dokumentiert und nachvollziehbar arbeiten.

## Ausgangslage

Der aktuelle Stand ist ein bewusst pragmatischer Kompatibilitaetspfad:

- `vMix` verbindet sich ueber den dokumentierten HTTP-State-Read `GET /api`
- die Bridge liest verfuegbare Eintraege aus dem vMix-State
- die Controls-Seite kann Eintraege laden und Buttons zuweisen
- beim Triggern nutzt `vMix` jetzt einen dokumentierten Script-Pfad statt undokumentierter `MacroStart`- oder `MacroStop`-Calls

Das reicht fuer kontrollierte Kunden-Setups, ist aber noch kein final sauberes Produktmodell.

## Umsetzungsstand

Stand `2026-04-13`:

- Phase 1 ist umgesetzt
- Phase 2 ist umgesetzt
- Phase 3 ist umgesetzt
- Phase 4 ist umgesetzt

Offen sind damit noch die produktionssaubere Migrations- und Alt-Daten-Strategie aus Phase 5.

## Zielbild

Die finale Version soll `vMix` nicht mehr als Sonderfall eines generischen Makro-Systems behandeln.
Stattdessen bekommt `vMix` ein eigenes, fachlich korrektes Action-Modell.

Der Zielpfad lautet:

- `ATEM` und `TriCaster` bleiben ID-basierte Macro-Engines
- `vMix` wird als Script-/Action-basierte Engine modelliert
- die WebApp zeigt fuer `vMix` keine irrefuehrende Makro-Semantik mehr
- die Bridge fuehrt nur dokumentierte vMix-HTTP-Funktionen aus
- Controls-Zuweisung, Speicherung und Triggering verwenden fuer `vMix` stabile Namen oder definierte Action-Keys statt numerischer Macro-IDs

## Architekturprinzipien

1. State und Action strikt trennen

- State immer ueber `GET /api`
- Action nur ueber dokumentierte Funktionen wie `ScriptStart` oder `ScriptStop`

2. Keine undokumentierten vMix-Functions

- kein `GetVersion`
- kein `GetMacros`
- kein `MacroStart`
- kein `MacroStop`

3. Keine falsche Fachsprache im Produkt

- wenn `vMix` Scripts oder Actions ausfuehrt, darf die UI das langfristig nicht weiter als „Makro“ labeln

4. Engine-spezifische Semantik im Datenmodell abbilden

- nicht alle Engines in dieselbe numerische `macroId`-Struktur pressen

## Zielmodell

### 1. Engine-Assignments in der WebApp

Der aktuelle Controls-Slot speichert implizit:

- `camera`-Button -> `macroId`
- `graphics`-Button -> `presetId`

Fuer die finale Version soll daraus ein expliziter Assignment-Typ werden.

Beispielhafte Zielstruktur:

```ts
type ControlAssignmentT =
  | {
      kind: "engine_macro";
      engineType: "atem" | "tricaster";
      macroId: number;
      label: string;
    }
  | {
      kind: "vmix_script";
      engineType: "vmix";
      scriptName: string;
      label: string;
    }
  | {
      kind: "graphics_preset";
      presetId: string;
      label: string;
    };
```

Wichtig:

- `vMix` speichert `scriptName`
- `ATEM` und `TriCaster` speichern `macroId`
- `graphics` bleibt davon getrennt

### 2. Bridge-Command-Modell

Der Bridge-Vertrag soll langfristig explizit nach Action-Typen getrennt sein.

Ziel:

- generischer Makro-Pfad fuer `ATEM` und `TriCaster`
- vMix-spezifischer Action-Pfad fuer dokumentierte Scripts

Beispiel:

- `engine_run_macro` nur fuer ID-basierte Engines
- `engine_vmix_run_action` fuer `script_start` und optional `script_stop`

Der bereits eingefuehrte `engine_vmix_run_action`-Pfad ist die Basis fuer diesen finalen Weg.

### 3. UI-Semantik

Die Controls-Seite soll den Inhalt vom aktuellen Engine-Typ abhaengig machen.

Fuer `ATEM` und `TriCaster`:

- Label: `Macros`
- Auswahlquelle: Engine-Makroliste

Fuer `vMix`:

- Label: `Scripts` oder `Actions`
- Auswahlquelle: vMix-Script-Liste oder Broadify-definierte vMix-Action-Liste

## Offene Produktentscheidung

Fuer die finale Version muss eine der folgenden Varianten verbindlich entschieden werden.

### Variante A – vMix Scripts als primaeres Modell

Broadify arbeitet fuer `vMix` explizit mit Script-Namen.

Vorteile:

- dokumentierter Ausfuehrungspfad
- stabile Namen statt impliziter IDs
- fachlich korrekt

Nachteile:

- Discovery der verfuegbaren Scripts muss sauber geloest werden
- bestehende Controls-DB-Modelle muessen angepasst werden

### Variante B – Broadify Actions als primaeres Modell

Broadify verwaltet eine eigene Liste erlaubter vMix-Actions und mappt diese intern auf dokumentierte vMix-Funktionen.

Beispiele:

- `vmix_script:LowerThirdIn`
- `vmix_script:OpenScoreBug`
- `vmix_action:BrowserNavigateMain`

Vorteile:

- maximale Produktkontrolle
- klarere UX
- gute Auditierbarkeit

Nachteile:

- mehr Produkt- und Admin-Aufwand
- weniger direkt an vorhandenen vMix-Scripts orientiert

### Empfohlene finale Richtung

`Variante A` ist fuer den naechsten sauberen Produktionsschritt am pragmatischsten:

- `vMix` ueber `scriptName`
- Ausfuehrung ueber `ScriptStart`
- spaeter optional Erweiterung zu `script_stop` oder weiteren dokumentierten Actions

## Phasenplan

### Phase 1 – Datenmodell bereinigen

Ziel:

- Controls-Assignments engine-spezifisch modellieren

Aufgaben:

- WebApp-Types von reinem `macroId`-Modell loesen
- Controls-Store fuer engine-spezifische Assignment-Typen erweitern
- Persistenzschema fuer `control_macros` bzw. Nachfolgestruktur anpassen
- Migrationsstrategie fuer bestehende ATEM-/Graphics-Daten definieren

Ergebnis:

- `vMix` wird nicht mehr ueber ein fremdes Makro-ID-Modell gespeichert

### Phase 2 – vMix-Auswahlquelle finalisieren

Ziel:

- belastbare Quelle fuer in Broadify sichtbare `vMix`-Scripts bereitstellen

Aufgaben:

- pruefen, ob eine dokumentierte und stabile Script-Discovery aus `vMix` moeglich ist
- falls nicht: Broadify-seitiges Script-Register oder Action-Register definieren
- UI fuer `vMix` auf `Scripts` oder `Actions` umstellen
- Such-/Select-Komponente fuer vMix anpassen

Ergebnis:

- die Controls-Seite zeigt fuer `vMix` fachlich korrekte Auswahloptionen

### Phase 3 – Triggering sauber trennen

Ziel:

- Ausfuehrung je Engine-Typ explizit und nachvollziehbar machen

Aufgaben:

- WebApp-Trigger-Logik von `engineRunMacro()` entkoppeln
- fuer `vMix` nur `engine_vmix_run_action`
- fuer `ATEM` und `TriCaster` weiter `engine_run_macro`
- optional `script_stop` nur dann exponieren, wenn es fachlich gebraucht wird

Ergebnis:

- keine implizite Vermischung von Makro- und Script-Semantik mehr

### Phase 4 – UX und Copy korrigieren

Ziel:

- Nutzer fuehren nicht versehentlich das falsche Konzept aus

Aufgaben:

- alle `vMix`-bezogenen Labels in der Controls-Page pruefen
- `Makro` bei `vMix` durch `Script` oder `Action` ersetzen
- Hilfetexte fuer `vMix` ergaenzen:
  - Script-Namen muessen stabil gepflegt werden
  - Triggering erfolgt ueber dokumentierte `vMix`-Scripts
- Fehlertexte engine-spezifisch machen

Ergebnis:

- die UI spricht fuer `vMix` fachlich korrekt

### Phase 5 – Persistenz und Migration

Ziel:

- bestehende Controls-Daten ohne Datenverlust in das finale Modell ueberfuehren

Aufgaben:

- bestehende `macroId`-Assignments fuer `vMix` identifizieren
- Migrationslogik fuer Alt-Daten definieren
- Fallback-Regeln fuer nicht aufloesbare `vMix`-Zuordnungen dokumentieren
- Admin-/Debug-Sicht fuer problematische Assignments vorsehen

Ergebnis:

- bestehende Kunden-Setups bleiben migrierbar

### Phase 6 – QA auf echter vMix-Maschine

Ziel:

- reale Maschinenvalidierung statt nur Contract-/Unit-Tests

Pflichtfaelle:

- `vMix` verbinden
- Script-Liste laden
- Script auf Button zuweisen
- Button ausloesen
- mehrfaches Triggern
- Fehlerfall bei fehlendem Script-Namen
- Neustart von `vMix`
- Neustart der Bridge

Ergebnis:

- produktionsreife Verifikation fuer den finalen `vMix`-Controls-Pfad

## Technische Umsetzungshinweise

### Bridge

Bereits vorhanden:

- State ueber `/api`
- `engine_vmix_run_action`
- `ScriptStart` / `ScriptStop`

Noch fuer finalen Stand zu pruefen:

- ob `script_stop` ueberhaupt in der Produkt-UI gebraucht wird
- ob weitere dokumentierte vMix-Funktionen als Action-Typen aufgenommen werden sollen

### WebApp

Bereits vorhanden:

- runtime-seitige Umschaltung auf `engine_vmix_run_action` fuer den Trigger-Fall

Noch offen:

- engine-spezifisches Assignment-Modell
- `vMix`-eigene Terminologie
- persistente `scriptName`-Semantik statt indirekter Makro-Semantik

### Datenbank / Backend

Noch offen:

- finale Tabellen-/Payload-Struktur fuer engine-spezifische Control-Assignments
- Migrationspfad fuer bestehende gespeicherte Assignments

## Risiken

1. Falsche Namensgleichheit

- Wenn Broadify einen Namen auswaehlt, der nicht exakt zum realen `vMix`-Script passt, funktioniert der Trigger nicht.

2. Gemischte Alt-Daten

- Bestehende Controls-Sessions koennen `vMix` noch wie generische Makros behandeln.

3. UX-Verwirrung

- Solange die UI fuer `vMix` von „Makros“ spricht, bleibt Fehlbedienung wahrscheinlich.

4. Unklare Script-Discovery

- Wenn `vMix` keine saubere dokumentierte Script-Liste liefert, braucht Broadify bewusst ein eigenes Register.

## Akzeptanzkriterien fuer die finale Version

Die finale Version gilt erst dann als fertig, wenn:

- `vMix` in der Controls-UI nicht mehr ueber irrefuehrende Makro-Begriffe modelliert ist
- gespeicherte `vMix`-Assignments fachlich als Scripts oder Actions persistiert werden
- Triggering ausschliesslich ueber dokumentierte vMix-Funktionen laeuft
- echte End-to-End-Tests gegen eine reale `vMix`-Instanz erfolgreich sind
- Migrations- und Fallback-Regeln fuer bestehende Kunden-Setups dokumentiert sind

## Empfohlene Reihenfolge

1. Datenmodell fuer Assignments engine-spezifisch machen
2. `vMix`-UI von `Macros` auf `Scripts` umstellen
3. Persistenz und Migration bauen
4. reale `vMix`-QA durchziehen
5. erst danach die aktuelle Kompatibilitaetssemantik vollstaendig entfernen
