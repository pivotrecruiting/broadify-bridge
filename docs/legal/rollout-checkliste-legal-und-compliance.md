# Rollout-Checkliste - Legal & Compliance fuer Broadify Bridge Desktop App

Stand: 25. Februar 2026 (Entwurf)

Hinweis: Operative Checkliste, keine Rechtsberatung.

## 1. Dokumente finalisieren

- [ ] EULA / Software-Nutzungsbedingungen (Desktop) final juristisch geprueft
- [ ] Datenschutzhinweise fuer Desktop-App + Bridge + Relay finalisiert
- [ ] Security-/Remote-Control-Transparenzseite veroeffentlicht
- [ ] Technischer Anhang (Verbindungsmechanismen/Systemzugriffe/lokale Speicherung) veroeffentlicht oder intern versioniert freigegeben
- [ ] AVV/DPA (falls B2B erforderlich) inkl. TOMs/Subprozessoren vorbereitet
- [ ] Subprozessorenliste mit Standorten/Transfermechanismen veroeffentlicht

## 2. Produkttexte / Zustimmungsprozesse anpassen

- [ ] Download-Modal verlinkt auf Desktop-EULA + App/Relay-Datenschutz
- [ ] Checkbox-Text im Download-Modal aktualisiert
- [ ] Desktop-Onboarding-Dialog verweist auf neue Dokumente
- [ ] Zustimmung speichert Dokumentversion + Zeitstempel + Nutzerbezug (serverseitig und/oder lokal)
- [ ] Re-Consent-Mechanik fuer wesentliche Aenderungen definiert

## 3. Datenschutz- und Security-Betrieb

- [ ] Retention-Policy final mit tatsaechlichen Systemen abgeglichen
- [ ] DSAR-Prozess (Auskunft/Loeschung) fuer App/Relay-Daten dokumentiert
- [ ] Incident-/Breach-Prozess mit 72h-Runbook dokumentiert
- [ ] Sentry/Monitoring PII-Scrubbing geprueft und dokumentiert
- [ ] Logging-Policy (keine sensiblen Payloads) operationalisiert

## 4. Vertrags-/B2B-Themen

- [ ] B2B/B2C-Zielgruppe pro Angebot klar dokumentiert
- [ ] AVV-Entscheidung pro Kundensegment dokumentiert
- [ ] TOM-Anhang abgestimmt (Security Lead + Legal)
- [ ] SCC/TIA fuer Drittlandtransfer (falls noetig) dokumentiert
- [ ] Support- und Security-Kontakte vertraglich/oeffentlich benannt

## 5. Interne Governance

- [ ] Owner fuer EULA (Legal), Datenschutz (Privacy), Security-Transparenz (Security Lead) benannt
- [ ] Versionierung und Review-Zyklus festgelegt (z. B. quartalsweise oder bei Architektur-Aenderung)
- [ ] Trigger fuer Pflicht-Review definiert (neue Remote-Funktion, neuer Subprozessor, neue Datentypen)
