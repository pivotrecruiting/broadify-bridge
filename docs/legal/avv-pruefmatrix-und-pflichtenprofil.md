# AVV/DPA-Pruefmatrix und Pflichtenprofil (Broadify Desktop App + Relay)

Stand: 25. Februar 2026 (Entwurf)

Hinweis: Keine Rechtsberatung. Dieses Dokument hilft bei der Einordnung, ob ein AVV/DPA erforderlich ist und welche Inhalte typischerweise benoetigt werden.

## 1. Ziel

Die Broadify Desktop-App mit Relay kann je nach Nutzung personenbezogene Daten transportieren oder verarbeiten (z. B. Benutzerdaten, Betriebsdaten, Graphics-Inhaltsdaten). Dieses Dokument hilft bei der Frage:

- Brauchen wir einen AVV/DPA?
- Fuer welche Datenkategorien?
- Welche Anhaenge/Pflichten muessen vorbereitet werden?

## 2. Schnellentscheidung (Praxis)

### Typisch AVV erforderlich (B2B)

Ein AVV ist in der Regel erforderlich, wenn Broadify fuer einen Kunden personenbezogene Daten im Auftrag verarbeitet, z. B.:

- Inhaltsdaten in Graphics-/Template-Payloads (Namen, Bilder, Rollen, Einblendungen),
- nutzerbezogene Betriebs-/Auditdaten im Kundenkontext,
- Supportzugriffe auf kundenspezifische Daten im Auftrag.

### Eher kein AVV nur fuer diesen Teil (Einzelfall)

Ein AVV kann entbehrlich sein, wenn Broadify ausschliesslich als eigener Verantwortlicher fuer eigene Vertrags-/Billing-/Sicherheitsdaten agiert und keine personenbezogenen Kundendaten im Auftrag verarbeitet.

In der Praxis ist haeufig ein Mischmodell vorhanden:

- Broadify als Verantwortlicher fuer Account/Billing/Sicherheit
- Broadify als Auftragsverarbeiter fuer kundenseitige Inhalts-/Produktionsdaten

## 3. Pruefmatrix (ausfuellen)

| Frage | Ja/Nein | Konsequenz |
| --- | --- | --- |
| Werden ueber Relay/Bridge Inhaltsdaten verarbeitet, die Personenbezug haben koennen? | `[ ]` | AVV sehr wahrscheinlich erforderlich |
| Verarbeitet Broadify Daten ausschliesslich nach Weisung des Kunden? | `[ ]` | spricht fuer Auftragsverarbeitung |
| Hat der Kunde eigene Verantwortlichkeit fuer die Inhalte/Produktionen? | `[ ]` | klare Rollen-/Weisungsklauseln noetig |
| Gibt es Support-/Admin-Zugriffe auf Kundendaten? | `[ ]` | AVV + TOMs + Zugriffsprozess erforderlich |
| Werden US-/Drittlandanbieter eingesetzt? | `[ ]` | SCC/TIA/Subprozessorenangaben erforderlich |
| Gibt es besondere Kategorien personenbezogener Daten? | `[ ]` | ggf. erhoehte TOMs / Sonderregeln |

## 4. Pflichtinhalte eines AVV/DPA (Minimum)

Typischer Pflichtumfang:

1. Gegenstand und Dauer der Verarbeitung
2. Art und Zweck der Verarbeitung
3. Art der personenbezogenen Daten
4. Kategorien betroffener Personen
5. Pflichten und Rechte des Verantwortlichen
6. Pflichten des Auftragsverarbeiters
7. Technische und organisatorische Massnahmen (TOMs)
8. Regelung zu Unterauftragsverarbeitern (Subprozessoren)
9. Unterstuetzung bei Betroffenenrechten / Incident / DPIA
10. Loeschung / Rueckgabe nach Vertragsende
11. Nachweis- und Auditregelungen
12. Drittlandtransfermechanismen (falls relevant)

## 5. Broadify-spezifische Punkte, die im AVV adressiert werden sollten

Diese Punkte sind bei Broadify besonders wichtig:

- Remote-Relay-Architektur (WebApp -> Relay -> Bridge)
- potenziell personenbezogene Inhaltsdaten in Graphics-Payloads
- Sicherheitsmassnahmen im Command-Pfad (Signaturen, TTL, Replay, Org-Bindung)
- lokale Verarbeitung beim Kunden (Bridge auf Kundengeraet)
- Rollenmodell (Kunde vs. Broadify) fuer lokale Geraete-/Netzwerkdaten
- Logging/Redaction-Strategie
- Incident-/Breach-Meldung und Reaktionszeiten

## 6. TOM-Checkliste (Anhang zum AVV)

### 6.1 Zugriffskontrolle

- Rollen-/Rechtekonzept
- Need-to-know fuer interne Zugriffe
- MFA (wenn verfuegbar)
- Trennung von Umgebungen

### 6.2 Weitergabe-/Transportkontrolle

- TLS fuer externe Kommunikationspfade
- abgesicherter Relay-Command-Pfad
- Signatur- und Replay-Schutz
- Payload-Limits / Timeouts

### 6.3 Eingabe-/Aenderungskontrolle

- Audit-/Event-Nachvollziehbarkeit (soweit implementiert/vertraglich zugesagt)
- Request-IDs / Command-IDs
- Rollenkonzept fuer mutierende Kommandos

### 6.4 Verfuegbarkeit / Belastbarkeit

- Backup-/Restore-Prozesse (Backend-Komponenten)
- Incident-Response-Prozess
- Monitoring / Fehlertracking

### 6.5 Trennungsgebot / Zweckbindung

- Org-/Bridge-Bindung
- Mandantentrennung in Backend/DB (z. B. RLS)
- vertragliche Weisungsbindung

## 7. Subprozessorenliste (separate Anlage empfohlen)

Eine aktuelle Subprozessorenliste sollte separat gepflegt und versioniert werden. Mindestangaben:

- Anbietername
- Dienst / Zweck
- Datenkategorien
- Standort / Drittlandbezug
- Rechtsgrundlage / Transfermechanismus (z. B. SCC)
- Website / DPA-Link

## 8. Zusaetzliche Dokumente, die parallel bereitliegen sollten

- EULA / Software-Nutzungsbedingungen
- Datenschutzerklaerung (App + Relay)
- Security-Transparenzdokument
- TOM-Anhang
- Subprozessorenliste
- Incident-/Breach-Prozess
- Retention-/Loeschkonzept

## 9. Ergebnisdokumentation (intern)

Empfohlene interne Entscheidungsvorlage:

- Kunde: `[CUSTOMER_NAME]`
- Use Case: `[USE_CASE]`
- Rolle Broadify: `[Controller / Processor / Mixed]`
- AVV erforderlich: `[Yes/No]`
- Begruendung: `[TEXT]`
- Freigegeben von (Legal/Privacy): `[NAME]`
- Datum: `[DATE]`

