# ADR-0001: ADR-Prozess

- Status: akzeptiert
- Datum: 2026-10-24

## Kontext
Die Bridge hat gewachsene Doktrinen (strikte Zonen, „Graphics ist Single-Path“, „FrameBus als Data Plane“,
„SDK-Aufrufe bleiben im Helper“), bisher verteilt über AGENTS.md, READMEs und Design-Dokumente. Neue Vorhaben wie
die Live-PGM-Vorschau berühren mehrere davon gleichzeitig. Ohne festen Ort für Entscheidungen werden sie in PR-
Beschreibungen versteckt und später erneut diskutiert.

## Entscheidung
- Entscheidungen mit Doktrin-Wirkung werden als ADR unter `docs/bridge/architecture/adr/` abgelegt: Kontext,
  Entscheidung, Alternativen, Folgen. Deutsch, wie die übrige Bridge-Doku.
- ADRs sind unveränderlich. Änderungen laufen über ein neues ADR, das das alte als „abgelöst“ markiert.
- `AGENTS.md` verweist auf den Ordner; die Tabelle in `README.md` ist der Index.

## Folgen
- Reviewer prüfen bei Doktrin-Berührung, ob ein ADR beiliegt.
- Bestehende Doktrinen werden nicht rückwirkend als ADR nachgetragen; das passiert erst, wenn sie berührt werden.
